"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { matchProjects, scoreProject } = require("../src/workspace-context");

const projects = [
  { slug: "whatsapp", name: "WhatsApp", path: "whatsapp", aliases: ["whatsapp", "wa", "baileys", "whatsapp-server", "wa-server", "whatsapp-inbox", "whatsapp-agent", "whatsapp-chat"] },
  { slug: "crm", name: "CRM", path: "crm", aliases: ["contacts", "crm"] },
  { slug: "meta-ads-course", name: "Meta Ads Course", path: "meta-ads-course", aliases: ["meta ads course"] },
];

const LONG_BRIEF = [
  "Review my startup files, contacts, agents, FastPass, and the other places the system loads context from at the start of every session.",
  "Produce a ranked list of findings with concrete evidence for each one, and note which items need a decision from Joe before anything changes.",
  "Cover the dispatch router, the capability index, the fastpath data file, the memory index, and the cron schedule that keeps the index files in sync.",
  "Also look at the whatsapp triage recipe and whether it still runs under the right node version on a fresh shell.",
  "Report only what you verified yourself, and keep the final report short.",
].join(" ");

test("long brief that mentions whatsapp once does not route to whatsapp", () => {
  assert.ok(LONG_BRIEF.split(/\s+/).length > 60);
  const slugs = matchProjects(LONG_BRIEF, projects).map((p) => p.slug);
  assert.ok(!slugs.includes("whatsapp"), `routed to ${slugs.join(",")}`);
  assert.equal(scoreProject(LONG_BRIEF, projects[0]), 0);
});

test("short prompts still route to whatsapp", () => {
  for (const prompt of ["check whatsapp triage", "whatsapp send message to X"]) {
    const slugs = matchProjects(prompt, projects).map((p) => p.slug);
    assert.equal(slugs[0], "whatsapp", prompt);
  }
});

test("a long prompt mentioning a project three times still routes to it", () => {
  const prompt = `${LONG_BRIEF} The whatsapp part matters most. Spend most of the time on whatsapp.`;
  assert.equal(matchProjects(prompt, projects)[0]?.slug, "whatsapp");
});

test("a single mention inside the first 200 characters of a long prompt still routes", () => {
  const prompt = `Check whatsapp. ${LONG_BRIEF.replace(/whatsapp/i, "inbox")}`;
  assert.equal(matchProjects(prompt, projects)[0]?.slug, "whatsapp");
});

test("a late single mention that is the object of a first-sentence directive still routes", () => {
  const filler = "carefully and completely without skipping any of the intermediate steps along the way, ".repeat(3);
  const lateDirective = `Please go through everything ${filler}and then fix the whatsapp. ${LONG_BRIEF.replace(/whatsapp/i, "inbox")}`;
  assert.ok(lateDirective.indexOf("whatsapp") >= 200);
  assert.equal(matchProjects(lateDirective, projects)[0]?.slug, "whatsapp");
});
