import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, seed } from "./helpers.mjs";

for (const lang of ["fa", "en"]) {
  const setup = async () => { const k = makeKit(lang, { now: "2026-10-01T08:00:00Z" }); await seed(k.env, { lang }); return k; };

  test(`${lang}: sitemap lists static pages, posts, episodes, events and every glossary term`, async () => {
    const { get, config } = await setup();
    const r = await get("/sitemap.xml");
    assert.match(r.headers.get("content-type"), /application\/xml/);
    const xml = await r.text();
    for (const loc of ["/", "/blog/", "/podcasts/", "/glossary/", "/events/", "/blog/hello-world", "/podcasts/weekly-2026-09-26", "/podcasts/daily-iban", "/events/webinar",
      "/glossary/iban", "/glossary/ledger", "/glossary/card"]) assert.ok(xml.includes(`<loc>${config.site.url}${loc}</loc>`), loc);
    assert.ok(!xml.includes("future-post"));
    assert.match(xml, /<lastmod>2026-10-01<\/lastmod>/);
  });

  test(`${lang}: llms.txt indexes pages, APIs, posts, glossary and episodes; llms-full has the full text`, async () => {
    const { get, config, content } = await setup();
    let r = await get("/llms.txt");
    assert.match(r.headers.get("content-type"), /text\/markdown/);
    const idx = await r.text();
    assert.ok(idx.startsWith(`# ${config.site.name}\n`));
    assert.ok(idx.includes(`> ${config.site.description}`));
    assert.ok(idx.includes(`](${config.site.url}/blog/hello-world.md)`), "post");
    for (const t of content.daily.terms) assert.ok(idx.includes(`](${config.site.url}/glossary/${t.slug}.md): ${t.short}`), t.slug);
    assert.ok(idx.includes(`](${config.site.url}/podcasts/weekly-2026-09-26.md)`), "episode");
    assert.ok(idx.includes("/api/glossary") && idx.includes("/api/podcasts") && idx.includes("/api/calendar/openapi.json") && idx.includes("/mcp"));
    assert.ok(idx.includes("/llms-full.txt"));
    const full = await (await get("/llms-full.txt")).text();
    assert.ok(full.includes(lang === "fa" ? "## بخش یک" : "## Part one"), "post body");
    assert.ok(full.includes(content.daily.terms[0].definition), "term definition");
    const host = Object.values(config.hosts)[0].name;
    assert.ok(full.includes(`**${host}:** `), "transcript with host names");
    assert.ok(!full.includes("future-post"));
  });

  test(`${lang}: robots.txt and security.txt from config`, async () => {
    const { get, config } = await setup();
    const robots = await (await get("/robots.txt")).text();
    assert.ok(robots.includes(`Sitemap: ${config.site.url}/sitemap.xml`));
    assert.match(robots, /User-agent: ClaudeBot/);
    assert.match(robots, /Disallow: \/api\/reactions/);
    assert.match(robots, /Disallow: \/api\/podcasts\/generate/);
    const sec = await (await get("/.well-known/security.txt")).text();
    assert.match(sec, /^Contact: .+\nExpires: 2027-10-01T00:00:00\.000Z\n/);
    assert.ok(sec.includes(`Canonical: ${config.site.url}/.well-known/security.txt`));
    assert.equal((await get("/security.txt")).status, 200);
  });
}

test("security.txt contact and policy come from options.security", async () => {
  const { get } = makeKit("en", { options: { security: { contact: "mailto:security@en.example.org", policy: "https://en.example.org/security" } } });
  const sec = await (await get("/.well-known/security.txt")).text();
  assert.match(sec, /^Contact: mailto:security@en\.example\.org\n/);
  assert.match(sec, /Policy: https:\/\/en\.example\.org\/security/);
});
