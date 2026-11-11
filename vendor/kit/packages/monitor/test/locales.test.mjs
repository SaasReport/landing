// A multi-locale site: every builtin journey runs again for each other locale, under its prefix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig } from "@saasreport/core";
import { journeys, journeyList, journeyContext } from "../src/index.js";
import { bilingualConfig } from "../../core/test/fixtures/bilingual.mjs";

const root = defineConfig({ ...bilingualConfig(), monitor: { journeys: ["landing", "feeds", { name: "about", path: "/about/" }] } });

test("journeys: builtins once per locale (name@locale), custom journeys once", () => {
  assert.deepEqual(journeyList(root), ["landing", "feeds", "landing@ar", "feeds@ar", "about"]);
  assert.deepEqual(journeyList(defineConfig({ site: { name: "x", url: "https://x.example" }, monitor: { journeys: ["landing"] } })), ["landing"]);
});

test("a locale's journey reads that locale's config and every site path under its prefix", async () => {
  const seen = [];
  const res = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => ({}) });
  const get = async (p) => { seen.push(p); return p.endsWith("sitemap.xml") ? res("<urlset>/glossary/</urlset>") : p.endsWith("llms.txt") ? res("# x") : p.endsWith("robots.txt") ? res("Sitemap: x") : res("<rss><item></item></rss>"); };
  const ctx = journeyContext(root, { get, page: async () => { throw new Error("no browser"); }, site: "https://finance.example", now: new Date("2026-10-04T08:00:00Z") });
  const j = journeys(root).find((x) => x.name === "feeds@ar");
  await j.run(ctx);
  assert.ok(seen.includes("/ar/podcasts/weekly/feed.xml") && seen.includes("/ar/blog/feed.xml"), seen.join(" "));
  assert.ok(seen.every((p) => p.startsWith("/ar/")), seen.join(" "));
});
