/** One error type for every refusal: a reason code (data, never prose) and the HTTP status it maps to. */
export const STATUS = Object.freeze({
  bad_request: 400,
  bad_signature: 401,
  unknown_agent: 401,
  stale: 401,
  replayed: 401,
  forbidden_action: 403,
  forbidden_repo: 403,
  review_required: 403,
  review_invalid: 403,
  checks_not_green: 409,
  head_moved: 409,
  base_moved: 409,
  not_mergeable: 409,
  config_invalid: 500,
  key_invalid: 500,
  evidence_failed: 500,
  merged_evidence_failed: 500,
  merge_outcome_unknown: 502,
  upstream_failed: 502,
});

export class BrokerError extends Error {
  constructor(reason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason in STATUS ? reason : "bad_request";
    this.status = STATUS[this.reason];
  }
}
