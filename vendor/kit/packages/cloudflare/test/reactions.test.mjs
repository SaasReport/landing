import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, seed } from "./helpers.mjs";

const setup = async (lang = "fa", options = {}) => { const k = makeKit(lang, { now: "2026-10-01T08:00:00Z", options }); await seed(k.env, { lang }); return k; };
const post = (k, body, headers = {}) => k.get("/api/reactions", { method: "POST", headers: { "content-type": "application/json", origin: k.config.site.url, "cf-connecting-ip": "203.0.113.7", ...headers }, body: JSON.stringify(body) });

for (const lang of ["fa", "en"]) {
  test(`${lang}: like → cookie set, visitor hashed, counts and own state returned; unlike`, async () => {
    const k = await setup(lang);
    let r = await post(k, { item: "post:hello-world", like: true });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie");
    assert.match(cookie, /^kit_v=[A-Za-z0-9_-]{16,64}; Path=\/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax$/);
    let j = await r.json();
    assert.deepEqual([j.likes, j.mine.liked], [1, true]);
    const id = /kit_v=([^;]+)/.exec(cookie)[1];
    const row = await k.env.DB.prepare("SELECT visitor, ip_hash FROM reactions").first();
    assert.match(row.visitor, /^[0-9a-f]{64}$/); assert.notEqual(row.visitor, id);
    assert.match(row.ip_hash, /^[0-9a-f]{64}$/); assert.ok(!row.ip_hash.includes("203.0.113.7"));
    // same browser: no new cookie, state readable
    r = await k.get("/api/reactions?items=post:hello-world,episode:weekly-2026-09-26,bogus", { headers: { cookie: `kit_v=${id}` } });
    j = await r.json();
    assert.deepEqual(Object.keys(j.items).sort(), ["episode:weekly-2026-09-26", "post:hello-world"]);
    assert.equal(j.items["post:hello-world"].mine.liked, true);
    r = await post(k, { item: "post:hello-world", like: false }, { cookie: `kit_v=${id}` });
    assert.equal(r.headers.get("set-cookie"), null);
    j = await r.json();
    assert.deepEqual([j.likes, j.mine.liked], [0, false]);
  });

  test(`${lang}: ratings 1-5 on episodes (average), not on posts; validation and existence`, async () => {
    const k = await setup(lang);
    let j = await (await post(k, { item: "episode:weekly-2026-09-26", rating: 4 }, { cookie: "kit_v=aaaaaaaaaaaaaaaaaaaa" })).json();
    assert.deepEqual([j.rating_count, j.rating_avg, j.mine.rating], [1, 4, 4]);
    j = await (await post(k, { item: "episode:weekly-2026-09-26", rating: 5 }, { cookie: "kit_v=bbbbbbbbbbbbbbbbbbbb" })).json();
    assert.deepEqual([j.rating_count, j.rating_avg], [2, 4.5]);
    j = await (await post(k, { item: "episode:weekly-2026-09-26", rating: 2 }, { cookie: "kit_v=bbbbbbbbbbbbbbbbbbbb" })).json();
    assert.deepEqual([j.rating_count, j.rating_avg], [2, 3], "re-rating replaces the visitor's rating");
    assert.equal((await post(k, { item: "post:hello-world", rating: 3 })).status, 422);
    assert.equal((await post(k, { item: "episode:weekly-2026-09-26", rating: 6 })).status, 422);
    assert.equal((await post(k, { item: "episode:weekly-2026-09-26", rating: 3, like: true })).status, 422);
    assert.equal((await post(k, { item: "nope:x", like: true })).status, 422);
    assert.equal((await post(k, { item: "post:missing", like: true })).status, 404);
    assert.equal((await post(k, { item: "post:future-post", like: true })).status, 404, "unpublished items cannot be liked");
    const html = await (await k.get("/podcasts/weekly-2026-09-26")).text();
    assert.ok(html.includes(lang === "fa" ? "۲ رأی" : "2 ratings"), "server-rendered aggregate");
  });

  test(`${lang}: cross-origin writes are refused; GET needs no origin`, async () => {
    const k = await setup(lang);
    assert.equal((await post(k, { item: "post:hello-world", like: true }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post(k, { item: "post:hello-world", like: true }, { origin: "not a url" })).status, 403);
    assert.equal((await k.get("/api/reactions?items=post:hello-world", { headers: { origin: "https://evil.example" } })).status, 200);
    assert.equal((await k.get("/api/reactions", { method: "PUT" })).status, 405);
  });
}

test("writes are rate-limited per IP (hashed) within the window", async () => {
  const k = await setup("en", { reactions: { maxWrites: 3, windowMinutes: 10 } });
  for (let i = 0; i < 3; i++) assert.equal((await post(k, { item: "post:hello-world", like: i % 2 === 0 }, { cookie: `kit_v=visitor${i}xxxxxxxxxxxxxx` })).status, 200);
  const r = await post(k, { item: "post:hello-world", like: true }, { cookie: "kit_v=visitor9xxxxxxxxxxxxxx" });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "rate_limited");
  assert.equal(r.headers.get("retry-after"), "600");
  // another IP is not affected
  assert.equal((await post(k, { item: "post:hello-world", like: true }, { "cf-connecting-ip": "198.51.100.1" })).status, 200);
});

test("the cookie name is configurable", async () => {
  const k = await setup("en", { reactions: { cookie: "site_v" } });
  const r = await post(k, { item: "post:hello-world", like: true });
  assert.match(r.headers.get("set-cookie"), /^site_v=/);
});
