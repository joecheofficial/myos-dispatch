"use strict";
// Issue #8 item 5: OAuth discovery called bare `codex`/`claude` on PATH. On
// macOS both often ship only inside app bundles, and hooks run with a minimal
// PATH, so both providers showed as unavailable.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveProviderBinary, childPath } = require("../src/runtime/provider-binaries");
const { discoverInventory } = require("../src/runtime/oauth-discovery");

function tempHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-bin-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const isolated = { systemDirs: [] };

test("finds Codex inside a ChatGPT/Codex app bundle with a minimal PATH", { skip: process.platform === "win32" }, (t) => {
  const home = tempHome(t);
  const apps = path.join(home, "Applications");
  const bundled = script(path.join(apps, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"), "exit 0");
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  assert.equal(resolveProviderBinary("codex", { env, ...isolated, appRoots: [apps], platform: "darwin" }), bundled);
  // A Codex.app bundle is found the same way.
  fs.rmSync(path.join(apps, "ChatGPT.app"), { recursive: true });
  const codexApp = script(path.join(apps, "Codex.app", "Contents", "Resources", "codex-cli", "bin", "codex"), "exit 0");
  assert.equal(resolveProviderBinary("codex", { env, ...isolated, appRoots: [apps], platform: "darwin" }), codexApp);
});

test("finds Claude Code embedded in the Claude desktop app, newest version first", { skip: process.platform === "win32" }, (t) => {
  const home = tempHome(t);
  const root = path.join(home, "Library", "Application Support", "Claude", "claude-code");
  script(path.join(root, "2.1.9", "aaa", "claude.app", "Contents", "MacOS", "claude"), "exit 0");
  const newest = script(path.join(root, "2.1.10", "bbb", "claude.app", "Contents", "MacOS", "claude"), "exit 0");
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  assert.equal(resolveProviderBinary("claude", { env, ...isolated, appRoots: [], platform: "darwin" }), newest);
});

test("common install directories are searched even when PATH omits them", { skip: process.platform === "win32" }, (t) => {
  const home = tempHome(t);
  const local = script(path.join(home, ".local", "bin", "claude"), "exit 0");
  assert.equal(resolveProviderBinary("claude", { env: { HOME: home, PATH: "/usr/bin:/bin" }, ...isolated, appRoots: [] }), local);
  const override = script(path.join(home, "custom", "codex"), "exit 0");
  assert.equal(resolveProviderBinary("codex", { env: { HOME: home, PATH: "", MYOS_CODEX_BIN: override }, ...isolated, appRoots: [] }), override);
  assert.equal(resolveProviderBinary("codex", { env: { HOME: home, PATH: "" }, ...isolated, appRoots: [] }), null);
  // Non-executable files are not candidates.
  fs.writeFileSync(path.join(home, ".local", "bin", "codex"), "x", { mode: 0o644 });
  assert.equal(resolveProviderBinary("codex", { env: { HOME: home, PATH: "" }, ...isolated, appRoots: [] }), null);
});

test("child PATH keeps the binary directory and system directories for shell wrappers", () => {
  const value = childPath("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", { PATH: "" });
  assert.ok(value.split(path.delimiter).includes("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"));
  if (process.platform !== "win32") assert.ok(value.split(path.delimiter).includes("/usr/bin"));
});

test("discovery under a hook's minimal PATH reports both subscription providers", { skip: process.platform === "win32" }, async (t) => {
  const home = tempHome(t);
  const bin = path.join(home, ".local", "bin");
  const codex = script(path.join(bin, "codex"), 'if [ "$1" = login ]; then echo "Logged in using ChatGPT"; exit 0; fi; exit 1');
  const claude = script(path.join(bin, "claude"), [
    'if [ "$1" = auth ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi',
    'if [ "$1" = --help ]; then printf "  --model <model>  Model alias (e.g. sonnet or opus)\\n  --other\\n"; exit 0; fi',
    "exit 1",
  ].join("\n"));
  const result = await discoverInventory({
    env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", MYOS_OAUTH_LOCAL_PROVIDER_CONFIG: "/nonexistent/myos-test-provider.json" },
    binaryOptions: isolated, cwd: home, timeoutMs: 5000,
    codexInventory: [{ model: "gpt-6.1-sol", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
  });
  const codexProvider = result.providers.find((p) => p.provider === "codex");
  const claudeProvider = result.providers.find((p) => p.provider === "claude");
  assert.equal(codexProvider.auth, "subscription");
  assert.equal(codexProvider.binary, codex);
  assert.equal(claudeProvider.auth, "subscription");
  assert.equal(claudeProvider.binary, claude);
  assert.equal(result.models.find((m) => m.model === "gpt-6.1-sol")?.isDefault, true);
  // Claude aliases resolve to exact current IDs, not only alias records.
  const exact = result.models.filter((m) => m.provider === "claude" && m.source === "alias-catalog").map((m) => m.model).sort();
  assert.deepEqual(exact, ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.ok(result.models.filter((m) => m.provider === "claude").every((m) => m.auth === "subscription"));
});
