// The six areas of the console: user management (users, roles, RBAC, invitations, audit) and the five operations areas, with honest empty states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAdmin, seedLead, expectJson, hashOf, ALLOWED } from "./helpers.mjs";
import { can, permissionOf } from "../../workers/admin/src/rbac.js";
import { operations, CONTRACT } from "../../workers/admin/src/contract.js";
import { config } from "../../workers/admin/src/config.js";

const mut = (method, body, extra = {}) => ({ method, body, ...extra });
const audit = async (a) => (await a.env.DB.prepare("SELECT * FROM admin_audit ORDER BY seq").all()).results;

test("RBAC: every operation names a permission; the owner holds all, a viewer only reads, an unknown role or operation is refused", () => {
  for (const o of operations()) assert.ok(["read", "export", "operate", "admin", "none"].includes(permissionOf(o.operationId)), `${o.operationId} names a permission`);
  for (const o of operations().filter((x) => x.operationId !== "getBuild")) assert.ok(can("owner", o.operationId), `owner may ${o.operationId}`);
  assert.equal(can("viewer", "listLeads"), true);
  for (const id of ["updateLead", "retryDelivery", "addSuppression", "removeSuppression", "exportLeads", "createInvitation", "listUsers"]) assert.equal(can("viewer", id), false, `viewer may not ${id}`);
  assert.equal(can("operator", "updateLead"), true);
  assert.equal(can("operator", "createInvitation"), false);
  assert.equal(can("nobody", "listLeads"), false);
  assert.equal(can("owner", "noSuchOperation"), false);
  assert.ok(operations().filter((o) => o.mutating).every((o) => permissionOf(o.operationId) !== "read"), "no mutation needs only read");
  assert.equal(CONTRACT.paths["/api/leads/{id}"].patch["x-permission"], "operate");
});

test("listRoles: the roles of the configuration; the owner is not assignable", async () => {
  const a = makeAdmin();
  const j = await expectJson(a, "listRoles", "/api/roles", 200);
  assert.deepEqual(j.roles.map((r) => r.id), config.roles.map((r) => r.id));
  assert.equal(j.roles.find((r) => r.id === "owner").assignable, false);
});

test("listUsers: the allowlisted identities as hashes (owners), no registry principal yet, never an address", async () => {
  const a = makeAdmin();
  const j = await expectJson(a, "listUsers", "/api/users", 200);
  assert.deepEqual(j.items.map((u) => u.id).sort(), [hashOf(ALLOWED), hashOf("second.test@example.test")].sort());
  assert.ok(j.items.every((u) => u.role === "owner" && u.source === "allowlist" && u.created_at === null));
  assert.ok(!JSON.stringify(j).includes("@"));
  assert.match(j.note, /Access/);
  const reg = hashOf("registry.test@example.test");
  await a.env.DB.prepare("INSERT INTO admin_principals (id, role, status, created_at, updated_at, created_by) VALUES (?, 'viewer', 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)").bind(reg, hashOf(ALLOWED)).run();
  const withReg = await expectJson(a, "listUsers", "/api/users", 200);
  assert.deepEqual(withReg.items.find((u) => u.id === reg), { id: reg, role: "viewer", status: "active", source: "registry", created_at: "2026-10-01T00:00:00.000Z" });
  assert.equal((await a.call("/api/users?limit=0")).status, 400);
});

test("createInvitation: refused for a bad body, an unknown role, the owner role, a cross-origin call; recorded as a hash, audited, no address kept", async () => {
  const a = makeAdmin();
  const bad = [{}, { email: "x@example.test" }, { role: "viewer" }, { email: "not an address", role: "viewer" }, { email: "x@example.test", role: "viewer", days: 99 }, { email: "x@example.test", role: "viewer", extra: 1 }];
  for (const body of bad) assert.equal((await a.call("/api/invitations", mut("POST", body))).status, 400, JSON.stringify(body));
  assert.equal((await a.call("/api/invitations", mut("POST", { email: "x@example.test", role: "owner" }))).status, 400, "the owner role is held through the allowlist only");
  assert.equal((await a.call("/api/invitations", mut("POST", { email: "x@example.test", role: "ghost" }))).status, 400);
  assert.equal((await a.call("/api/invitations", mut("POST", { email: "x@example.test", role: "viewer" }, { origin: "https://evil.example.test" }))).status, 403);
  assert.equal((await audit(a)).filter((r) => r.outcome === "done").length, 0);
  const inv = await expectJson(a, "createInvitation", "/api/invitations", 200, mut("POST", { email: "Invitee.Test@Example.Test", role: "viewer", days: 3 }, { headers: { "idempotency-key": "i1" } }));
  assert.equal(inv.state, "pending");
  assert.equal(inv.invitee_hash, hashOf("invitee.test@example.test"));
  assert.equal(Date.parse(inv.expires_at) - Date.parse(inv.created_at), 3 * 86_400_000);
  const dump = JSON.stringify([await audit(a), (await a.env.DB.prepare("SELECT * FROM admin_invitations").all()).results, (await a.env.DB.prepare("SELECT * FROM admin_idempotency").all()).results]).toLowerCase();
  assert.ok(!dump.includes("invitee.test"), "the address is stored nowhere");
  assert.deepEqual((await audit(a)).map((r) => [r.action, r.outcome]), [["createInvitation", "denied"], ["createInvitation", "done"]], "the cross-origin attempt is on record, then the invitation");
  const again = await a.call("/api/invitations", mut("POST", { email: "invitee.test@example.test", role: "viewer", days: 3 }, { headers: { "idempotency-key": "i1" } }));
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  const dup = await a.call("/api/invitations", mut("POST", { email: "invitee.test@example.test", role: "operator" }));
  assert.equal(dup.status, 409, "one pending invitation per invitee");
  assert.equal((await audit(a)).filter((r) => r.outcome === "done").length, 1);
});

test("listInvitations and revokeInvitation: filter, page, revoke only a pending one, expired shows as expired", async () => {
  const a = makeAdmin();
  assert.equal((await a.call("/api/invitations?state=gone")).status, 400);
  const mk = (email) => expectJson(a, "createInvitation", "/api/invitations", 200, mut("POST", { email, role: "operator" }));
  const one = await mk("one@example.test"), two = await mk("two@example.test");
  assert.equal((await expectJson(a, "listInvitations", "/api/invitations", 200)).items.length, 2);
  const p = await expectJson(a, "listInvitations", "/api/invitations?limit=1", 200);
  assert.ok(p.next_cursor);
  assert.equal((await a.call("/api/invitations/bad/revoke", mut("POST", {}))).status, 400);
  assert.equal((await a.call("/api/invitations/inv_00000000-0000-0000-0000-000000000000/revoke", mut("POST", {}))).status, 404);
  const r = await expectJson(a, "revokeInvitation", `/api/invitations/${one.id}/revoke`, 200, mut("POST", {}));
  assert.equal(r.state, "revoked");
  assert.equal((await a.call(`/api/invitations/${one.id}/revoke`, mut("POST", {}))).status, 409, "not pending any more");
  assert.deepEqual((await expectJson(a, "listInvitations", "/api/invitations?state=pending", 200)).items.map((x) => x.id), [two.id]);
  await a.env.DB.prepare("UPDATE admin_invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(two.id).run();
  assert.equal((await expectJson(a, "listInvitations", "/api/invitations?state=expired", 200)).items.length, 1);
  assert.equal((await a.call(`/api/invitations/${two.id}/revoke`, mut("POST", {}))).status, 409);
  assert.equal((await mk("two@example.test")).state, "pending", "an expired invitation does not block a new one");
  assert.ok((await audit(a)).some((x) => x.action === "revokeInvitation" && x.outcome === "done"));
});

const AREAS = { finops: "getFinOps", bizops: "getBizOps", platformops: "getPlatformOps", saasops: "getSaaSOps", infraops: "getInfraOps" };

test("every area answers per the contract; each section is available, empty or not connected, and says why when it shows nothing", async () => {
  const a = makeAdmin();
  a.env.COMMS = { fetch: async () => Response.json({ commit: null, services: {} }) };
  for (const [area, op] of Object.entries(AREAS)) {
    const j = await expectJson(a, op, `/api/areas/${area}`, 200);
    assert.equal(j.area, area);
    assert.ok(j.sections.length >= 2);
    for (const s of j.sections) {
      if (s.state === "not_connected") { assert.ok(s.reason && s.reason.length > 20, `${area}/${s.id} says why`); assert.deepEqual(s.metrics, [], `${area}/${s.id} shows no figure`); }
      if (s.state === "available") assert.ok(s.source, `${area}/${s.id} names its source`);
    }
  }
});

test("finops has no source behind it, so it shows no number at all", async () => {
  const a = makeAdmin();
  const j = await expectJson(a, "getFinOps", "/api/areas/finops", 200);
  assert.ok(j.sections.every((s) => s.state === "not_connected" && s.metrics.length === 0));
  assert.ok(!/\d/.test(JSON.stringify(j.sections.map((s) => s.summary))), "no figure in any summary");
});

test("bizops reads the lead funnel (empty, then counted), the commitments and the legal blockers; platformops and saasops and infraops read their real sources", async () => {
  const a = makeAdmin();
  a.env.COMMS = { fetch: async () => Response.json({ commit: null, services: {} }) };
  let j = await expectJson(a, "getBizOps", "/api/areas/bizops", 200);
  assert.equal(j.sections.find((s) => s.id === "leads").state, "empty");
  assert.equal(j.sections.find((s) => s.id === "customers").state, "not_connected");
  const id = await seedLead(a.env.ENGINE_DB);
  await a.call(`/api/leads/${id}`, mut("PATCH", { status: "won" }));
  j = await expectJson(a, "getBizOps", "/api/areas/bizops", 200);
  const funnel = j.sections.find((s) => s.id === "leads");
  assert.equal(funnel.state, "available");
  assert.equal(funnel.metrics.find((m) => m.key === "won").value, 1);
  assert.ok(j.sections.find((s) => s.id === "legal").reason, "the legal view says its text is not checked");
  const p = await expectJson(a, "getPlatformOps", "/api/areas/platformops", 200);
  assert.equal(p.sections.find((s) => s.id === "deliveries").metrics.find((m) => m.key === "submissions").value, 1);
  assert.equal(p.sections.find((s) => s.id === "monitor").state, "not_connected");
  const s = await expectJson(a, "getSaaSOps", "/api/areas/saasops", 200);
  assert.ok(s.sections.find((x) => x.id === "catalogue").metrics.every((m) => m.value > 0));
  const i = await expectJson(a, "getInfraOps", "/api/areas/infraops", 200);
  assert.equal(i.sections.find((x) => x.id === "naming").metrics.find((m) => m.key === "valid").value, 0);
  assert.equal(i.sections.find((x) => x.id === "release").state, "not_connected");
});

test("an unreachable engine database makes platformops say so instead of showing zero", async () => {
  const a = makeAdmin({ env: { ENGINE_DB: undefined } });
  const p = await expectJson(a, "getPlatformOps", "/api/areas/platformops", 200);
  const d = p.sections.find((s) => s.id === "deliveries");
  assert.equal(d.state, "not_connected");
  assert.deepEqual(d.metrics, []);
});
