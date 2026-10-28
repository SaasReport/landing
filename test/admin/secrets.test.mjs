// The deploy step that sets the Access secrets: values go to wrangler's stdin only, nothing is printed, every failure names what is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, readAccess } from "../../scripts/admin-secrets.mjs";

const ACCOUNT = "a".repeat(32);
const api = (over = {}) => async (url) => {
  const p = new URL(url).pathname.replace(`/client/v4/accounts/${ACCOUNT}`, "");
  const table = { "/access/organizations": over.org ?? { auth_domain: "team.cloudflareaccess.com" }, "/access/apps": over.apps ?? [{ id: "b".repeat(32), name: "saasreport-admin-production", aud: "c".repeat(64), policies: [{ decision: "allow", include: [{ email: { email: "Owner.Test@Example.Test" } }] }] }] };
  return Response.json({ success: over.fail !== p, result: table[p] ?? null }, { status: over.fail === p ? 403 : 200 });
};
const run = (calls) => (cmd, args, opts) => { calls.push({ cmd, args, input: opts.input }); return { status: 0 }; };

test("it names the missing credential and does nothing else", async () => {
  await assert.rejects(main({ env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, fetchFn: api(), run: run([]), log: () => {} }), /CLOUDFLARE_API_TOKEN is not set/);
  await assert.rejects(main({ env: { CLOUDFLARE_API_TOKEN: "t" }, fetchFn: api(), run: run([]), log: () => {} }), /CLOUDFLARE_ACCOUNT_ID is not set/);
});

test("it refuses an application that is missing, has no AUD, no email policy or allows more than emails", async () => {
  const get = (r) => async (p) => (p.includes("organizations") ? { auth_domain: "t.cloudflareaccess.com" } : r);
  await assert.rejects(readAccess(get([]), ACCOUNT, "saasreport-admin-production"), /no Access application named/);
  await assert.rejects(readAccess(get([{ name: "saasreport-admin-production" }]), ACCOUNT, "saasreport-admin-production"), /no AUD tag/);
  await assert.rejects(readAccess(get([{ name: "saasreport-admin-production", aud: "x", policies: [{ include: [] }] }]), ACCOUNT, "saasreport-admin-production"), /no email policy/);
  await assert.rejects(readAccess(get([{ name: "saasreport-admin-production", aud: "x", policies: [{ include: [{ everyone: {} }] }] }]), ACCOUNT, "saasreport-admin-production"), /owner-only/);
});

test("a Cloudflare API failure is reported without a value", async () => {
  await assert.rejects(main({ env: { CLOUDFLARE_API_TOKEN: "token-for-tests", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, fetchFn: api({ fail: "/access/apps" }), run: run([]), log: () => {} }), (e) => /answered 403/.test(e.message) && !e.message.includes("token-for-tests"));
});

test("the three secrets are set by name, values on stdin only, and nothing is logged but the names", async () => {
  const calls = [], lines = [];
  await main({ env: { CLOUDFLARE_API_TOKEN: "token-for-tests", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, fetchFn: api(), run: run(calls), log: (l) => lines.push(l) });
  assert.deepEqual(calls.map((c) => c.args[3]), ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ADMIN_ALLOWED_EMAILS"]);
  assert.deepEqual(calls.map((c) => c.input), ["team.cloudflareaccess.com", "c".repeat(64), "owner.test@example.test"]);
  for (const c of calls) assert.ok(!c.args.some((a) => a.includes("example.test") || a.includes("cloudflareaccess")), "no value in the arguments");
  assert.deepEqual(lines, ["set ACCESS_TEAM_DOMAIN", "set ACCESS_AUD", "set ADMIN_ALLOWED_EMAILS"]);
});

test("a wrangler failure stops at that secret", async () => {
  const run = () => ({ status: 1 });
  await assert.rejects(main({ env: { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, fetchFn: api(), run, log: () => {} }), /wrangler secret put ACCESS_TEAM_DOMAIN failed/);
});
