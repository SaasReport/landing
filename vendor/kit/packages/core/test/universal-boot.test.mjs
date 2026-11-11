import test from "node:test";
import assert from "node:assert/strict";
import { UNIVERSAL_ENVELOPE_CONTRACT } from "../src/universal-envelope.js";
import { planUniversalBoot, probeUniversalBoot, UNIVERSAL_BOOT_CONTRACT } from "../src/universal-boot.js";
const SHA = "a".repeat(64);
const adapter = (kind, override = {}) => ({
  universal_envelope: UNIVERSAL_ENVELOPE_CONTRACT,
  contract_ref: "kit.test-probe.v1",
  policy_ref: "policy/test",
  implementation_ref: "workers/test/" + kind,
  probe: async () => ({
    ok: true, kind, universal_envelope: UNIVERSAL_ENVELOPE_CONTRACT,
    contract_ref: "kit.test-probe.v1", observation_ref: "sandbox/test-" + kind,
    observation_sha256: SHA,
  }),
  ...override,
});
const make = (overrides = {}) => ({ project: "test-app", tenant: "site-01", ...overrides });

test("T0 synchronously declares all 47 boundaries, with no fake external readiness", () => {
  const p = planUniversalBoot(make());
  assert.equal(p.contract, UNIVERSAL_BOOT_CONTRACT);
  assert.equal(p.entries.length, 47);
  assert.equal(p.configured, 0);
  assert.equal(p.state, "boot-plan-ready-not-released");
  assert.equal(p.deployed, false);
  assert.equal(p.production_verified, false);
  assert.ok(p.entries.every((e) => e.state === "unavailable-not-pretended-ready"));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.entries));
});
test("missing external provider or agent never stalls a responsive, self-contained API", async () => {
  const p = planUniversalBoot(make({
    requiredKinds: ["api", "agent"],
    adapters: { api: adapter("api") },
  }));
  const r = await probeUniversalBoot({ plan: p, adapters: { api: adapter("api") }, maxProbeMs: 50 });
  assert.equal(r.boot_control_plane, "responsive");
  assert.ok(r.results.find((x) => x.kind === "api").status === "responsive-unattested");
  assert.equal(r.results.find((x) => x.kind === "agent").status, "unavailable");
  assert.deepEqual(r.required_blockers, [{ kind: "agent", reason: "adapter-not-provisioned" }]);
  assert.equal(r.required_boot_probes_passed, false);
  assert.equal(r.published, false);
});
test("a hanging required daemon is time-limited; other probes still settle", async () => {
  const adapters = {
    daemon: adapter("daemon", { probe: () => new Promise(() => {}) }),
    api: adapter("api"),
  };
  const p = planUniversalBoot(make({ requiredKinds: ["daemon", "api"], adapters }));
  // The result settling while the daemon's Promise never resolves is the
  // deterministic proof of bounded progress; no host wallclock assertions.
  const r = await probeUniversalBoot({ plan: p, adapters, maxProbeMs: 20 });
  assert.equal(r.results.length, 47);
  assert.equal(r.results.find((x) => x.kind === "daemon").reason, "bounded-probe-timeout");
  assert.equal(r.results.find((x) => x.kind === "api").status, "responsive-unattested");
  assert.equal(r.required_boot_probes_passed, false);
});
test("adapter cannot self-certify production or impersonate another canonical kind", async () => {
  const adapters = { sdk: adapter("sdk", { probe: async () => ({ ok: true, kind: "api",
    universal_envelope: UNIVERSAL_ENVELOPE_CONTRACT, contract_ref: "kit.test-probe.v1",
    observation_ref: "faked", observation_sha256: SHA, deployed: true, published: true }) }) };
  const p = planUniversalBoot(make({ requiredKinds: ["sdk"], adapters }));
  const r = await probeUniversalBoot({ plan: p, adapters, maxProbeMs: 50 });
  assert.equal(r.results.find((x) => x.kind === "sdk").reason, "invalid-or-missing-boot-evidence");
  assert.equal(r.production_verified, false);
  assert.equal(r.deployed, false);
});
test("T0 rejects unknown kinds, malformed project identity and stale or missing authority", async () => {
  assert.throws(() => planUniversalBoot(make({ requiredKinds: ["not-canonical"] })), /requiredKinds/);
  assert.throws(() => planUniversalBoot(make({ project: "../another" })), /project\/tenant/);
  assert.throws(() => planUniversalBoot(make({ adapters: { invented: adapter("invented") } })), /unregistered adapter/);
  const invalid = { api: adapter("api", { policy_ref: "" }) };
  const p = planUniversalBoot(make({ requiredKinds: ["api"], adapters: invalid }));
  const r = await probeUniversalBoot({ plan: p, adapters: invalid, maxProbeMs: 30 });
  assert.equal(r.required_boot_probes_passed, false);
  assert.equal(r.results.find((x) => x.kind === "api").reason, "missing-T0-native-contract-policy-or-probe");
});
