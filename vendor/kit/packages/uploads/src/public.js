/** The customer-facing outcome of an UploadRecord: { accepted, status, code, message, reference } and the refusal body (kit.upload-error.v1). */
import { UPLOAD_COPY } from "./copy.js";

const PUBLIC_CODES = new Set(["type_not_allowed", "type_mismatch", "too_large", "active_content_found", "archive_not_allowed", "archive_bomb", "polyglot_suspect", "malware_detected", "could_not_check"]);

export function publicOutcome(record, { copy = UPLOAD_COPY.en } = {}) {
  const v = record.verdict;
  let status;
  if (v === "allow" || v === "allow_with_limits") status = "accepted";
  else if (v === "needs_sandbox") status = record.stage === "released" ? "accepted" : "under_review";
  else if (v === "scan_failed") status = "could_not_check";
  else status = "blocked";
  const code = status === "accepted" || status === "under_review" ? null : PUBLIC_CODES.has(record.reason_code) ? record.reason_code : "could_not_check";
  return {
    accepted: status === "accepted" || status === "under_review", status, code, reference: record.upload_id,
    message: code ? `${copy.status[status]} ${copy.reasons[code] || ""}`.trim() : copy.status[status],
  };
}

/** The JSON error body for a refused file: { ok: false, error, field?, reference? }. */
export const refusalBody = (outcome, field) => ({ ok: false, error: outcome.code || "could_not_check", ...(field ? { field } : {}), reference: outcome.reference });
