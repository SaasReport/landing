/**
 * kit.universal-envelope.v1 — immutable T=0 boundary shared by source, event,
 * media, workflow, API, SDK, widget and release contracts.
 * Domain payload schemas remain the authorities. This is NOT a publisher.
 */
import SCHEMA from "../schemas/universal-envelope.schema.json" with { type: "json" };
import BOUNDARIES from "../registry/universal-boundaries.json" with { type: "json" };
import BOUNDARY_SCHEMA from "../schemas/universal-boundaries.schema.json" with { type: "json" };
import SCHEMA_INDEX from "../schemas/index.json" with { type: "json" };
import { canonicalJson } from "./canonical.js";
import { sha256 } from "./sha256.js";
import { validate } from "./schema.js";

export const UNIVERSAL_ENVELOPE_CONTRACT = "kit.universal-envelope.v1";
export const UNIVERSAL_SCHEMA_REGISTRY_REF = "kit:packages/core/schemas/index.json";
export const UNIVERSAL_AUTHORITY_SHA256 = sha256(canonicalJson({
  envelope: SCHEMA,
  boundaries: BOUNDARIES,
  schema_index: SCHEMA_INDEX.schemas.map(({ name, file }) => ({ name, file })),
}));
const boundaryProblems = validate(BOUNDARIES, BOUNDARY_SCHEMA);
if (boundaryProblems.length) throw new Error("T0 universal boundaries registry invalid: " + JSON.stringify(boundaryProblems));
export const UNIVERSAL_BOUNDARIES = Object.freeze(BOUNDARIES.boundaries.map((b) =>
  Object.freeze({ kind: b.kind, level: b.level, required_evidence: Object.freeze(b.required_evidence.slice()) })));
const boundaryByKind = new Map(UNIVERSAL_BOUNDARIES.map((b) => [b.kind, b]));
if (boundaryByKind.size !== UNIVERSAL_BOUNDARIES.length) throw new Error("T0 universal boundary kind duplication");
if (new Set(BOUNDARIES.levels.map((l) => l.id)).size !== BOUNDARIES.levels.length)
  throw new Error("T0 universal boundary level duplication");
export function universalBoundary(kind) {
  const boundary = boundaryByKind.get(kind);
  if (!boundary) throw new TypeError("unregistered T0 universal boundary kind: " + String(kind));
  return boundary;
}
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const validUTC = (at) => typeof at === "string" && UTC.test(at) &&
  Number.isFinite(Date.parse(at)) && new Date(at).toISOString().slice(0, 19) === at.slice(0, 19);
const nonempty = (s) => typeof s === "string" && !!s.trim();
const fail = (reason) => { throw new TypeError("universal envelope: " + reason); };
function jsonData(value, visited = new WeakSet(), location = "data") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(location + " must be finite JSON"); return; }
  if (typeof value !== "object") fail(location + " must be JSON, not " + typeof value);
  if (visited.has(value)) fail(location + " has a cycle or shared reference");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) fail(location + " must be a plain JSON object");
  visited.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail(location + " cannot contain sparse arrays");
      jsonData(value[i], visited, location + "[" + i + "]");
    }
  } else {
    for (const [k, v] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(k)) fail(location + " has an unsafe object key");
      jsonData(v, visited, location + "." + k);
    }
  }
  visited.delete(value);
}
const immutable = (value) => {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) immutable(v);
    Object.freeze(value);
  }
  return value;
};
const copy = (obj) => JSON.parse(JSON.stringify(obj));
const identity = (e) => [e.tenant, e.project, e.kind, e.subject, e.revision].join("/");
const idempotencyKey = (e) => sha256(canonicalJson({
  contract: UNIVERSAL_ENVELOPE_CONTRACT, id: identity(e),
  authority: e.authority, source_sha256: e.provenance.source_sha256,
  payload_contract: e.payload.contract_ref, payload_schema_id: e.payload.schema_id,
  payload_schema_sha256: e.payload.schema_sha256,
  payload_sha256: e.payload.sha256,
  required_evidence: [...e.lifecycle.required_evidence].sort(),
}));
function canonicalErrors(e) {
  const problems = validate(e, SCHEMA).map((x) => (x.path || "/") + ": " + (x.message || x.problem || JSON.stringify(x)));
  try {
    const boundary = universalBoundary(e?.kind);
    const covered = new Set(e?.lifecycle?.required_evidence || []);
    for (const evidence of boundary.required_evidence)
      if (!covered.has(evidence)) problems.push("boundary evidence gate missing: " + evidence);
  } catch (err) { problems.push(String(err.message)); }
  if (e?.authority?.root_sha256 !== UNIVERSAL_AUTHORITY_SHA256) problems.push("canonical Kit authority root SHA mismatch");
  if (e?.authority?.contract_ref !== e?.payload?.contract_ref) problems.push("authority and native payload contract mismatch");
  if (e?.id !== identity(e)) problems.push("id is not the canonical tenant/project/kind/subject/revision identity");
  if (!validUTC(e?.occurred_at) || !validUTC(e?.provenance?.observed_at)) problems.push("UTC instants required");
  if (e?.payload) {
    try {
      jsonData(e.payload.data);
      if (e.payload.sha256 !== sha256(canonicalJson(e.payload.data))) problems.push("payload hash mismatch");
    } catch (err) { problems.push(String(err.message)); }
  }
  if (e?.trace?.idempotency_key && e?.authority && e?.provenance && e?.payload) {
    if (e.trace.idempotency_key !== idempotencyKey(e)) problems.push("idempotency digest mismatch");
  }
  return problems;
}

/** Emit before network access, D1 writes, R2 writes or Workflow starts. */
export function createUniversalEnvelope({
  tenant, project, kind, subject, revision, occurredAt,
  authority, provenance, correlationId, causationId = null,
  parentId = null, payloadContract, payloadSchema, payload, requiredEvidence,
} = {}) {
  for (const [field, value] of Object.entries({ tenant, project, kind, subject, revision })) {
    if (!SEGMENT.test(value || "")) fail(field + " must be a stable namespace segment");
  }
  const boundary = universalBoundary(kind);
  if (!validUTC(occurredAt)) fail("occurredAt must be an exact UTC instant");
  if (!authority || !["registry_ref", "contract_ref", "policy_ref"].every((key) => nonempty(authority[key])))
    fail("canonical registry, contract and policy refs required");
  if (!provenance || !nonempty(provenance.source_ref) || !HASH.test(provenance.source_sha256 || "") ||
      !validUTC(provenance.observed_at) || !nonempty(provenance.actor))
    fail("source ref, sha256, observed_at and actor required");
  if (!nonempty(payloadContract) || !nonempty(correlationId))
    fail("payload contract and correlation id required");
  if (causationId != null && !nonempty(causationId)) fail("causationId must be non-empty or null");
  if (parentId != null && !nonempty(parentId)) fail("parentId must be non-empty or null");
  if (!Array.isArray(requiredEvidence) || !requiredEvidence.length ||
      new Set(requiredEvidence).size !== requiredEvidence.length ||
      requiredEvidence.some((kind) => !SEGMENT.test(kind || "")))
    fail("explicit, unique requiredEvidence policy is mandatory");
  const unfulfilledKinds = boundary.required_evidence.filter((name) => !requiredEvidence.includes(name));
  if (unfulfilledKinds.length) fail("boundary evidence gate missing: " + unfulfilledKinds.join(","));
  if (!payloadSchema || typeof payloadSchema !== "object" || !nonempty(payloadSchema.$id) ||
      payloadSchema.$schema !== "https://json-schema.org/draft/2020-12/schema")
    fail("canonical native payloadSchema with stable $id and draft 2020-12 is required");
  // Reject NaN, undefined, cycles and unsafe object keys before native validators inspect data.
  // No type-coercion or silent JSON.stringify loss is permitted at the T=0 boundary.
  jsonData(payload);
  const nativeProblems = validate(payload, payloadSchema);
  if (nativeProblems.length) fail("native payload contract rejected: " + JSON.stringify(nativeProblems));
  const data = copy(payload);
  const draft = {
    schema: UNIVERSAL_ENVELOPE_CONTRACT,
    id: [tenant, project, kind, subject, revision].join("/"),
    tenant, project, kind, subject, revision, occurred_at: occurredAt,
    authority: { ...copy(authority), root_sha256: UNIVERSAL_AUTHORITY_SHA256 },
    provenance: copy(provenance),
    trace: { correlation_id: correlationId, causation_id: causationId, idempotency_key: "" },
    payload: { contract_ref: payloadContract, schema_id: payloadSchema.$id, schema_sha256: sha256(canonicalJson(payloadSchema)), sha256: sha256(canonicalJson(data)), data },
    lineage: { parent_id: parentId },
    lifecycle: { state: "planned-not-executed", required_evidence: requiredEvidence.slice() },
  };
  draft.trace.idempotency_key = idempotencyKey(draft);
  const problems = canonicalErrors(draft);
  if (problems.length) fail(problems.join("; "));
  return immutable(draft);
}

/** Refuse schema drift, namespace mutation and payload tampering before use. */
export const universalEnvelopeProblems = (envelope, { nativeSchema = null } = {}) => {
  try {
    const problems = canonicalErrors(envelope);
    // The native schema MUST be resolved from an authoritative registry/pinned vendor snapshot.
    // A matching string alone is not proof of a typed payload. No implicit schema fallback.
    if (!nativeSchema || typeof nativeSchema !== "object" ||
        nativeSchema.$id !== envelope?.payload?.schema_id ||
        nativeSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      problems.push("canonical native payload schema unresolved or mismatched");
    } else {
      if (envelope.payload.schema_sha256 !== sha256(canonicalJson(nativeSchema)))
        problems.push("native schema content digest mismatch");
      problems.push(...validate(envelope.payload.data, nativeSchema)
        .map((x) => "native payload: " + JSON.stringify(x)));
    }
    return problems;
  } catch (error) { return [String(error?.message || error)]; }
};

/**
 * Adapter-supplied observations are assertions, not cryptographic proof.
 * Governed deployer/Worker must verify against D1/Workflow/R2/HTTP then sign
 * promotion elsewhere. This pure function NEVER reports released/published.
 */
export function assessUniversalEvidence(envelope, receipts = [], { nativeSchema = null } = {}) {
  const blockers = universalEnvelopeProblems(envelope, { nativeSchema }).map((reason) => ({ kind: "contract", reason }));
  if (!Array.isArray(receipts)) fail("receipts must be an array");
  const required = new Set(envelope?.lifecycle?.required_evidence || []), seen = new Set();
  for (const r of receipts) {
    const kind = r?.kind;
    if (!required.has(kind)) { blockers.push({ kind: kind || "unknown", reason: "undeclared_evidence" }); continue; }
    if (seen.has(kind)) { blockers.push({ kind, reason: "duplicate_evidence" }); continue; }
    seen.add(kind);
    if (r.envelope_id !== envelope.id || r.idempotency_key !== envelope.trace?.idempotency_key ||
        r.tenant !== envelope.tenant || r.project !== envelope.project)
      blockers.push({ kind, reason: "cross-tenant-or-identity-mismatch" });
    if (r.status !== "verified" || !HASH.test(r.sha256 || "") || !nonempty(r.external_ref) ||
        !validUTC(r.observed_at) || Date.parse(r.observed_at) < Date.parse(envelope.occurred_at))
      blockers.push({ kind, reason: "unverified_or_invalid_observation" });
  }
  for (const kind of required) if (!seen.has(kind)) blockers.push({ kind, reason: "missing_required_evidence" });
  return immutable({
    schema: "kit.universal-evidence-assessment.v1", envelope_id: envelope?.id ?? null,
    required: required.size, observed: seen.size, ok: blockers.length === 0,
    status: blockers.length ? "blocked-not-released" : "evidence-ready-for-independent-review",
    blockers, released: false, deployed: false, published: false,
  });
}
