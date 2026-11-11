// Static assets on a multi-locale site (review finding): a locale's readers ask for paths relative to the locale
// (/terminal/index.md); they must resolve to the locale-prefixed asset (/ar/terminal/index.md), and files that live
// at the requested path (the landing at /ar/) must still be served there.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { buildKit } from "../src/kit.js";
import { makeDB, makeR2, makeWF, DEPS, wire } from "./helpers.mjs";
import { bilingualConfig, bilingualContent } from "../../core/test/fixtures/bilingual.mjs";

const ORIGIN = "https://finance.example";
const FILES = new Map([
  ["/terminal/index.md", "---\ntitle: \"Terminal\"\n---\n\n# Terminal en\n"],
  ["/ar/terminal/index.md", "---\ntitle: \"Terminal ar\"\n---\n\n# Terminal ar\n"],
  ["/ar/", "<html>landing ar</html>"],
  ["/ar/index.md", "---\ntitle: \"Landing ar\"\n---\n\n# Landing ar twin\n"],
  ["/ar/ar/index.md", "---\ntitle: \"Nested ar\"\n---\n\n# Nested ar page\n"],
]);
let get;
before(() => {
  const kit = buildKit(bilingualConfig(), bilingualContent(), { now: () => new Date("2026-10-04T08:00:00Z"), deps: { ...DEPS, announcePending: async () => ({ sent: 0 }), createPodcastWorkflow: () => class {} } });
  const env = { DB: makeDB(), PODCASTS: makeR2(), PODCAST_WF: makeWF(), GEMINI_API_KEY: "k", ADMIN_TOKEN: "secret", IP_SALT: "salt",
    ASSETS: { fetch: async (r) => { const b = FILES.get(new URL(r.url).pathname); return b == null ? new Response("not found", { status: 404 }) : new Response(b); } } };
  get = (path) => kit.fetch(new Request(`${ORIGIN}${path}`, wire({})), env, { waitUntil() {} });
});

test("default locale: /terminal.md resolves to /terminal/index.md", async () => {
  const r = await get("/terminal.md");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Terminal en/);
});

test("non-default locale: /ar/terminal.md resolves to /ar/terminal/index.md, not the English page", async () => {
  const r = await get("/ar/terminal.md");
  assert.equal(r.status, 200, "the alias must be looked up under the locale prefix");
  const body = await r.text();
  assert.match(body, /Terminal ar/);
  assert.doesNotMatch(body, /Terminal en/);
});

test("non-default locale: the direct twin path and a file at the requested path still work", async () => {
  assert.equal((await get("/ar/terminal/index.md")).status, 200);
  assert.match(await (await get("/ar/")).text(), /landing ar/);
});

test("a twin that does not exist is a 404 in every locale, never another locale's page", async () => {
  assert.equal((await get("/ar/nope.md")).status, 404);
  assert.equal((await get("/nope.md")).status, 404);
});

test("a page named like its locale: /ar/ar.md is /ar/ar/index.md, never the locale landing twin (review finding)", async () => {
  const r = await get("/ar/ar.md");
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /Nested ar page/);
  assert.doesNotMatch(body, /Landing ar twin/);
  assert.match(await (await get("/ar/ar/index.md")).text(), /Nested ar page/);
  assert.match(await (await get("/ar/index.md")).text(), /Landing ar twin/, "the landing twin itself is untouched");
});

test("a page named like its locale with no twin of its own is a 404, not the landing twin", async () => {
  FILES.delete("/ar/ar/index.md");
  try { assert.equal((await get("/ar/ar.md")).status, 404); } finally { FILES.set("/ar/ar/index.md", "---\ntitle: \"Nested ar\"\n---\n\n# Nested ar page\n"); }
});
