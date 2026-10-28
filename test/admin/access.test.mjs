// Cloudflare Access verification, every case failure first. All with local keys and a fake key-set endpoint: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAdmin, newKey, sign, jwksFetch, req, TEAM, AUD, ALLOWED, hashOf } from "./helpers.mjs";

const body = async (r) => r.json();
const OPAQUE = { ok: false, error: "unavailable" };

test("no token: 401, and nothing of the Worker is reached", async () => {
  const a = makeAdmin();
  for (const p of ["/api/session", "/api/leads", "/workbench/", "/"]) {
    const r = await a.worker.fetch(req(p), a.env, {});
    assert.equal(r.status, 401, p);
    assert.deepEqual(await body(r), { ok: false, error: "unauthorized" });
  }
});

test("a malformed token, a token of another algorithm and an oversized token are 401", async () => {
  const a = makeAdmin();
  const hs = (alg) => { const h = Buffer.from(JSON.stringify({ alg, kid: "kid-1" })).toString("base64url"); return `${h}.${Buffer.from("{}").toString("base64url")}.AAAA`; };
  for (const t of ["x", "a.b", "a.b.c.d", "!!.!!.!!", hs("none"), hs("HS256"), `${"a".repeat(9000)}.b.c`]) assert.equal((await a.call("/api/session", { token: t })).status, 401, t.slice(0, 20));
});

test("a valid token reads the session; the answer carries a hash of the email, never the address", async () => {
  const a = makeAdmin();
  const r = await a.call("/api/session");
  assert.equal(r.status, 200);
  const j = await body(r);
  assert.equal(j.actor_hash, hashOf(ALLOWED));
  assert.ok(!JSON.stringify(j).includes("@"));
});

test("wrong aud, wrong iss, expired, not yet valid, no exp: 401", async () => {
  const a = makeAdmin();
  const now = Math.floor(Date.now() / 1000);
  const cases = { aud: { aud: ["b".repeat(64)] }, "aud as text": { aud: "b".repeat(64) }, iss: { iss: "https://other.cloudflareaccess.com" }, expired: { exp: now - 3600 }, "not yet": { nbf: now + 3600 }, "no exp": { exp: undefined } };
  for (const [name, claims] of Object.entries(cases)) assert.equal((await a.call("/api/session", { token: a.token(claims) })).status, 401, name);
});

test("the audience may be a list, and a small clock skew is tolerated, a large one is not", async () => {
  const a = makeAdmin();
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await a.call("/api/session", { token: a.token({ aud: ["other", AUD] }) })).status, 200);
  assert.equal((await a.call("/api/session", { token: a.token({ exp: now - 30 }) })).status, 200, "30 s past exp is inside the skew");
  assert.equal((await a.call("/api/session", { token: a.token({ exp: now - 300 }) })).status, 401, "300 s past exp is not");
  assert.equal((await a.call("/api/session", { token: a.token({ nbf: now + 30 }) })).status, 200);
});

test("a bad signature is 401: a token signed by another key under the same kid, a tampered payload", async () => {
  const a = makeAdmin();
  const other = newKey("kid-1");
  assert.equal((await a.call("/api/session", { token: sign(other, {}) })).status, 401);
  const [h, p, s] = a.token().split(".");
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), email: "someone.else@example.test" })).toString("base64url");
  assert.equal((await a.call("/api/session", { token: `${h}.${evil}.${s}` })).status, 401);
});

test("an email that is not on the allowlist is 403, audited as denied by hash, and reads nothing", async () => {
  const a = makeAdmin();
  const r = await a.call("/api/leads", { token: a.token({ email: "stranger@example.test" }) });
  assert.equal(r.status, 403);
  assert.deepEqual(await body(r), { ok: false, error: "forbidden" });
  const rows = (await a.env.DB.prepare("SELECT * FROM admin_audit").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "denied");
  assert.equal(rows[0].actor_hash, hashOf("stranger@example.test"));
  assert.ok(!JSON.stringify(rows).includes("stranger@"), "the address is not in the log");
  assert.equal((await a.call("/api/session", { token: a.token({ email: undefined }) })).status, 403, "no email claim");
  assert.equal((await a.call("/api/session", { token: a.token({ email: ALLOWED.toUpperCase() }) })).status, 200, "the comparison is case-insensitive");
});

test("missing or invalid configuration refuses every request: 503 with no detail (each name, an invalid team domain, an empty allowlist)", async () => {
  for (const [name, value] of [["ACCESS_TEAM_DOMAIN", undefined], ["ACCESS_AUD", undefined], ["ADMIN_ALLOWED_EMAILS", undefined], ["ADMIN_ALLOWED_EMAILS", " , "], ["ACCESS_TEAM_DOMAIN", "evil.example.test"], ["ACCESS_TEAM_DOMAIN", "x.cloudflareaccess.com.evil.test"], ["ACCESS_AUD", ""]]) {
    const a = makeAdmin({ env: { [name]: value } });
    for (const p of ["/api/session", "/api/leads", "/workbench/"]) {
      const r = await a.call(p);
      assert.equal(r.status, 503, `${name}=${value} ${p}`);
      assert.deepEqual(await body(r), OPAQUE);
    }
    assert.equal(a.fetch.calls.length, 0, "no key is fetched from a host the config does not vouch for");
  }
});

test("the key set cannot be fetched: fail closed (503)", async () => {
  const a = makeAdmin();
  a.state.fail = true;
  const r = await a.call("/api/session");
  assert.equal(r.status, 503);
  assert.deepEqual(await body(r), OPAQUE);
  a.state.fail = false;
  assert.equal((await a.call("/api/session")).status, 200, "it recovers when the endpoint does");
});

test("a key set that answers an error, junk or no usable key is a failure, not a pass", async () => {
  for (const make of [() => new Response("nope", { status: 500 }), () => new Response("{not json", { status: 200 }), () => Response.json({ keys: [] }), () => Response.json({ keys: [{ kty: "EC", kid: "kid-1" }] }), () => new Response("x".repeat(70_000))]) {
    const key = newKey("kid-1");
    const a = makeAdmin({ key, fetch: async () => make() });
    assert.equal((await a.call("/api/session")).status, 503);
  }
});

test("keys are cached for the TTL: the endpoint is asked once, and a later outage does not matter until the TTL ends", async () => {
  let t = Date.now();
  const a = makeAdmin({ now: () => t });
  assert.equal((await a.call("/api/session")).status, 200);
  assert.equal((await a.call("/api/session")).status, 200);
  assert.equal(a.fetch.calls.length, 1);
  a.state.fail = true;
  t += 200_000;
  assert.equal((await a.call("/api/session", { token: a.token({}, { now: Math.floor(t / 1000) }) })).status, 200, "inside the TTL");
  t += 200_000;
  assert.equal((await a.call("/api/session", { token: a.token({}, { now: Math.floor(t / 1000) }) })).status, 503, "past the TTL with the endpoint down: closed");
});

test("a kid the cache does not know, inside the minimum gap after the last fetch, is refused without a refetch", async () => {
  const a = makeAdmin();
  assert.equal((await a.call("/api/session")).status, 200);
  assert.equal(a.fetch.calls.length, 1);
  const rotated = newKey("kid-2");
  a.state.keys = [rotated, a.key];
  const r = await a.worker.fetch(req("/api/session", { token: sign(rotated, {}) }), a.env, {});
  assert.equal(r.status, 401);
  assert.equal(a.fetch.calls.length, 1, "the gap is measured on the Worker's clock: the first fetch was just now");
});

test("key rotation, after the gap: one refetch finds the new kid; an unknown kid costs one refetch and is 401", async () => {
  let t = Date.now();
  const a = makeAdmin({ now: () => t });
  assert.equal((await a.call("/api/session")).status, 200);
  const rotated = newKey("kid-2");
  a.state.keys = [rotated];
  t += 11_000;
  const ok = await a.worker.fetch(req("/api/session", { token: sign(rotated, {}, { now: Math.floor(t / 1000) }) }), a.env, {});
  assert.equal(ok.status, 200);
  assert.equal(a.fetch.calls.length, 2, "exactly one refetch");
  const ghost = newKey("kid-ghost");
  t += 11_000;
  const bad = await a.worker.fetch(req("/api/session", { token: sign(ghost, {}, { now: Math.floor(t / 1000) }) }), a.env, {});
  assert.equal(bad.status, 401);
  assert.equal(a.fetch.calls.length, 3, "one refetch for the unknown kid, no loop");
  t += 1000;
  await a.worker.fetch(req("/api/session", { token: sign(ghost, {}, { now: Math.floor(t / 1000) }) }), a.env, {});
  assert.equal(a.fetch.calls.length, 3, "and not again inside the gap: a stranger cannot make the Worker hammer the endpoint");
  for (const c of a.fetch.calls) assert.equal(c, `https://${TEAM}/cdn-cgi/access/certs`);
});

test("/api/build is the one route that needs no token, and it answers while the configuration is missing", async () => {
  const a = makeAdmin({ env: { ACCESS_AUD: undefined } });
  const r = await a.worker.fetch(req("/api/build"), a.env, {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j).sort(), ["commit", "services"]);
  assert.equal((await a.worker.fetch(req("/api/build", { method: "POST" }), a.env, {})).status, 405);
});
