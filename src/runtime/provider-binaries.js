"use strict";
// Locates the Codex and Claude CLIs without relying on the caller's PATH.
// Hooks run with a minimal PATH (often /usr/bin:/bin:/usr/sbin:/sbin), and on
// macOS both CLIs commonly ship only inside app bundles (ChatGPT.app/Codex.app,
// the Claude desktop app) with no shim on PATH. A bare `codex`/`claude` spawn
// then fails and discovery reports both providers as unavailable.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENV_OVERRIDES = Object.freeze({
  codex: ["MYOS_CODEX_BIN", "MYOS_CODEX_COMMAND", "CODEX_COMMAND"],
  claude: ["MYOS_CLAUDE_BIN", "MYOS_CLAUDE_COMMAND"],
});

function isExecutableFile(file, fsImpl = fs) {
  try {
    if (!fsImpl.statSync(file).isFile()) return false;
    fsImpl.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function compareVersionsDesc(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff) return diff;
  }
  return String(b).localeCompare(String(a));
}

function listDir(dir, fsImpl) {
  try { return fsImpl.readdirSync(dir); } catch { return []; }
}

// Claude desktop keeps its embedded Claude Code under
// ~/Library/Application Support/Claude/claude-code/<version>/[<build>/]claude.app/Contents/MacOS/claude.
function claudeDesktopCandidates(home, fsImpl) {
  const root = path.join(home, "Library", "Application Support", "Claude", "claude-code");
  const found = [];
  for (const version of listDir(root, fsImpl).sort(compareVersionsDesc)) {
    const direct = path.join(root, version, "claude.app", "Contents", "MacOS", "claude");
    found.push(direct);
    for (const build of listDir(path.join(root, version), fsImpl)) {
      if (build === "claude.app") continue;
      found.push(path.join(root, version, build, "claude.app", "Contents", "MacOS", "claude"));
    }
  }
  return found;
}

function pathCandidates(name, env, platform = process.platform) {
  const exe = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  return String(env.PATH || "").split(path.delimiter).filter(dir => dir && path.isAbsolute(dir))
    .flatMap(dir => exe.map(file => path.join(dir, file)));
}

const SYSTEM_DIRS = Object.freeze(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]);

function candidatePaths(name, { env = process.env, platform = process.platform, fsImpl = fs, systemDirs = SYSTEM_DIRS, appRoots } = {}) {
  const home = env.HOME || os.homedir();
  const exe = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  const pathDirs = String(env.PATH || "").split(path.delimiter).filter(dir => dir && path.isAbsolute(dir));
  const commonDirs = [
    path.join(home, ".local", "bin"),
    ...(name === "codex" ? [path.join(home, ".codex", "packages", "standalone", "current", "bin")] : []),
    ...(name === "claude" ? [path.join(home, ".claude", "local")] : []),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    ...systemDirs,
  ];
  const list = [];
  for (const dir of [...pathDirs, ...commonDirs]) for (const file of exe) list.push(path.join(dir, file));
  if (platform === "darwin") {
    const roots = appRoots || ["/Applications", path.join(home, "Applications")];
    if (name === "codex") {
      for (const root of roots) for (const app of ["Codex.app", "ChatGPT.app"]) {
        list.push(path.join(root, app, "Contents", "Resources", "codex-cli", "bin", "codex"));
        list.push(path.join(root, app, "Contents", "Resources", "codex"));
      }
    } else if (name === "claude") {
      list.push(...claudeDesktopCandidates(home, fsImpl));
    }
  }
  return [...new Set(list)];
}

/**
 * Resolve an absolute path for a provider CLI ("codex" or "claude").
 * Order: explicit env override, PATH, common install dirs, macOS app bundles.
 * Returns null when nothing executable is found.
 */
function resolveProviderBinary(name, options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  for (const key of ENV_OVERRIDES[name] || []) {
    const value = String(env[key] || "").trim();
    if (value && path.isAbsolute(value) && isExecutableFile(value, fsImpl)) return value;
  }
  // MYOS_PROVIDER_SEARCH=path limits the search to explicit overrides and PATH
  // (hermetic tests, or operators who want PATH-only behavior).
  const pathOnly = String(env.MYOS_PROVIDER_SEARCH || "").trim().toLowerCase() === "path";
  const searchOptions = pathOnly ? { ...options, env, fsImpl, systemDirs: [], appRoots: [], home: null } : { ...options, env, fsImpl };
  for (const candidate of pathOnly ? pathCandidates(name, env, options.platform) : candidatePaths(name, searchOptions)) {
    if (isExecutableFile(candidate, fsImpl)) return candidate;
  }
  return null;
}

// Hooks run with a minimal PATH; give metadata children the binary's own
// directory plus the system directories that shell wrappers rely on.
function childPath(binary, env) {
  // Keep the caller's PATH order (toolchains such as pyenv or nvm stay first);
  // only append the binary's directory and system directories when missing.
  const parts = [...String(env.PATH || "").split(path.delimiter),
    binary && path.isAbsolute(binary) ? path.dirname(binary) : null,
    ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])].filter(Boolean);
  return [...new Set(parts)].join(path.delimiter);
}

module.exports = { resolveProviderBinary, candidatePaths, childPath };
