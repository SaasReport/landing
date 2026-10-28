/** 
 * One canonical, project-neutral bridge from media payload to T=0 lifecycle.
 * NEVER emit a separate identity, policy, or publication state per derivative.
 */
import MEDIA_SCHEMA from "../schemas/media-bundle.schema.json" with { type: "json" };
import { MEDIA_CONTRACT } from "./media.js";
import { createUniversalEnvelope, universalBoundary, UNIVERSAL_SCHEMA_REGISTRY_REF } from "./universal-envelope.js";

export const MEDIA_AUTHORITY_REF = UNIVERSAL_SCHEMA_REGISTRY_REF;
export const MEDIA_NATIVE_SCHEMA = MEDIA_SCHEMA;

/** Wrap the existing immutable typed media plan in the ONE authoritative lifecycle. */
export function createUniversalMediaIntent(bundle, { actor, occurredAt, correlationId, policyRef, parentId = null, extraEvidence = [] } = {}) {
  if (bundle?.contract !== MEDIA_CONTRACT)
    throw new TypeError("media envelope: unsupported native payload contract");
  if (typeof policyRef !== "string" || !policyRef.trim())
    throw new TypeError("media envelope: policyRef is required");
  if (!Array.isArray(extraEvidence))
    throw new TypeError("media envelope: extraEvidence must be a list");
  const kinds = [
    ...universalBoundary("media").required_evidence,
    ...bundle.required_kinds.map((kind) => "media-" + kind),
    ...extraEvidence,
  ];
  return createUniversalEnvelope({
    tenant: bundle.tenant, project: bundle.project, kind: "media",
    subject: bundle.content_id, revision: bundle.edition, occurredAt,
    authority: {
      registry_ref: MEDIA_AUTHORITY_REF,
      contract_ref: MEDIA_CONTRACT,
      policy_ref: policyRef,
    },
    provenance: {
      source_ref: bundle.source.ref, source_sha256: bundle.source.sha256,
      observed_at: bundle.source.verified_at, actor,
    },
    correlationId, parentId,
    payloadContract: MEDIA_CONTRACT, payloadSchema: MEDIA_SCHEMA,
    payload: bundle, requiredEvidence: [...new Set(kinds)],
  });
}
