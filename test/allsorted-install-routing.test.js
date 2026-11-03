// Routing defects found on a customer All Sorted install (Ed, 2026-11-03):
// the Organizer's project registry was never read, retired projects still
// matched, non-Latin aliases never matched, and a relationship question was
// routed to an unrelated skill as a write.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { resolveProjectsRoot } = require("../src/myos-compat");
const { compileBoundedPhrase } = require("../src/phrase-boundary");
const { matchProjects, inferActionType } = require("../src/workspace-context");
const { isRelationshipQuestion, selectExecutionLane, shortlistCapabilities } = require("../src/capability-router");

const REPO = path.resolve(__dirname, "..");

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const PROJECT_INDEX = {
  version: 1,
  projects: {
    kamarooms: { path: "kamarooms", name: "Kamarooms", aliases: ["kamarooms", "Камарумс"], status: "active" },
  },
};

// The Organizer's layout: <install>/projects/_index.json, no workspace/projects.
function installLayout() {
  const home = tempDir("allsorted-install-");
  fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(home, "projects", "kamarooms"), { recursive: true });
  writeJson(path.join(home, "projects", "_index.json"), PROJECT_INDEX);
  return home;
}

// The Studio layout: <home>/workspace/projects/_index.json.
function workspaceLayout() {
  const home = tempDir("myos-home-");
  fs.mkdirSync(path.join(home, "workspace", "projects", "kamarooms"), { recursive: true });
  writeJson(path.join(home, "workspace", "projects", "_index.json"), PROJECT_INDEX);
  return home;
}

// Route one prompt in a fresh process, as the hook does, against `home`.
function routeIn(home, prompt) {
  const script = `
    const wc = require(${JSON.stringify(path.join(REPO, "src", "workspace-context"))});
    const plan = wc.resolveDispatchPlan(${JSON.stringify(prompt)}, { hookSurface: "claude", hookEventName: "UserPromptSubmit" });
    process.stdout.write(JSON.stringify({ projectSlug: plan.projectSlug || null, searchScope: plan.searchScope || "" }));
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      MYOS_HOME_ROOT: home,
      OPENCLAW_HOME_ROOT: home,
      MYOS_DATA_SOURCES_CONFIG: "none",
      MYOS_JEV_ENABLED: "0",
      MYOS_BACKGROUND_AGENTS_ENABLED: "0",
      MYOS_AUTO_FANOUT: "0",
    },
  });
  return JSON.parse(out);
}

test("resolveProjectsRoot keeps the workspace registry when it has an index (Studio layout)", () => {
  const home = workspaceLayout();
  // An install-level folder without an index never wins.
  fs.mkdirSync(path.join(home, "projects"), { recursive: true });
  assert.equal(resolveProjectsRoot(path.join(home, "workspace")), path.join(home, "workspace", "projects"));
  // Even when both have an index, the workspace copy wins.
  writeJson(path.join(home, "projects", "_index.json"), { version: 1, projects: {} });
  assert.equal(resolveProjectsRoot(path.join(home, "workspace")), path.join(home, "workspace", "projects"));
});

test("resolveProjectsRoot falls back to the Organizer registry at <install>/projects", () => {
  const home = installLayout();
  assert.equal(resolveProjectsRoot(path.join(home, "workspace")), path.join(home, "projects"));
});

test("resolveProjectsRoot without any index keeps the workspace default", () => {
  const home = tempDir("empty-home-");
  assert.equal(resolveProjectsRoot(path.join(home, "workspace")), path.join(home, "workspace", "projects"));
});

test("an install whose projects live at <install>/projects routes to the project", () => {
  const home = installLayout();
  const plan = routeIn(home, "check kamarooms bookings");
  assert.equal(plan.projectSlug, "kamarooms");
  assert.equal(plan.searchScope, path.join(home, "projects", "kamarooms"));
});

test("the Studio layout still routes through <home>/workspace/projects", () => {
  const home = workspaceLayout();
  const plan = routeIn(home, "check kamarooms bookings");
  assert.equal(plan.projectSlug, "kamarooms");
  assert.equal(plan.searchScope, path.join(home, "workspace", "projects", "kamarooms"));
});

test("an install with the workspace/projects symlink workaround still routes", () => {
  const home = installLayout();
  fs.symlinkSync(path.join(home, "projects"), path.join(home, "workspace", "projects"));
  const plan = routeIn(home, "check kamarooms bookings");
  assert.equal(plan.projectSlug, "kamarooms");
  assert.equal(fs.realpathSync(plan.searchScope), path.join(home, "projects", "kamarooms"));
});

test("a Studio-style workspace symlink (home/workspace -> real workspace) still routes", () => {
  const real = workspaceLayout();
  const home = tempDir("myos-dispatch-home-");
  fs.symlinkSync(path.join(real, "workspace"), path.join(home, "workspace"));
  const plan = routeIn(home, "check kamarooms bookings");
  assert.equal(plan.projectSlug, "kamarooms");
  assert.equal(plan.searchScope, path.join(home, "workspace", "projects", "kamarooms"));
});

test("projects the Organizer marked missing, or retired/archived ones, never match", () => {
  const entry = (status) => ({
    slug: "kamarooms-hotel-sale",
    path: "kamarooms-hotel-sale",
    name: "Kamarooms hotel sale",
    aliases: ["kamarooms-hotel-sale", "confidential hotel sale", "hotel sale"],
    ...(status === undefined ? {} : { status }),
  });
  const query = "review the confidential hotel sale";
  for (const status of ["missing", "retired", "archive", "archived", "Missing"]) {
    assert.deepEqual(matchProjects(query, [entry(status)]), [], status);
  }
  for (const status of [undefined, "active", "needs-review", "dormant"]) {
    assert.equal(matchProjects(query, [entry(status)])[0]?.slug, "kamarooms-hotel-sale", String(status));
  }
});

test("Cyrillic and accented aliases match on whole words", () => {
  const projects = [
    { slug: "kamarooms", path: "kamarooms", name: "Kamarooms", aliases: ["Камарумс"], status: "active" },
    { slug: "cafe-ole", path: "cafe-ole", name: "Café Olé", aliases: ["café olé"], status: "active" },
  ];
  assert.equal(matchProjects("Проверь бронирования Камарумс сегодня", projects)[0]?.slug, "kamarooms");
  assert.equal(matchProjects("что с камарумс?", projects)[0]?.slug, "kamarooms");
  assert.deepEqual(matchProjects("Камарумсы и другие", projects), []);
  assert.equal(matchProjects("update the Café Olé menu", projects)[0]?.slug, "cafe-ole");
  assert.deepEqual(matchProjects("update the café olés menu", projects), []);
});

test("English project matching is unchanged", () => {
  const projects = [{ slug: "portal", path: "portal", name: "Portal", aliases: ["course portal"], status: "active" }];
  assert.equal(matchProjects("open the course portal.", projects)[0]?.slug, "portal");
  assert.equal(matchProjects("open the course portals-admin", projects)[0]?.slug, "portal");
  assert.deepEqual(matchProjects("check the transportal", projects), []);
});

test("the Unicode boundary is exactly \\b for ASCII text", () => {
  // Deterministic pseudo-random strings over a small alphabet with separators.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  const alphabet = "ab_1 -./'\"(é";
  const ascii = "ab_1 -./'(";
  const pick = (chars, n) => Array.from({ length: n }, () => chars[next() % chars.length]).join("");
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (let i = 0; i < 4000; i += 1) {
    const text = pick(ascii, 1 + (next() % 14));
    const needle = pick(ascii, 1 + (next() % 3)).trim();
    if (!needle) continue;
    const body = escape(needle).replace(/\s+/g, "\\s+");
    const legacy = new RegExp(`\\b${body}\\b`, "gi");
    const expected = [...text.matchAll(legacy)].map((m) => m.index);
    assert.deepEqual(compileBoundedPhrase(body, "i").indices(text), expected, `${JSON.stringify(needle)} in ${JSON.stringify(text)}`);
  }
  assert.ok(alphabet.includes("é"));
  assert.equal(compileBoundedPhrase("caf", "i").test("café"), false);
  assert.equal(compileBoundedPhrase("café", "i").test("un café, merci"), true);
});

function writeIndex(capabilities) {
  const dir = tempDir("relationship-index-");
  const indexPath = path.join(dir, "capabilities-index.json");
  writeJson(indexPath, { schema_version: 1, lanes: {}, capabilities });
  return indexPath;
}

// Mirrors how the Organizer indexes a stock install: a skill's description is
// also its use_when, and the ontology module ships a contact recipe.
const REPLICA_DESCRIPTION = "Researches the app being cloned and reads what its real users say in public reviews, then ranks what they hate, what is missing and what is unsolved. Use when the user says \"what do people hate about X\", \"what features are missing\", or after /replica-diff.";
const REPLICA = { id: "skill:replica-entrepreneur", type: "skill", execution_lane: "worker_skill", aliases: ["replica-entrepreneur"], use_when: [REPLICA_DESCRIPTION], description: REPLICA_DESCRIPTION, priority: 40 };
const CRM = { id: "skill:crm", type: "skill", execution_lane: "worker_skill", aliases: ["crm"], use_when: ["Manage contacts and deals through the CRM surface included with All Sorted."], description: "Manage contacts and deals through the CRM surface included with All Sorted.", priority: 40 };
const ADD_CONTACT = { id: "recipe:agent/mc/add-crm-contact", type: "recipe", execution_lane: "recipe_dispatcher", aliases: ["add crm contact", "who is"], use_when: ["add crm contact"], description: "Add or update a CRM contact", priority: 75 };
const RESOLVE_CONTACT = { id: "recipe:core/ontology-resolve-contact", type: "recipe", execution_lane: "recipe_dispatcher", aliases: ["Resolve a contact across all identity stores (ontology layer)", "core/ontology-resolve-contact", "who is", "look up contact", "resolve contact"], use_when: ["who is", "look up contact", "resolve contact", "find contact by phone", "whose number is", "contact identity"], description: "Resolve a contact across all identity stores (ontology layer)", priority: 60 };

const RELATIONSHIP_QUESTIONS = [
  "Who is Joe Che, last talked, about what",
  "who is Joe Che, when did I last talk to him, and about what?",
  "Who is Mark Chen? When did I last message him and what about?",
  "when was the last time we spoke with Ana, and what did we talk about",
];

test("relationship questions are recognised; other 'when did we last' questions are not", () => {
  for (const query of RELATIONSHIP_QUESTIONS) assert.equal(isRelationshipQuestion(query), true, query);
  for (const query of ["when did we last deploy the portal?", "what's the status of the portal", "how do I know if it worked", "who is on call tonight"]) {
    assert.equal(isRelationshipQuestion(query), false, query);
  }
});

test("a relationship question is a read, unless it also asks for a write", () => {
  for (const query of RELATIONSHIP_QUESTIONS) assert.equal(inferActionType(query, { userPrompt: true }), "read", query);
  assert.equal(inferActionType("Who is Ana? When did we last talk? Then add her to the CRM", { userPrompt: true }), "write");
  assert.equal(inferActionType("Message Ana and ask when we last talked", { userPrompt: true }), "write");
  // English write requests are unchanged.
  assert.equal(inferActionType("mark the invoice as paid", { userPrompt: true }), "write");
});

test("a relationship question never routes to an unrelated skill", () => {
  const indexPath = writeIndex([REPLICA]);
  for (const query of RELATIONSHIP_QUESTIONS) {
    assert.deepEqual(shortlistCapabilities(query, "worker_skill", 5, { indexPath }), [], query);
    assert.equal(selectExecutionLane(query, { indexPath }).candidates.length, 0, query);
  }
  // The skill still matches what it is for.
  assert.equal(shortlistCapabilities("what do people hate about Calendly? read the reviews", "worker_skill", 5, { indexPath })[0]?.capability.id, "skill:replica-entrepreneur");
});

test("a relationship question prefers contact resolution, then the CRM, never a contact write", () => {
  const indexPath = writeIndex([REPLICA, CRM, ADD_CONTACT, RESOLVE_CONTACT]);
  for (const query of RELATIONSHIP_QUESTIONS.filter((q) => /who is/i.test(q))) {
    const route = selectExecutionLane(query, { indexPath });
    assert.equal(route.lane, "recipe_dispatcher", query);
    assert.equal(route.candidates[0].capability.id, "recipe:core/ontology-resolve-contact", query);
    assert.ok(route.candidates.every((entry) => entry.capability.id !== "recipe:agent/mc/add-crm-contact"), query);
  }
  const crmOnly = writeIndex([REPLICA, CRM]);
  const shortlist = shortlistCapabilities(RELATIONSHIP_QUESTIONS[1], "worker_skill", 5, { indexPath: crmOnly });
  assert.deepEqual(shortlist.map((entry) => entry.capability.id), ["skill:crm"]);
});
