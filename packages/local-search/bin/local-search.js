#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const api = require("..");
const { formatEvidence } = require("../evidence-format");
const { formatContext } = require("../context-format");
const { writeReceipt } = require("../context-receipt");

const USER_CANCELLED = Symbol("userCancelled");
const CONTEXT_DEFAULT_BYTES = 4096;
const SAFE_ERROR_STATUSES = new Set([
  "INVALID_ARGUMENT", "INVALID_REQUEST", "RECEIPT_WRITE_FAILED",
  "UNSAFE_RECEIPT_DIRECTORY", "UNSAFE_RECEIPT_OUTPUT",
]);

function usage(message) {
  if (message) throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
  return "local-search <configure|status|index|search|read|watch> --config /absolute/path [--request /absolute/path | validated options] [--format json|evidence|context for search/read]";
}

function parse(argv) {
  const operation = argv.shift();
  if (!new Set(["configure", "status", "index", "search", "read", "watch"]).has(operation)) usage("unknown operation");
  const values = {};
  const allowed = new Set(["--config", "--request", "--query", "--mode", "--roots", "--max-results", "--max-bytes", "--max-tokens", "--source-id", "--format", "--context-bytes", "--receipt-dir"]);
  while (argv.length) {
    const flag = argv.shift();
    if (!allowed.has(flag) || argv.length === 0) usage(`unknown or incomplete argument: ${flag}`);
    if (Object.hasOwn(values, flag)) usage(`duplicate argument: ${flag}`);
    values[flag] = argv.shift();
  }
  if (values["--format"] !== undefined && !new Set(["json", "evidence", "context"]).has(values["--format"])) usage("format must be json or evidence (or context)");
  if (values["--format"] !== undefined && !new Set(["search", "read"]).has(operation)) usage("format is only supported for search or read");
  if (values["--format"] === "context") {
    if (!values["--receipt-dir"] || !path.isAbsolute(values["--receipt-dir"])) usage("context format requires an absolute --receipt-dir");
    const bytes = values["--context-bytes"] === undefined ? 4096 : Number(values["--context-bytes"]);
    if (!Number.isSafeInteger(bytes) || bytes < 512 || bytes > 16384) usage("--context-bytes must be an integer from 512 to 16384");
  } else if (values["--context-bytes"] !== undefined || values["--receipt-dir"] !== undefined) usage("context options require --format context");
  if (!values["--config"] || !path.isAbsolute(values["--config"])) usage("--config must be absolute");
  if (values["--request"] && !path.isAbsolute(values["--request"])) usage("--request must be absolute");
  return { operation, values };
}

function readRequest(filePath, dependencies = {}) {
  if (!filePath) return null;
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) usage("request path must be absolute");

  const lstatSync = dependencies.lstatSync || fs.lstatSync;
  const openSync = dependencies.openSync || fs.openSync;
  const fstatSync = dependencies.fstatSync || fs.fstatSync;
  const readSync = dependencies.readSync || fs.readSync;
  const closeSync = dependencies.closeSync || fs.closeSync;
  const getuid = dependencies.getuid || (typeof process.getuid === "function" ? () => process.getuid() : null);

  const parentDir = path.dirname(filePath);
  let parentStat;
  try {
    parentStat = lstatSync(parentDir);
  } catch {
    usage("request parent directory is not accessible");
  }
  if (parentStat.isSymbolicLink()) usage("request parent directory must not be a symlink");
  if (!parentStat.isDirectory()) usage("request parent directory must be a directory");
  const currentUid = getuid ? getuid() : null;
  if (currentUid !== null && parentStat.uid !== currentUid) usage("request parent directory must be owned by the current user");
  if ((parentStat.mode & 0o022) !== 0) usage("request parent directory must not be group or other writable");

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = openSync(filePath, flags);
  } catch {
    usage("request path must be a regular non-symlink file");
  }

  try {
    let stat;
    try {
      stat = fstatSync(fd);
    } catch {
      usage("request file stat failed");
    }
    if (!stat.isFile()) usage("request path must be a regular non-symlink file");
    if (currentUid !== null && stat.uid !== currentUid) usage("request path must be owned by the current user");
    if ((stat.mode & 0o022) !== 0) usage("request path must not be group or other writable");
    const MAX_REQUEST_BYTES = 1024 * 1024; // 1 MiB
    if (stat.size > MAX_REQUEST_BYTES) usage("request file exceeds 1 MiB size limit");

    const buffer = Buffer.alloc(stat.size);
    let bytesRead = 0;
    while (bytesRead < stat.size) {
      const chunk = readSync(fd, buffer, bytesRead, stat.size - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead !== stat.size) usage("request file could not be read completely");

    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      usage("request file contains invalid JSON");
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function number(value, name) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) usage(`${name} must be numeric`);
  return parsed;
}

async function withCancellation(run) {
  const controller = new AbortController();
  let cancelled = false;
  const abort = () => { cancelled = true; controller.abort(); };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, abort);
  try {
    const result = await run(controller.signal);
    if (cancelled && result && typeof result === "object") {
      Object.defineProperty(result, USER_CANCELLED, { value: true });
    }
    return result;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, abort);
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { operation, values } = parse([...argv]);
  const requestFile = readRequest(values["--request"], dependencies);
  if (operation === "configure") return api.configure({ configPath: values["--config"], config: requestFile });
  const configPath = values["--config"];
  if (operation === "status") return api.status(configPath);
  if (operation === "index") return withCancellation((signal) => api.index(configPath, { signal }));
  const request = requestFile || {
    query: values["--query"], mode: values["--mode"], roots: values["--roots"] ? values["--roots"].split(",") : undefined,
    maxResults: number(values["--max-results"], "max-results"), maxBytes: number(values["--max-bytes"], "max-bytes"), maxTokens: number(values["--max-tokens"], "max-tokens"), sourceId: values["--source-id"],
  };
  if (operation === "search") return withCancellation((signal) => api.search(configPath, request, { signal }));
  if (operation === "read") return api.read(configPath, request);
  return withCancellation(async (signal) => {
    const watcher = await api.watch(configPath, { signal });
    if (!watcher.ok) return watcher;
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    await watcher.stop();
    return { ok: true, status: "stopped", taskClass: "default_automation", complianceLane: "unattended_local" };
  });
}

function contextIntent(argv) {
  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] === "--format" && argv[index + 1] === "context") return true;
  }
  return false;
}

function requestedContextBytes(argv) {
  const values = [];
  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] === "--context-bytes") values.push(argv[index + 1]);
  }
  if (values.length !== 1) return CONTEXT_DEFAULT_BYTES;
  const parsed = Number(values[0]);
  return Number.isSafeInteger(parsed) && parsed >= 512 && parsed <= 16384
    ? parsed
    : CONTEXT_DEFAULT_BYTES;
}

function sanitizedFailure(error, contextBytes) {
  const status = SAFE_ERROR_STATUSES.has(error?.code) ? error.code : "error";
  const failure = { ok: false, status };
  if (error?.cleanupStatus === "removed" || error?.cleanupStatus === "notCreated"
    || error?.cleanupStatus === "cleanupFailed" || error?.cleanupStatus === "ownershipChanged"
    || error?.cleanupStatus === "ownershipUnknown") {
    failure.cleanupStatus = error.cleanupStatus;
  }
  const output = `${JSON.stringify(failure)}\n`;
  if (contextBytes === undefined || Buffer.byteLength(output) <= contextBytes) return output;
  return "{\"ok\":false}\n";
}

async function runCli(argv, dependencies = {}) {
  const isContext = contextIntent(argv);
  const errorBudget = isContext ? requestedContextBytes(argv) : undefined;
  const writeOutput = dependencies.writeOutput || ((output) => process.stdout.write(output));
  try {
    const parsed = parse([...argv]);
    const outputFormat = parsed.values["--format"] || "json";
    const result = await main(argv, dependencies);
    let output;
    if (outputFormat === "evidence") output = formatEvidence(result, { isTTY: process.stdout.isTTY === true });
    else if (outputFormat === "context") {
      const contextBytes = Number(parsed.values["--context-bytes"] || CONTEXT_DEFAULT_BYTES);
      const receipt = (dependencies.writeReceipt || writeReceipt)(result, parsed.values["--receipt-dir"]);
      output = formatContext(result, { contextBytes, receipt, cancelled: result?.[USER_CANCELLED] === true });
    } else output = `${JSON.stringify(result)}\n`;
    writeOutput(output);
    if (result && result[USER_CANCELLED]) process.exitCode = 1;
  } catch (error) {
    writeOutput(isContext
      ? sanitizedFailure(error, errorBudget)
      : `${JSON.stringify({ ok: false, status: error.code || "error", error: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void runCli(process.argv.slice(2));
}

module.exports = { main, parse, readRequest, runCli };
