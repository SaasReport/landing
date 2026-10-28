// kit purge: zone lookup by site.url host, the zone guard, purge everything / --files, retries, dry run, token never printed.
// fetch is mocked: no network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/index.js";
import { zoneCandidates, inZone, CF_API } from "../src/commands/purge.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const TOKEN = "cf-secret-token-0123456789";
const TMP = fileTempDir("kit-purge-");

function project(name, url) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kit.config.js"), `export default { site: { url: ${JSON.stringify(url)} } };\n`);
  return dir;
}

/** A fake Cloudflare API. `zones`: name → id. `script`: optional per-call overrides (throw or a Response). */
function fakeCf({ zones = {}, script = [], purgeFail } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    const step = script.shift();
    if (step instanceof Error) throw step;
    if (step) return step;
    const u = new URL(url);
    const path = u.pathname.replace("/client/v4", "");
    if (path === "/zones") {
      const name = u.searchParams.get("name");
      const result = zones[name] ? [{ id: zones[name], name }] : [];
      return Response.json({ success: true, errors: [], result });
    }
    const m = path.match(/^\/zones\/([^/]+)\/purge_cache$/);
    if (m && init.method === "POST") {
      if (purgeFail) return Response.json({ success: false, errors: [{ code: 10000, message: `Authentication error for ${TOKEN}` }] }, { status: 403 });
      return Response.json({ success: true, errors: [], result: { id: m[1] } });
    }
    return Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 });
  };
  return { fetch, calls };
}

async function kit(argv, { cwd, env = { CLOUDFLARE_API_TOKEN: TOKEN }, fetch } = {}) {
  const out = [], err = [], sleeps = [];
  const code = await main(argv, {
    cwd, env, out: (s) => out.push(s), err: (s) => err.push(s),
    fetch: fetch || (() => { throw new Error("no network in tests"); }),
    spawn: () => { throw new Error("spawn must not be called"); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const all = `${out.join("\n")}\n${err.join("\n")}`;
  assert.ok(!all.includes(TOKEN), "the token is never printed");
  return { code, out: out.join("\n"), err: err.join("\n"), sleeps };
}

test("zoneCandidates and inZone", () => {
  assert.deepEqual(zoneCandidates("www.acme.example"), ["www.acme.example", "acme.example"]);
  assert.deepEqual(zoneCandidates("example.co.uk"), ["example.co.uk", "co.uk"]);
  assert.deepEqual(zoneCandidates("localhost"), []);
  assert.ok(inZone("www.a.com", "a.com"));
  assert.ok(inZone("A.com", "a.com"));
  assert.ok(!inZone("evila.com", "a.com"));
  assert.ok(!inZone("a.com.evil.net", "a.com"));
});

test("purges everything on the zone named after site.url's host", async () => {
  const cwd = project("everything", "https://acme.example");
  const cf = fakeCf({ zones: { "acme.example": "z-acme", "saasreport.ai": "z-saasreport" } });
  const r = await kit(["purge"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 0, r.err);
  assert.equal(cf.calls.length, 2);
  assert.equal(cf.calls[0].url, `${CF_API}/zones?name=acme.example`);
  assert.equal(cf.calls[0].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(cf.calls[1], { url: `${CF_API}/zones/z-acme/purge_cache`, method: "POST", auth: `Bearer ${TOKEN}`, body: { purge_everything: true } });
  assert.match(r.out, /purged everything on zone acme\.example/);
});

test("a www host falls back to the parent zone", async () => {
  const cwd = project("www", "https://www.acme.example/");
  const cf = fakeCf({ zones: { "acme.example": "z-acme" } });
  const r = await kit(["purge"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cf.calls.map((c) => c.url), [`${CF_API}/zones?name=www.acme.example`, `${CF_API}/zones?name=acme.example`, `${CF_API}/zones/z-acme/purge_cache`]);
});

test("--files purges only those URLs (paths resolve against site.url), 30 per request", async () => {
  const cwd = project("files", "https://acme.example");
  const cf = fakeCf({ zones: { "acme.example": "z-acme" } });
  const r = await kit(["purge", "--files", "/calendar/,/calendar/sa.ics,https://www.acme.example/x"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cf.calls[1].body, { files: ["https://acme.example/calendar/", "https://acme.example/calendar/sa.ics", "https://www.acme.example/x"] });
  const many = Array.from({ length: 31 }, (_, i) => `/p${i}`);
  const cf2 = fakeCf({ zones: { "acme.example": "z-acme" } });
  const r2 = await kit(["purge", "--files", many.join(",")], { cwd, fetch: cf2.fetch });
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(cf2.calls.slice(1).map((c) => c.body.files.length), [30, 1]);
});

test("refuses URLs outside the site's zone, before any API call", async () => {
  const cwd = project("guard", "https://acme.example");
  const cf = fakeCf({ zones: { "acme.example": "z-acme", "saasreport.ai": "z-saasreport" } });
  const r = await kit(["purge", "--files", "https://saasreport.ai/"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing: not on acme\.example/);
  assert.equal(cf.calls.length, 0);
});

test("refuses when the API answers with a zone of another name", async () => {
  const cwd = project("mismatch", "https://acme.example");
  const wrong = Response.json({ success: true, errors: [], result: [{ id: "z-saasreport", name: "saasreport.ai" }] });
  const empty = Response.json({ success: true, errors: [], result: [] });
  const cf = fakeCf({ script: [wrong, empty] });
  const r = await kit(["purge"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 1);
  assert.match(r.err, /no Cloudflare zone for acme\.example/);
  assert.ok(!cf.calls.some((c) => c.method === "POST"), "nothing purged");
});

test("retries network errors and 5xx, then succeeds", async () => {
  const cwd = project("retry", "https://saasreport.ai");
  const cf = fakeCf({ zones: { "saasreport.ai": "z-saasreport" }, script: [new TypeError("fetch failed"), new Response("bad gateway", { status: 502 })] });
  const r = await kit(["purge"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 0, r.err);
  assert.equal(cf.calls.length, 4, "2 failed lookups, 1 lookup, 1 purge");
  assert.deepEqual(r.sleeps, [500, 1000]);
  assert.match(r.err, /retrying \(1\/2\)/);
});

test("gives up after 3 network errors with exit 1", async () => {
  const cwd = project("down", "https://saasreport.ai");
  const e = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const cf = fakeCf({ script: [e(), e(), e()] });
  const r = await kit(["purge"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 1);
  assert.match(r.err, /failed after 3 attempts: network error: ECONNRESET/);
});

test("an API refusal exits 1 and the token is redacted from the message", async () => {
  const cwd = project("refused", "https://saasreport.ai");
  const cf = fakeCf({ zones: { "saasreport.ai": "z-saasreport" }, purgeFail: true });
  const r = await kit(["purge"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 1);
  assert.match(r.err, /POST \/zones\/z-saasreport\/purge_cache: HTTP 403 — 10000 Authentication error for \*\*\*/);
});

test("no token: exit 1 without calling the API", async () => {
  const cwd = project("notoken", "https://saasreport.ai");
  const r = await kit(["purge"], { cwd, env: {}, fetch: () => { throw new Error("must not fetch"); } });
  assert.equal(r.code, 1);
  assert.match(r.err, /CLOUDFLARE_API_TOKEN is not set/);
});

test("--dry-run: looks the zone up (read-only) but never purges; without a token it makes no call", async () => {
  const cwd = project("dry", "https://acme.example");
  const cf = fakeCf({ zones: { "acme.example": "z-acme" } });
  const r = await kit(["purge", "--dry-run"], { cwd, fetch: cf.fetch });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cf.calls.map((c) => c.method), ["GET"]);
  assert.match(r.out, /dry run: zone acme\.example \(z-acme\).*would purge everything/);
  assert.match(r.out, /POST .*\/zones\/z-acme\/purge_cache \{"purge_everything":true\}/);
  const n = await kit(["purge", "--dry-run", "--files", "/calendar/"], { cwd, env: {}, fetch: () => { throw new Error("must not fetch"); } });
  assert.equal(n.code, 0, n.err);
  assert.match(n.out, /lookup skipped/);
  assert.match(n.out, /"files":\["https:\/\/acme\.example\/calendar\/"\]/);
});

test("a config without site.url is an error", async () => {
  const dir = join(TMP, "nourl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kit.config.js"), "export default { site: {} };\n");
  const r = await kit(["purge"], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.err, /has no site\.url/);
});
