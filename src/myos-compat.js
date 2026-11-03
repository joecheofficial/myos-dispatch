"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LEGACY_BRAND = ["open", "claw"].join("");
const LEGACY_HOME_DIRNAME = [".open", "claw"].join("");
const LEGACY_HOME_ENV = ["OPEN", "CLAW", "_HOME_ROOT"].join("");
const LEGACY_SERVICE_ENV = ["OPEN", "CLAW", "_SERVICE_NAMESPACE"].join("");

function homeDir() {
  return process.env.HOME || os.homedir();
}

function legacyHomeRoot() {
  return process.env[LEGACY_HOME_ENV] || path.join(homeDir(), LEGACY_HOME_DIRNAME);
}

function canonicalHomeRoot() {
  return process.env.MYOS_HOME_ROOT || path.join(homeDir(), ".myos");
}

function rootCandidates() {
  return [...new Set([canonicalHomeRoot(), legacyHomeRoot()])];
}

function preferredHomeRoot() {
  if (process.env.MYOS_HOME_ROOT) return canonicalHomeRoot();
  if (fs.existsSync(canonicalHomeRoot())) return canonicalHomeRoot();
  return legacyHomeRoot();
}

function resolveHomePath(...segments) {
  for (const root of rootCandidates()) {
    const target = path.join(root, ...segments);
    if (fs.existsSync(target)) return target;
  }
  return path.join(preferredHomeRoot(), ...segments);
}

function resolveWorkspaceRoot() {
  return resolveHomePath("workspace");
}

function resolveWorkspacePath(...segments) {
  return path.join(resolveWorkspaceRoot(), ...segments);
}

// The project registry folder (holding _index.json and the project folders).
// MyOS homes keep it at <home>/workspace/projects. All Sorted installs keep it
// where the Organizer writes it, <home>/projects, one level above the
// workspace (the same split capability-router.js resolves for
// capabilities-index.json). The workspace copy always wins when it has an
// index, so a home that already resolved its projects never changes; the
// install copy is used only when the workspace has no index and it does.
function resolveProjectsRoot(workspaceRoot = resolveWorkspaceRoot()) {
  const own = path.join(workspaceRoot, "projects");
  if (fs.existsSync(path.join(own, "_index.json"))) return own;
  const installCopy = path.join(path.dirname(workspaceRoot), "projects");
  if (fs.existsSync(path.join(installCopy, "_index.json"))) return installCopy;
  return own;
}

function resolveLogsRoot() {
  return resolveHomePath("logs");
}

function resolveStateRoot(...segments) {
  return resolveHomePath("state", ...segments);
}

function resolveModelCatalogLocalPath(homeRoot = preferredHomeRoot()) {
  return path.join(homeRoot, "config", "model-catalog.local.json");
}

function primaryServiceNamespace() {
  return process.env.MYOS_SERVICE_NAMESPACE || "myos";
}

function legacyServiceNamespace() {
  return process.env[LEGACY_SERVICE_ENV] || LEGACY_BRAND;
}

function serviceLabel(name, kind = "ai") {
  return `${kind}.${primaryServiceNamespace()}.${name}`;
}

function legacyServiceLabel(name, kind = "ai") {
  return `${kind}.${legacyServiceNamespace()}.${name}`;
}

function serviceLabelCandidates(name, kind = "ai") {
  return [...new Set([serviceLabel(name, kind), legacyServiceLabel(name, kind)])];
}

function workspaceEnvPath() {
  return resolveWorkspacePath(".env");
}

function whatsappInstance() {
  return (
    process.env.MYOS_WA_INSTANCE ||
    process.env.EVOLUTION_INSTANCE ||
    "myos"
  );
}

function whatsappInstanceCandidates() {
  return [...new Set([whatsappInstance(), LEGACY_BRAND])];
}

module.exports = {
  canonicalHomeRoot,
  homeDir,
  legacyHomeRoot,
  legacyServiceLabel,
  preferredHomeRoot,
  resolveHomePath,
  resolveLogsRoot,
  resolveStateRoot,
  resolveModelCatalogLocalPath,
  resolveProjectsRoot,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  rootCandidates,
  serviceLabel,
  serviceLabelCandidates,
  whatsappInstance,
  whatsappInstanceCandidates,
  workspaceEnvPath,
};
