/**
 * The decision: one pure function from the evidence (size, sniffed type, declared match, triage, scan) and the form's policy to
 * a verdict, a reason code, the serving limits and the stage. The worst of the contributions wins; a refusal at the edge
 * (size, type) stops before any triage or scan. Nothing here can produce a pass the evidence does not support: with no scanner
 * the verdict is needs_sandbox at best.
 */
import { ALLOWABLE_TYPES } from "./sniff.js";
import { SEVERITY, VERDICTS, worst, normaliseScan } from "./scan.js";

/** The reason codes of the record schema (upload-record.schema.json reason_code); a test compares the two. */
export const REASON_CODES = Object.freeze(["none", "type_not_allowed", "type_mismatch", "too_large", "active_content_found", "archive_not_allowed", "archive_bomb", "polyglot_suspect", "malware_detected", "could_not_check", "scanner_not_configured", "needs_sandbox_review", "policy_hold"]);
const TRIAGE_VERDICTS = new Set(["allow", "allow_with_limits", "needs_sandbox", "block"]);
const SCAN_VERDICTS = new Set(VERDICTS);
const UNREADABLE = ["scan_failed", "could_not_check"];

/**
 * One contribution as [verdict, reason_code]. Fails CLOSED: anything that is not an object with a verdict from the list (a missing
 * verdict, "clean", true, "ALLOW") or whose reason code is not in the schema is a failed check (scan_failed / could_not_check, a
 * hold), never a pass. decide() is exported, so it cannot rely on its callers having normalised their input.
 */
function contribution(x, verdicts) {
  if (!x || typeof x !== "object" || typeof x.verdict !== "string" || !verdicts.has(x.verdict)) return UNREADABLE;
  const reason = typeof x.reason_code === "string" && REASON_CODES.includes(x.reason_code) ? x.reason_code : (x.verdict === "allow" || x.verdict === "allow_with_limits" ? "none" : "could_not_check");
  return [x.verdict, reason];
}

const LIMITS_BY_FAMILY = {
  document: ["download_only", "open_only_in_sandbox"], image: ["reencode_before_inline", "no_inline_render"], text: ["download_only"], archive: ["download_only", "open_only_in_sandbox"],
};

/**
 * @param {{ policy, size, sniffed: { type, family, polyglot_suspect, matches_declared }, triage?: object, scan?: { verdict, reason_code } }} e
 * @returns {{ verdict, reason_code, limits: string[], stage: "rejected"|"quarantined"|"held"|"released"|"blocked", store: boolean }}
 */
export function decide({ policy, size, sniffed, triage = null, scan = null }) {
  const edge = (reason) => ({ verdict: "block", reason_code: reason, limits: [], stage: "rejected", store: false });
  if (typeof size !== "number" || !(size <= policy.max_bytes)) return edge("too_large");   // written so that NaN, undefined and a non-number are refused too
  if (!ALLOWABLE_TYPES.includes(sniffed.type) || !policy.allowed_types.includes(sniffed.type)) return edge(sniffed.family === "archive" && sniffed.type !== "application/zip" ? "archive_not_allowed" : "type_not_allowed");

  const parts = [];   // [verdict, reason_code]
  if (sniffed.polyglot_suspect) parts.push(["block", "polyglot_suspect"]);
  if (sniffed.matches_declared !== true) parts.push(["block", "type_mismatch"]);
  if (triage != null) parts.push(contribution(triage, TRIAGE_VERDICTS));
  else parts.push(["needs_sandbox", "could_not_check"]);
  if (scan != null) parts.push(contribution(normaliseScan(scan), SCAN_VERDICTS));   // decide() is exported: a scan block that says error, timeout, detected or scanner "none" is floored here too
  else parts.push(["needs_sandbox", "scanner_not_configured"]);

  const verdict = worst(...parts.map((p) => p[0]));
  const reason = (parts.find((p) => p[0] === verdict && p[1] !== "none") || [verdict, "none"])[1];
  const reason_code = verdict === "allow" || verdict === "allow_with_limits" ? "none" : reason;

  const familyLimits = LIMITS_BY_FAMILY[sniffed.family] || ["download_only"];
  if (verdict === "block") return { verdict, reason_code, limits: [], stage: "blocked", store: true };
  if (verdict === "scan_failed") return { verdict, reason_code, limits: [], stage: "quarantined", store: true };
  if (verdict === "needs_sandbox") {
    const release = policy.on_needs_sandbox === "release_download_only";
    return { verdict, reason_code, limits: release ? ["download_only", "open_only_in_sandbox"] : [], stage: release ? "released" : "held", store: true };
  }
  return { verdict, reason_code, limits: verdict === "allow" ? [] : familyLimits, stage: "released", store: true };
}

export { SEVERITY };
