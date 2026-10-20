"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { CANONICAL_TASK_CLASSES, ROUTING_POLICY } = require("../src/myos-routing");
const { loadCatalog, resolveProfileModel } = require("../src/model-catalog");
const {
  preferredHomeRoot,
  resolveModelCatalogLocalPath,
} = require("../src/myos-compat");

const PROVIDER_ORDER = ["openai", "google", "anthropic", "openrouter"];

const PROVIDER_ENV_KEYS = {
  openai: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ],
  anthropic: ["ANTHROPIC_API_KEY"],
};

const PROVIDER_CLI = {
  openai: "codex",
  anthropic: "claude",
  google: "gemini",
};

const TASK_DESCRIPTIONS = {
  cheap_routing: "Fast, low-cost text replies and simple transformations.",
  default_automation: "Routine assistant work and general task handling.",
  heavy_synthesis: "Longer reasoning, writing, and synthesis tasks.",
  task_class_is_elite: "Highest-priority synthesis when quality matters most.",
  planning: "Step-by-step planning, analysis, and decision support.",
  audio_transcription: "Speech to text conversion.",
  audio_diarization: "Identify who is speaking in an audio clip.",
  realtime_audio: "Live voice work that needs low latency.",
};

function defaultProbeEnv(env = process.env) {
  return env;
}

const { resolveProviderBinary, childPath } = require("../src/runtime/provider-binaries");
const OAUTH_TEXT_CLASSES = ["cheap_routing", "default_automation", "heavy_synthesis", "task_class_is_elite", "planning"];
const OAUTH_PROVIDER = { openai: "codex", anthropic: "claude" };

function commandExists(command) {
  const result = process.platform === "win32"
    ? spawnSync("cmd", ["/d", "/s", "/c", `where ${command} >nul 2>nul`], {
        timeout: 3000,
        stdio: "ignore",
      })
    : spawnSync("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], {
        timeout: 3000,
        stdio: "ignore",
      });
  return !result.error && result.status === 0;
}

function runOllamaList() {
  const result = spawnSync("ollama", ["list"], {
    timeout: 3000,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];
  const output = String(result.stdout || "").trim();
  if (!output) return [];
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = lines.slice(1);
  const models = [];
  for (const row of rows) {
    const model = row.split(/\s+/)[0];
    if (model && model.toLowerCase() !== "name") models.push(model);
  }
  return [...new Set(models)];
}

// Only normal status commands; never login, refresh, or inspect credential files.
function probeLoginStatus(command, run = spawnSync, env = process.env) {
  const args = command === "codex" ? ["login", "status"]
    : command === "claude" ? ["auth", "status", "--json"] : null;
  if (!args) return "unknown";
  // Codex and Claude often live outside PATH (macOS app bundles, ~/.local/bin).
  const binary = run === spawnSync ? resolveProviderBinary(command, { env }) : null;
  const result = run(binary || command, args, { env: binary ? { ...env, PATH: childPath(binary, env) } : env,
    encoding: "utf8", timeout: 8000, maxBuffer: 65536 });
  if (result.error || result.signal) return "unknown";
  if (command === "claude") {
    try {
      const status = JSON.parse(result.stdout || "");
      if (status.loggedIn === false) return "unauthenticated";
      if (result.status === 0 && status.loggedIn === true && status.authMethod === "claude.ai") return "oauth";
      if (result.status === 0 && status.loggedIn === true && status.authMethod === "api_key") return "api";
    } catch { /* Unsupported output stays unknown. */ }
    return "unknown";
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 && /Logged in using ChatGPT/i.test(output)) return "oauth";
  if (result.status === 0 && /Logged in using an? API key/i.test(output)) return "api";
  if (/Not logged in/i.test(output)) return "unauthenticated";
  return "unknown";
}

function defaultProbes(env = process.env) {
  return {
    loginStatus(command) { return probeLoginStatus(command, spawnSync, env); },
    cliAvailable(command) {
      if (command === "codex" || command === "claude") return Boolean(resolveProviderBinary(command, { env }));
      return commandExists(command);
    },
    cliPath(command) {
      return command === "codex" || command === "claude" ? resolveProviderBinary(command, { env }) : null;
    },
    envHas(key) {
      return Boolean(String(defaultProbeEnv(env)[key] || "").trim());
    },
    ollamaModels() {
      if (!commandExists("ollama")) return null;
      return runOllamaList();
    },
    mlxWhisperAvailable() {
      return commandExists("mlx_whisper");
    },
    now() {
      return new Date();
    },
  };
}

function normalizeProviderAvailability(probes, env = process.env) {
  const availability = {};
  for (const provider of PROVIDER_ORDER) {
    const cli = PROVIDER_CLI[provider];
    const installed = cli ? Boolean(probes.cliAvailable(cli)) : false;
    const loginStatus = installed ? (probes.loginStatus?.(cli) || "unknown") : "not_installed";
    const oauth = loginStatus === "oauth";
    const apiKey = Boolean((PROVIDER_ENV_KEYS[provider] || []).some((key) => probes.envHas(key)));
    if (!installed && !apiKey) continue;
    const cliPath = installed && probes.cliPath ? probes.cliPath(cli) : null;
    availability[provider] = {
      oauthCli: installed ? cli : undefined,
      ...(cliPath ? { cliPath } : {}),
      installed,
      loginStatus,
      oauth,
      apiKey,
    };
  }
  return availability;
}

function normalizeLocalAvailability(probes) {
  const hasOllama = Boolean(probes.cliAvailable("ollama"));
  const models = hasOllama ? (probes.ollamaModels() || []) : [];
  return {
    ollama: {
      available: hasOllama,
      models,
    },
    mlxWhisper: {
      available: Boolean(probes.mlxWhisperAvailable()),
    },
  };
}

function resolveTargetCandidate(taskClass, lane, target, providers) {
  if (!target || target.type !== "llm") return null;
  const providerState = providers[target.provider];
  if (!providerState) return null;
  if (lane === "interactive_oauth" && !providerState.oauth) return null;
  if (lane === "unattended_api" && !providerState.apiKey) return null;
  if (lane === "unattended_local") return null;

  const catalog = loadCatalog(target.provider);
  if (target.model) {
    const resolvedModel = catalog.models.find(
      (entry) => entry.id === target.model || entry.model === target.model
    );
    if (!resolvedModel) return null;
    const resolvedProfile = target.profile
      ? catalog.routing_profiles.find((entry) => entry.id === target.profile)
      : null;
    if (target.profile && !resolvedProfile) return null;
    return {
      type: "llm",
      provider: target.provider,
      profile: target.profile || null,
      model: resolvedModel.id,
      authMode: lane === "interactive_oauth" ? "oauth" : "api",
      lane,
      source: "auto",
      taskClass,
    };
  }

  if (!target.profile) return null;
  try {
    const resolved = resolveProfileModel(catalog, target.profile);
    return {
      type: "llm",
      provider: target.provider,
      profile: resolved.profile.id,
      model: resolved.model.id,
      authMode: lane === "interactive_oauth" ? "oauth" : "api",
      lane,
      source: "auto",
      taskClass,
    };
  } catch {
    return null;
  }
}

function chooseAssignment(taskClass, providers, local) {
  const routes = ROUTING_POLICY.taskClasses[taskClass] || {};
  for (const preferredLane of ["interactive_oauth", "unattended_api", "unattended_local"]) {
    const route = routes[preferredLane];
    if (!route) continue;
    if (preferredLane === "unattended_local") {
      continue;
    }
    for (const target of route.llmTargets || []) {
      const candidate = resolveTargetCandidate(taskClass, preferredLane, target, providers);
      if (candidate) return candidate;
    }
  }

  if (local.ollama.available && ["cheap_routing", "default_automation", "heavy_synthesis", "task_class_is_elite", "planning"].includes(taskClass)) {
    const route = routes.unattended_local || {};
    for (const target of route.llmTargets || []) {
      const candidate = resolveTargetCandidate(taskClass, "unattended_local", target, providers);
      if (candidate) return candidate;
    }
  }

  return null;
}

function firstEnablementHint(taskClass) {
  if (OAUTH_TEXT_CLASSES.includes(taskClass)) {
    return "a Codex or Claude subscription sign-in (Codex: `codex login` or the ChatGPT/Codex app; Claude: `claude auth login --claudeai`; then `node bin/myos-oauth-doctor.js scan`), or an API key such as GEMINI_API_KEY or OPENAI_API_KEY";
  }
  const routes = ROUTING_POLICY.taskClasses[taskClass] || {};
  for (const lane of ["unattended_api", "interactive_oauth", "unattended_local"]) {
    const route = routes[lane];
    if (!route) continue;
    for (const target of route.llmTargets || []) {
      if (lane === "unattended_api") {
        const envKey = (PROVIDER_ENV_KEYS[target.provider] || [])[0];
        if (envKey) return `set ${envKey}`;
      }
      if (lane === "interactive_oauth") {
        const cli = PROVIDER_CLI[target.provider];
        if (cli) return `install ${cli} CLI`;
      }
      if (lane === "unattended_local") {
        return "install ollama";
      }
    }
  }
  return "enable a supported provider";
}

// The subscription path: models discovered from the signed-in Codex/Claude
// CLIs (the same registry the OAuth runtime routes on). Codex first, then Claude.
function chooseOauthAssignment(taskClass, providers, oauthState) {
  if (!oauthState || !OAUTH_TEXT_CLASSES.includes(taskClass)) return null;
  const { selectModels } = require("../src/runtime/oauth-registry");
  for (const provider of ["openai", "anthropic"]) {
    if (!providers[provider]?.oauth) continue;
    const [chosen] = selectModels(oauthState, { provider: OAUTH_PROVIDER[provider], taskClass });
    if (!chosen) continue;
    return { type: "llm", provider, profile: null, model: chosen.model, effort: chosen.effort,
      authMode: "oauth", lane: "interactive_oauth", source: "oauth-registry", taskClass,
      ...(chosen.firstCall ? { firstCall: true } : {}) };
  }
  return null;
}

function buildAssignments(providers, local, oauthState = null) {
  const assignments = {};
  for (const taskClass of CANONICAL_TASK_CLASSES) {
    const candidate = chooseOauthAssignment(taskClass, providers, oauthState) || chooseAssignment(taskClass, providers, local);
    if (candidate) {
      assignments[taskClass] = candidate;
      continue;
    }

    assignments[taskClass] = {
      unassigned: true,
      reason: `no provider for ${taskClass} detected`,
      enableWith: firstEnablementHint(taskClass),
    };
  }
  return assignments;
}

function buildModelCatalog({ homeRoot = preferredHomeRoot(), probes = defaultProbes(), now = probes.now?.bind(probes) || (() => new Date()), existing = null, oauthState = null } = {}) {
  const providers = normalizeProviderAvailability(probes);
  const local = normalizeLocalAvailability(probes);
  const assignments = buildAssignments(providers, local, oauthState);
  const overrides = existing && existing.overrides && typeof existing.overrides === "object" && !Array.isArray(existing.overrides)
    ? existing.overrides
    : {};

  return {
    ...existing,
    version: existing?.version || 1,
    generatedAt: existing?.generatedAt || now().toISOString(),
    providers: Object.fromEntries([...new Set([...Object.keys(existing?.providers || {}), ...Object.keys(providers)])].map(provider => [provider, {
      ...existing?.providers?.[provider],
      ...(providers[provider] || (PROVIDER_ORDER.includes(provider) ? { installed: false, loginStatus: "not_installed", oauth: false, apiKey: false } : {})),
    }])),
    local: { ...existing?.local, ...local, ollama: { ...existing?.local?.ollama, ...local.ollama }, mlxWhisper: { ...existing?.local?.mlxWhisper, ...local.mlxWhisper } },
    assignments: { ...assignments, ...existing?.assignments },
    overrides,
    homeRoot,
  };
}

function taskClassDescription(taskClass) {
  return TASK_DESCRIPTIONS[taskClass] || "General MyOS work.";
}

function formatAssignmentLine(taskClass, assignment) {
  if (assignment.unassigned) {
    return `Unassigned: ${assignment.reason}. Enable with ${assignment.enableWith}.`;
  }

  const laneLabel = assignment.lane === "interactive_oauth"
    ? "interactive_oauth"
    : assignment.lane === "unattended_api"
      ? "unattended_api"
      : "unattended_local";
  if (assignment.source === "oauth-registry") {
    const via = assignment.provider === "anthropic" ? "your Claude subscription (Claude CLI)" : "your ChatGPT/Codex subscription (Codex CLI)";
    return `Assigned: ${assignment.model}, through ${via}; no API key needed.${assignment.firstCall ? " Its first call unlocks it (or run `node bin/myos-oauth-doctor.js unlock`)." : ""}`;
  }
  return `Assigned: ${assignment.model}, available through ${laneLabel} because ${assignment.authMode === "oauth" ? "CLI OAuth login was verified when assigned" : "an API key is present"}.`;
}

function describeDetectedProvider(provider, state) {
  const parts = [];
  if (state.installed) parts.push(`${state.oauthCli} CLI installed${state.cliPath ? ` at ${state.cliPath}` : ""}; login: ${state.loginStatus}`);
  if (state.apiKey) parts.push("API key detected in your environment (not tested)");
  return `- ${provider}: ${parts.join(", plus an ")}`;
}

function renderDetectedModels(catalog) {
  const lines = [];
  const providerNames = Object.keys(catalog.providers || {});
  for (const provider of providerNames) {
    lines.push(describeDetectedProvider(provider, catalog.providers[provider]));
  }
  if (catalog.local?.ollama?.available) {
    const models = catalog.local.ollama.models || [];
    lines.push(`- local: ollama${models.length ? ` (${models.join(", ")})` : ""}`);
  }
  if (catalog.local?.mlxWhisper?.available) {
    lines.push("- local: mlx_whisper for on-device transcription");
  }
  if (!lines.length) {
    lines.push("- none yet: no provider CLIs, API keys, or local runtimes were detected");
  }
  return lines;
}

// Explain the subscription (OAuth) path, which needs no API key, and why it
// was or was not detected on this machine.
function renderSubscriptionPath(catalog) {
  const lines = ["Subscription path (no API key needed): Dispatch can run text task classes on your ChatGPT/Codex or Claude plan through their signed-in CLIs."];
  for (const [provider, cli, signIn] of [["openai", "codex", "`codex login` or sign in to the ChatGPT/Codex app"], ["anthropic", "claude", "`claude auth login --claudeai`"]]) {
    const state = catalog.providers?.[provider];
    if (!state?.installed) lines.push(`- ${cli}: CLI not found (searched PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin and the macOS app bundles). Install it or set MYOS_${cli.toUpperCase()}_BIN to its path.`);
    else if (!state.oauth) lines.push(`- ${cli}: found, but not signed in with a subscription (login: ${state.loginStatus}). Run ${signIn}.`);
    else lines.push(`- ${cli}: signed in with a subscription; used for the text task classes below.`);
  }
  lines.push("After signing in, run `node bin/myos-oauth-doctor.js scan`; `node bin/myos-oauth-doctor.js unlock` makes the first Claude call for each model.");
  return lines;
}

function renderReport(catalog) {
  const lines = [];
  lines.push("MyOS Dispatch is a routing layer for prompts and tasks.");
  lines.push("It reads each request, picks the right lane for the work, and keeps risky actions gated.");
  lines.push("Recipe, tool, and data work stay separated so each step uses the cheapest model that can do it well.");
  lines.push("When a stronger model is needed, Dispatch can route there without changing how you ask.");
  lines.push("If a request needs a safer path, it holds that work behind the right checks.");
  lines.push("The goal is to keep the system simple, fast, and predictable.");
  lines.push("");
  lines.push("These are the provider installations and credentials detected on this machine:");
  lines.push(...renderDetectedModels(catalog));
  lines.push("");
  lines.push(...renderSubscriptionPath(catalog));
  lines.push("");
  lines.push("I've made my best guess assigning the eight task classes to them:");

  for (const taskClass of CANONICAL_TASK_CLASSES) {
    const assignment = catalog.assignments[taskClass];
    lines.push(`${taskClass}: ${taskClassDescription(taskClass)}`);
    lines.push(formatAssignmentLine(taskClass, assignment));
  }

  lines.push("");
  lines.push("Here are the task classes. I've assigned them to these models. Let me know if you would like to change any of them.");
  lines.push(`Edit ${path.join(catalog.homeRoot, "config", "model-catalog.local.json")}, in the overrides section. The --report command previews detection without writing. Run without --report to save; existing assignments and overrides are preserved.`);
  return lines.join("\n");
}

function readExistingCatalog(targetPath) {
  if (!fs.existsSync(targetPath)) return null;
  const value = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Catalog must be a JSON object; no changes made");
  for (const key of ["assignments", "overrides", "providers", "local"]) {
    if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) {
      throw new Error(`Invalid catalog ${key}; no changes made`);
    }
  }
  return value;
}

function writeModelCatalog(targetPath, catalog) {
  readExistingCatalog(targetPath); // Refuse malformed input even for direct callers.
  const { homeRoot, ...output } = catalog;
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  const previous = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
  if (previous === serialized) return output;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (previous !== null) fs.copyFileSync(targetPath, `${targetPath}.bak-${Date.now()}-${require("node:crypto").randomUUID()}`, fs.constants.COPYFILE_EXCL);
  const tmp = `${targetPath}.tmp-${require("node:crypto").randomUUID()}`;
  try {
    fs.writeFileSync(tmp, serialized, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, targetPath);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return output;
}

function parseArgs(argv) {
  const args = {
    home: null,
    report: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--home") {
      args.home = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--home=")) {
      args.home = arg.slice("--home=".length);
      continue;
    }
    if (arg === "--report") {
      args.report = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

// Read-only subscription inventory: the saved registry merged with a fresh
// metadata scan (sign-in status and model lists only; never inference or login).
async function loadOauthState(probes, env = process.env) {
  const { registryPath } = require("../src/runtime/oauth-doctor");
  const file = registryPath(env);
  if (!file) return null;
  const signedIn = ["codex", "claude"].filter(cli => probes.cliAvailable(cli) && probes.loginStatus?.(cli) === "oauth");
  if (!signedIn.length) return null;
  const { readState } = require("../src/runtime/oauth-state");
  const { mergeDiscovery } = require("../src/runtime/oauth-registry");
  const { discoverInventory } = require("../src/runtime/oauth-discovery");
  try {
    const inventory = await discoverInventory({ env });
    const auth = new Map(inventory.providers.map(provider => [provider.provider, provider.auth]));
    const merged = mergeDiscovery(readState(file), inventory.models);
    return { ...merged, models: merged.models.map(model => ({ ...model, auth: auth.get(model.provider) || model.auth })) };
  } catch {
    return readState(file);
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const homeRoot = args.home || process.env.MYOS_HOME_ROOT || preferredHomeRoot();
  const targetPath = resolveModelCatalogLocalPath(homeRoot);
  const existing = readExistingCatalog(targetPath);
  const probes = defaultProbes();
  const catalog = buildModelCatalog({
    homeRoot,
    probes,
    existing,
    oauthState: await loadOauthState(probes),
  });
  const { homeRoot: ignoredHome, ...preview } = catalog;
  const written = args.report ? preview : writeModelCatalog(targetPath, catalog);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
    return written;
  }

  if (args.report) {
    process.stdout.write(`${renderReport({ ...written, homeRoot })}\n`);
    return written;
  }

  process.stdout.write(`Model catalog written to ${targetPath}\n`);
  return written;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  probeLoginStatus,
  TASK_DESCRIPTIONS,
  buildAssignments,
  buildModelCatalog,
  chooseOauthAssignment,
  loadOauthState,
  renderSubscriptionPath,
  defaultProbes,
  formatAssignmentLine,
  firstEnablementHint,
  main,
  normalizeLocalAvailability,
  normalizeProviderAvailability,
  parseArgs,
  readExistingCatalog,
  renderReport,
  resolveTargetCandidate,
  writeModelCatalog,
};
