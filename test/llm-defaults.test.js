"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readLlmDefaults, llmDefaultsContext } = require("../src/llm-defaults");

function home(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-defaults-"));
  if (content !== undefined) {
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config", "llm-defaults.json"), content);
  }
  return { MYOS_HOME_ROOT: root };
}

test("reads both defaults from the install's config file", () => {
  const env = home(JSON.stringify({ primaryLLM: "Claude", codeLLM: "codex" }));
  assert.deepEqual(readLlmDefaults(env), { primaryLLM: "claude", codeLLM: "codex" });
  assert.match(llmDefaultsContext(env), /primary claude, code writing codex/);
});

test("a missing or broken file is no preference and never throws", () => {
  for (const env of [home(), home("{not json"), home("[]"), home("null")]) {
    assert.deepEqual(readLlmDefaults(env), { primaryLLM: "", codeLLM: "" });
    assert.equal(llmDefaultsContext(env), "");
  }
});

test("an unknown value is dropped without losing the valid one", () => {
  const env = home(JSON.stringify({ primaryLLM: "gpt-banana", codeLLM: "claude" }));
  assert.deepEqual(readLlmDefaults(env), { primaryLLM: "", codeLLM: "claude" });
  assert.match(llmDefaultsContext(env), /^\[Owner LLM defaults\] code writing claude\./);
});

test("no install root means no preference", () => {
  assert.deepEqual(readLlmDefaults({}), { primaryLLM: "", codeLLM: "" });
});
