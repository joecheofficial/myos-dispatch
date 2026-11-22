"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { fastpathGuidance, formatDataSourceList } = require("../src/workspace-context");

test("a data fast path hands the session its lookup order, bounded", () => {
  const guidance = fastpathGuidance({
    score: 30,
    fastpath: {
      intent: "project graph lookup",
      data_path: "~/brain/topics",
      lookup_order: ["~/brain/topics", "~/brain/graph.json", "", 7, ...Array.from({ length: 10 }, (_, i) => `extra-${i}`)],
    },
  });
  assert.equal(guidance.targetType, "data");
  assert.deepEqual(guidance.lookupOrder.slice(0, 2), ["~/brain/topics", "~/brain/graph.json"]);
  assert.equal(guidance.lookupOrder.length, 8);
  assert.deepEqual(fastpathGuidance({ fastpath: { intent: "x", recipe_path: "r.json" } }).lookupOrder, []);
});

test("data sources are named with their location for any request type", () => {
  const config = { version: 1, dataSources: [
    { id: "netlify-projects", mode: "pointer", path: "/install/brain/topics" },
    { id: "no-path", mode: "pointer" },
  ] };
  const line = formatDataSourceList(["netlify-projects", "no-path", "unknown"], { config });
  assert.equal(line, "`netlify-projects` (/install/brain/topics), `no-path`, `unknown`");
  const many = formatDataSourceList(Array.from({ length: 8 }, (_, i) => `s${i}`), { config });
  assert.match(many, /and 2 more$/);
  assert.equal(formatDataSourceList([], { config }), "");
});

test("the hook renders the lookup order line", () => {
  const hook = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "bin", "myos-dispatch-hook"), "utf8");
  assert.match(hook, /Fast path lookup order: \$\{fastpath\.lookupOrder\.join\(" -> "\)\}/);
  assert.match(hook, /Data sources: \$\{formatDataSourceList\(route\.dataSources\)\}/);
});

test("the default hook route tells an exploratory question where the data lives", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-guidance-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const topics = path.join(home, "brain", "topics");
  fs.mkdirSync(topics, { recursive: true });
  fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
  const config = path.join(home, "data-sources.json");
  fs.writeFileSync(config, JSON.stringify({ version: 1, dataSources: [{ id: "hosting-graph", label: "Hosting graph", mode: "pointer", path: topics, matchTerms: ["netlify"], readOnly: true }] }));
  const env = { ...process.env, HOME: home, MYOS_HOME_ROOT: home, MYOS_DATA_SOURCES_CONFIG: config, MYOS_JEV_ENABLED: "0" };
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "myos-dispatch-hook"), "--surface=claude"], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Which of my projects are hosted on Netlify?", session_id: "data-guidance-test", cwd: home }),
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Intent\/action: exploratory|"action":"read"/);
  // Either route format names the source with its location.
  const lean = context.match(/^\[MyOS Dispatch route\]\n(\{.*\})$/m);
  if (lean) assert.deepEqual(JSON.parse(lean[1]).sourcePaths, { "hosting-graph": topics });
  else assert.ok(context.includes(`Data sources: \`hosting-graph\` (${topics})`), context.slice(0, 1500));
});

test("a skill's instruction words never route an ordinary model question to it", () => {
  const { scoreCapabilityMatch } = require("../src/capability-router");
  const description = 'Use only when the user says "run the full pipeline, super thorough". Runs one model to draft and another model to critique.';
  const gauntlet = { id: "skill:dual-model-gauntlet", type: "skill", description, aliases: ["dual-model-gauntlet"], use_when: ["run the full pipeline, super thorough"] };
  // Instruction words alone are no evidence at all.
  assert.equal(scoreCapabilityMatch(gauntlet, "only use the user list when it says so").evidenceScore, 0);
  // The reported prompt stays under the routing bar (18).
  const stray = scoreCapabilityMatch(gauntlet, "Use Sonnet only for this one, which model is best for summaries?");
  assert.ok(stray.score < 18, JSON.stringify(stray));
  const meant = scoreCapabilityMatch(gauntlet, "run the full pipeline, super thorough on this draft");
  assert.ok(meant.evidenceScore >= 10 && meant.score >= 18, JSON.stringify(meant));
});
