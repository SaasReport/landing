/**
 * The scan step is a pluggable interface with a REQUIRED explicit verdict:
 *
 *   allow | allow_with_limits | needs_sandbox | block | scan_failed
 *
 * and NEVER "clean" or "safe". A scanner is { name, version, thirdParty?, consentRef?, scan(input) }:
 *
 *   scan({ bytes, sha256, size, sniffed, form, signal }) → { verdict, status?, signature_db_version?, detail? }
 *
 * With no scanner configured the verdict is needs_sandbox (status not_run): the form's policy decides whether the file is held
 * or released for download only, and there is never an implicit pass. A scanner that throws, times out, answers without a
 * verdict, or answers with a word that is not in the list above (including clean, safe, ok, pass, true) yields scan_failed.
 * A scanner that sends the file to a third party must declare it and carry a consent reference (the record keeps it).
 */

import { hasShape, isLowerAlpha, isDigit } from "./lex.js";

export const VERDICTS = Object.freeze(["allow", "allow_with_limits", "needs_sandbox", "block", "scan_failed"]);
/** Worst first when verdicts combine. */
export const SEVERITY = Object.freeze({ allow: 0, allow_with_limits: 1, needs_sandbox: 2, scan_failed: 3, block: 4 });
/** The worst of the verdicts. A word that is not a verdict counts as scan_failed (a hold), never as the mildest: combining must not turn garbage into a pass. */
export const worst = (...vs) => vs.map((v) => (Object.hasOwn(SEVERITY, v) ? v : "scan_failed")).reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));

export const NO_SCANNER = Object.freeze({ name: "none", version: "0", async scan() { return { verdict: "needs_sandbox", status: "not_run" }; } });

const NAME = { test: (s) => hasShape(s, isLowerAlpha, (c) => isLowerAlpha(c) || isDigit(c) || c === 95 || c === 46 || c === 45, { max: 59 }) };   // a scanner name: a-z first, then a-z 0-9 _ . -, at most 60
const STATUSES = new Set(["not_run", "no_detection", "detected", "error", "timeout"]);
/** The least verdict a scan status allows: nothing ran or it failed → at best a hold; a detection → block. */
const STATUS_FLOOR = Object.freeze({ not_run: "needs_sandbox", no_detection: "allow", detected: "block", error: "scan_failed", timeout: "scan_failed" });

/**
 * A scan result as the decision may trust it: the runScan shape, { verdict, reason_code, scan: { status, scanner } }, floored by
 * that block's own status and scanner, so a caller cannot hand decide() an `allow` next to status error, timeout, detected or
 * not_run, or next to the scanner "none". Anything without that shape (a bare { verdict, reason_code }, a missing or unknown
 * status, no scanner name) did not come from runScan and fails closed: scan_failed / could_not_check, a hold, never a pass.
 */
export function normaliseScan(x) {
  const bad = { verdict: "scan_failed", reason_code: "could_not_check" };
  if (!x || typeof x !== "object" || !x.scan || typeof x.scan !== "object") return bad;
  const st = x.scan.status;
  if (typeof st !== "string" || !Object.hasOwn(STATUS_FLOOR, st) || typeof x.scan.scanner !== "string" || !x.scan.scanner) return bad;
  const none = x.scan.scanner === "none";
  const verdict = worst(x.verdict, STATUS_FLOOR[st], none ? "needs_sandbox" : "allow");
  if (verdict === x.verdict) return x;
  const reason_code = verdict === "block" ? "malware_detected" : verdict === "scan_failed" ? "could_not_check" : "scanner_not_configured";
  return { ...x, verdict, reason_code };
}

const failed = (scanner, status, now, extra = {}) => ({
  verdict: "scan_failed", reason_code: "could_not_check",
  scan: { status, scanner: NAME.test(scanner?.name || "") ? scanner.name : "none", scanner_version: String(scanner?.version ?? "0").slice(0, 60), signature_db_version: null, scanned_at: now().toISOString(), third_party_consent_ref: scanner?.consentRef ?? null, ...extra },
});

/** Run a scanner and normalise its answer into { verdict, reason_code, scan } (the record's scan block). Never throws. */
export async function runScan(scanner, input, { timeoutMs = 30000, now = () => new Date() } = {}) {
  const s = scanner || NO_SCANNER;
  if (typeof s.scan !== "function" || !NAME.test(s.name || "")) return failed(s, "error", now);
  if (s.thirdParty && !s.consentRef) return failed(s, "error", now);   // a third party never sees a file without a recorded consent
  const ctl = new AbortController();
  let timer;
  let res;
  try {
    res = await Promise.race([
      Promise.resolve().then(() => s.scan({ ...input, signal: ctl.signal })),
      new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(Object.assign(new Error("timeout"), { code: "timeout" })); }, timeoutMs); }),
    ]);
  } catch (e) { return failed(s, e?.code === "timeout" ? "timeout" : "error", now); }
  finally { clearTimeout(timer); }
  const verdict = res?.verdict;
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) return failed(s, "error", now);   // clean, safe, true, undefined …
  const none = s === NO_SCANNER || s.name === "none";
  const status = STATUSES.has(res.status) ? res.status
    : verdict === "block" ? "detected" : verdict === "scan_failed" ? "error" : none ? "not_run" : "no_detection";
  // a scanner named none ran nothing, whatever it says: it can only add needs_sandbox or worse; a status of error, timeout or
  // detected forces a non-pass verdict whatever verdict came with it (a scanner that reports `allow` with status "error" did not check)
  const v = worst(verdict, none ? "needs_sandbox" : "allow", STATUS_FLOOR[status]);
  return {
    verdict: v,
    reason_code: v === "block" ? "malware_detected" : v === "scan_failed" ? "could_not_check" : none ? "scanner_not_configured" : v === "needs_sandbox" ? "needs_sandbox_review" : "none",
    scan: { status, scanner: s.name, scanner_version: String(s.version ?? "0").slice(0, 60), signature_db_version: res.signature_db_version ? String(res.signature_db_version).slice(0, 80) : null, scanned_at: none ? null : now().toISOString(), third_party_consent_ref: s.thirdParty ? s.consentRef : null },
  };
}
