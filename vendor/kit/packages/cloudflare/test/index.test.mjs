import { test } from "node:test";
import assert from "node:assert/strict";
import { createKit, DEFAULT_DEPS, buildKit } from "../src/index.js";
import { sample, makeDB, makeWF, makeR2 } from "./helpers.mjs";

test("createKit wires the sibling packages by default", () => {
  for (const k of ["defineConfig", "loadContent", "planner", "buildPost", "calendar", "episodeFromItem", "createPodcastWorkflow", "ttsConfigured", "announcePending"]) assert.ok(DEFAULT_DEPS[k], k);
  assert.equal(typeof buildKit, "function");
});

test("the consumer worker shape: default export with fetch/scheduled, PodcastWorkflow class", async () => {
  const { config, content } = sample("en");
  // In Node, @saasreport/podcast needs an explicit base class (Workers use WorkflowEntrypoint from cloudflare:workers).
  const kit = createKit(config, content, { deps: { createPodcastWorkflow: (o) => DEFAULT_DEPS.createPodcastWorkflow({ ...o, Base: class { constructor(ctx, env) { this.env = env; } } }) } });
  assert.equal(typeof kit.fetch, "function");
  assert.equal(typeof kit.scheduled, "function");
  assert.equal(typeof kit.PodcastWorkflow, "function");
  assert.equal(typeof kit.PodcastWorkflow.prototype.run, "function");
  const env = { DB: makeDB(), PODCASTS: makeR2(), PODCAST_WF: makeWF(), GEMINI_API_KEY: "test-key" };
  // A sample consumer that schedules podcasts declares its TTS capability; missing TTS now fails Cron at T=0.
  const r = await kit.fetch(new Request("https://en.example.org/glossary/"), env, {});
  assert.equal(r.status, 200);
  const rep = await kit.scheduled({ scheduledTime: Date.parse("2026-10-05T06:00:00Z") }, env, { waitUntil() {} });
  assert.ok(rep.posts.includes("weekly-2026-10-05"));
  assert.ok(rep.episodes.length > 0, "the site queues its required podcast rather than silently skipping it");
  assert.equal(rep.channels.configured, false, "channels dormant without secrets");
});

test("an invalid config fails loudly (core defineConfig)", () => {
  assert.throws(() => createKit({ site: { name: "x" } }, {}, { deps: { createPodcastWorkflow: undefined } }), /site\.url/);
});
