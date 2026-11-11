/**
 * Universal T=0 boot controller — ONE canonical boundary registry, no dependency on
 * network readiness, marketplace counterparties, optional providers or release gates.
 * Bootability is separate from production verification. Never fabricate "live".
 */
import { UNIVERSAL_BOUNDARIES, UNIVERSAL_ENVELOPE_CONTRACT } from "./universal-envelope.js";

export const UNIVERSAL_BOOT_CONTRACT = "kit.universal-boot.v1";
const SEG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const hasText = (v) => typeof v === "string" && !!v.trim();
const assert = (ok, why) => { if (!ok) throw new TypeError("T0 universal boot: " + why); };
const freeze = (value) => Object.freeze(value);
const kinds = freeze(UNIVERSAL_BOUNDARIES.map((b) => b.kind));
const allowedKinds = new Set(kinds);

/**
 * Pure, synchronous, bootable-at-T0 control plane. Every canonical boundary is
 * present even if its actual adapter or dependent service is absent. An absent
 * capability is unavailable-with-reason, NEVER falsely reported as operational.
 * This function performs no IO and has no post-facto registry mutation.
 */
export function planUniversalBoot({ project, tenant, adapters = {}, requiredKinds = kinds } = {}) {
  assert(SEG.test(project || "") && SEG.test(tenant || ""), "canonical project/tenant required");
  assert(adapters && typeof adapters === "object" && !Array.isArray(adapters), "adapters must be a kind-keyed object");
  assert(Array.isArray(requiredKinds) && new Set(requiredKinds).size === requiredKinds.length &&
    requiredKinds.every((kind) => allowedKinds.has(kind)), "requiredKinds must be unique canonical kinds");
  for (const kind of Object.keys(adapters)) assert(allowedKinds.has(kind), "unregistered adapter: " + kind);
  const mandatory = new Set(requiredKinds);
  const entries = UNIVERSAL_BOUNDARIES.map((boundary) => {
    const a = adapters[boundary.kind];
    const ready = a && typeof a.probe === "function" && hasText(a.contract_ref) &&
      hasText(a.policy_ref) && hasText(a.implementation_ref) &&
      a.universal_envelope === UNIVERSAL_ENVELOPE_CONTRACT;
    const reason = !a ? "adapter-not-provisioned" :
      !ready ? "missing-T0-native-contract-policy-or-probe" : null;
    return freeze({
      kind: boundary.kind,
      level: boundary.level,
      required: mandatory.has(boundary.kind),
      required_evidence: freeze(boundary.required_evidence.slice()),
      state: ready ? "configured-awaiting-bounded-probe" : "unavailable-not-pretended-ready",
      reason,
      contract_ref: ready ? a.contract_ref : null,
      implementation_ref: ready ? a.implementation_ref : null,
    });
  });
  return freeze({
    contract: UNIVERSAL_BOOT_CONTRACT,
    envelope_contract: UNIVERSAL_ENVELOPE_CONTRACT,
    project, tenant,
    entries: freeze(entries),
    required: requiredKinds.length,
    declared: entries.length,
    configured: entries.filter((e) => e.state === "configured-awaiting-bounded-probe").length,
    state: "boot-plan-ready-not-released",
    deployed: false, published: false, production_verified: false,
  });
}

/**
 * Time-bounded probes in parallel. A silent or unavailable optional component
 * never blocks boot diagnostics for any other boundary. Required failures remain
 * blockers, not green statuses. Assertions from adapters are NOT deployment proof.
 */
export async function probeUniversalBoot({ plan, adapters = {}, maxProbeMs = 1200 } = {}) {
  assert(plan?.contract === UNIVERSAL_BOOT_CONTRACT && Array.isArray(plan.entries),
    "an immutable canonical boot plan is required");
  assert(Number.isSafeInteger(maxProbeMs) && maxProbeMs >= 10 && maxProbeMs <= 5000,
    "maxProbeMs must be bounded between 10 and 5000");
  const probeOne = async (entry) => {
    const blocked = (reason) => freeze({ kind: entry.kind, required: entry.required,
      status: "unavailable", reason, externally_verified: false });
    if (entry.state !== "configured-awaiting-bounded-probe") return blocked(entry.reason);
    const a = adapters[entry.kind];
    if (!a || typeof a.probe !== "function" || a.contract_ref !== entry.contract_ref ||
        a.implementation_ref !== entry.implementation_ref ||
        !hasText(a.policy_ref) || a.universal_envelope !== UNIVERSAL_ENVELOPE_CONTRACT)
      return blocked("T0-plan-adapter-drift");
    const controller = new AbortController();
    let timeout;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => a.probe(freeze({
          project: plan.project, tenant: plan.tenant, kind: entry.kind,
          signal: controller.signal,
        }))).then((response) => ({ outcome: "settled", response }),
          (err) => ({ outcome: "error", error: err })),
        new Promise((resolve) => { timeout = setTimeout(() => {
          controller.abort();
          resolve({ outcome: "timeout" });
        }, maxProbeMs); }),
      ]);
      if (result.outcome === "timeout") return blocked("bounded-probe-timeout");
      if (result.outcome === "error") return blocked("probe-failed-no-fabricated-readiness");
      const r = result.response;
      if (!r || r.ok !== true || r.kind !== entry.kind ||
          r.contract_ref !== entry.contract_ref || r.universal_envelope !== UNIVERSAL_ENVELOPE_CONTRACT ||
          !hasText(r.observation_ref) || !SHA.test(r.observation_sha256 || ""))
        return blocked("invalid-or-missing-boot-evidence");
      return freeze({ kind: entry.kind, required: entry.required,
        status: "responsive-unattested", reason: null, externally_verified: false,
        observation_ref: r.observation_ref, observation_sha256: r.observation_sha256 });
    } catch {
      return blocked("unhandled-probe-error");
    } finally {
      clearTimeout(timeout);
    }
  };
  const results = freeze(await Promise.all(plan.entries.map(probeOne)));
  const requiredBlockers = freeze(results.filter((r) => r.required && r.status !== "responsive-unattested")
    .map((r) => freeze({ kind: r.kind, reason: r.reason })));
  return freeze({
    contract: "kit.universal-boot-assessment.v1",
    project: plan.project, tenant: plan.tenant,
    results, required_blockers: requiredBlockers,
    responsive: results.filter((r) => r.status === "responsive-unattested").length,
    unavailable: results.filter((r) => r.status === "unavailable").length,
    boot_control_plane: "responsive",
    required_boot_probes_passed: requiredBlockers.length === 0,
    state: requiredBlockers.length ? "partial-boot-with-explicit-blockers" : "boot-probes-passed-not-attested",
    deployed: false, published: false, production_verified: false,
  });
}
