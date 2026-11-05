"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readLlmDefaults, llmDefaultsContext } = require("../src/llm-defaults");

const NONE = { orchestratingLLM: "", workingLLM: "" };

function install(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-defaults-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (content !== undefined) {
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config", "llm-defaults.json"), content);
  }
  return root;
}
const home = (t, content) => ({ MYOS_HOME_ROOT: install(t, content) });

test("reads both defaults from the install's config file", (t) => {
  const env = home(t, JSON.stringify({ orchestratingLLM: "Claude", workingLLM: "codex" }));
  assert.deepEqual(readLlmDefaults(env), { orchestratingLLM: "claude", workingLLM: "codex" });
  assert.match(llmDefaultsContext(env), /orchestrating claude, working \(writes the code\) codex/);
});

test("a missing, broken or hostile file is no preference and never throws", (t) => {
  const contents = [undefined, "{not json", "[]", "null", JSON.stringify({ orchestratingLLM: { toString: 1 }, workingLLM: 7 }), " ".repeat(5000)];
  for (const content of contents) {
    const env = home(t, content);
    assert.deepEqual(readLlmDefaults(env), NONE);
    assert.equal(llmDefaultsContext(env), "");
  }
});

test("a path that is not a regular file is skipped without blocking", (t) => {
  const root = install(t);
  fs.mkdirSync(path.join(root, "config", "llm-defaults.json"), { recursive: true });
  assert.deepEqual(readLlmDefaults({ MYOS_HOME_ROOT: root }), NONE);
  const fifo = path.join(install(t), "config");
  fs.mkdirSync(fifo);
  const made = spawnSync("mkfifo", [path.join(fifo, "llm-defaults.json")]);
  if (made.status === 0) assert.deepEqual(readLlmDefaults({ MYOS_HOME_ROOT: path.dirname(fifo) }), NONE);
});

test("an unknown value is dropped without losing the valid one", (t) => {
  const env = home(t, JSON.stringify({ orchestratingLLM: "auto", workingLLM: "claude" }));
  assert.deepEqual(readLlmDefaults(env), { orchestratingLLM: "", workingLLM: "claude" });
  assert.match(llmDefaultsContext(env), /^\[Owner LLM defaults\] working \(writes the code\) claude\./);
});

test("an All Sorted checkout finds the file with no install root set", (t) => {
  const root = install(t, JSON.stringify({ orchestratingLLM: "codex", workingLLM: "codex" }));
  const checkout = path.join(root, ".external", "myos-dispatch");
  assert.equal(readLlmDefaults({}, checkout).orchestratingLLM, "codex");
});

test("an explicit install root stops the checkout lookup", (t) => {
  const root = install(t, JSON.stringify({ orchestratingLLM: "codex" }));
  const checkout = path.join(root, ".external", "myos-dispatch");
  assert.deepEqual(readLlmDefaults({ MYOS_HOME_ROOT: install(t) }, checkout), NONE);
});

test("Dispatch's own tests never read the owner's file from the checkout", (t) => {
  const root = install(t, JSON.stringify({ orchestratingLLM: "claude" }));
  const checkout = path.join(root, ".external", "myos-dispatch");
  assert.deepEqual(readLlmDefaults({ NODE_TEST_CONTEXT: "child-v8" }, checkout), NONE);
});

test("no install root and an ordinary checkout means no preference", () => {
  assert.deepEqual(readLlmDefaults({}, "/somewhere/myos-dispatch"), NONE);
});
