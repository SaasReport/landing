import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, seed } from "./helpers.mjs";

const ROUTES = {
  blog: ["/blog/", "/blog/hello-world", "/blog/feed.xml", "/api/blog/posts"],
  events: ["/events/", "/events/webinar", "/events/webinar.ics", "/api/events"],
  podcasts: ["/podcasts/", "/podcasts/weekly-2026-09-26", "/podcasts/feed.xml", "/api/podcasts", "/podcasts/audio/weekly-2026-09-26.mp3"],
  glossary: ["/glossary/", "/glossary/iban", "/api/glossary", "/api/glossary/today", "/taxonomy"],
  reactions: ["/api/reactions?items=post:hello-world"],
  calendar: ["/api/calendar/today", "/api/calendar/openapi.json", "/calendar.ics", "/mcp"],
  monitor: ["/api/status"],
  sitemap: ["/sitemap.xml"],
  llms: ["/llms.txt", "/llms-full.txt"],
};

for (const lang of ["fa", "en"]) {
  for (const [feature, paths] of Object.entries(ROUTES)) {
    test(`${lang}: features.${feature} = false → its routes 404 and its nav link is gone`, async () => {
      const { get, env } = makeKit(lang, { now: "2026-10-01T08:00:00Z", config: (c) => ({ ...c, features: { [feature]: false } }) });
      await seed(env, { lang });
      for (const p of paths) assert.equal((await get(p)).status, 404, `${feature} ${p}`);
      // the other features keep working
      const other = feature === "blog" ? "/events/" : "/blog/";
      const r = await get(other);
      assert.equal(r.status, 200, other);
      const html = await r.text();
      if (["blog", "events", "podcasts", "glossary"].includes(feature)) assert.ok(!html.includes(`<a href="/${feature}/"`), `nav ${feature}`);
    });
  }

  test(`${lang}: all features on → the same routes answer`, async () => {
    const { get, env } = makeKit(lang, { now: "2026-10-01T08:00:00Z" });
    await seed(env, { lang });
    for (const [feature, paths] of Object.entries(ROUTES)) {
      for (const p of paths) {
        if (lang === "en" && p === "/calendar.ics") continue; // no holiday table for a gregorian site
        const r = await get(p, p === "/mcp" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) } : {});
        assert.ok([200, 301].includes(r.status), `${feature} ${p} → ${r.status}`);
      }
    }
  });

  test(`${lang}: reactions and share off → no widget; share only → share block without likes`, async () => {
    let k = makeKit(lang, { now: "2026-10-01T08:00:00Z", config: (c) => ({ ...c, features: { reactions: false, share: false } }) });
    await seed(k.env, { lang });
    let html = await (await k.get("/blog/hello-world")).text();
    assert.ok(!html.includes('class="rx"'));
    k = makeKit(lang, { now: "2026-10-01T08:00:00Z", config: (c) => ({ ...c, features: { reactions: false } }) });
    await seed(k.env, { lang });
    html = await (await k.get("/blog/hello-world")).text();
    assert.ok(html.includes('class="rx"') && !html.includes("data-rx=") && html.includes('data-share="telegram"'));
  });
}

test("share targets are configurable (built-ins, custom templates, copy/native)", async () => {
  const { get, env } = makeKit("en", { now: "2026-10-01T08:00:00Z", options: { share: { targets: ["x", { key: "mastodon", label: "Mastodon", url: "https://toot.example/share?text={title}%20{url}" }, "copy"] } } });
  await seed(env, { lang: "en" });
  const html = await (await get("/blog/hello-world")).text();
  assert.match(html, /data-share="x" href="https:\/\/x\.com\/intent\/post\?url=https%3A%2F%2Fen\.example\.org%2Fblog%2Fhello-world&amp;text=Hello%20world"/);
  assert.match(html, /data-share="mastodon" href="https:\/\/toot\.example\/share\?text=Hello%20world%20https%3A%2F%2Fen\.example\.org%2Fblog%2Fhello-world"/);
  assert.ok(html.includes('data-copy-url="https://en.example.org/blog/hello-world"'));
  assert.ok(!html.includes('data-share="telegram"') && !html.includes("data-rx-native"));
});

test("a site without a glossary series or shows has no glossary/podcast nav and 404s there", async () => {
  const { get } = makeKit("en", { config: (c) => ({ ...c, series: c.series.filter((s) => s.kind !== "term").map(({ podcast, ...s }) => s), shows: {} }) });
  const html = await (await get("/blog/")).text();
  assert.ok(!html.includes('<a href="/glossary/"') && !html.includes('<a href="/podcasts/"'));
  assert.equal((await get("/glossary/")).status, 404);
  assert.equal((await get("/api/glossary")).status, 404);
});
