// The scan interface requires an explicit verdict and never accepts "clean" or "safe"; the decision never invents a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScan, VERDICTS, NO_SCANNER, worst, SEVERITY } from "../src/scan.js";
import { decide } from "../src/decision.js";
import { TYPES, ALLOWABLE_TYPES } from "../src/sniff.js";

const NOW = () => new Date("2026-10-07T00:00:00Z");
const input = { bytes: new Uint8Array(3), sha256: "0".repeat(64), size: 3, sniffed: {}, form: "f" };
const scanner = (result, extra = {}) => ({ name: "fake-av", version: "1.2", scan: async () => result, ...extra });

test("the verdict list is exactly allow, allow_with_limits, needs_sandbox, block, scan_failed", () => {
  assert.deepEqual([...VERDICTS], ["allow", "allow_with_limits", "needs_sandbox", "block", "scan_failed"]);
  assert.ok(!VERDICTS.some((v) => /clean|safe/i.test(v)));
});

test("a valid verdict passes through with the scanner's name, version and database version", async () => {
  for (const verdict of VERDICTS) {
    const r = await runScan(scanner({ verdict, signature_db_version: "2026-10-06" }), input, { now: NOW });
    assert.equal(r.verdict, verdict);
    assert.equal(r.scan.scanner, "fake-av"); assert.equal(r.scan.scanner_version, "1.2"); assert.equal(r.scan.signature_db_version, "2026-10-06"); assert.equal(r.scan.scanned_at, "2026-10-07T00:00:00.000Z");
  }
  assert.equal((await runScan(scanner({ verdict: "block" }), input, { now: NOW })).reason_code, "malware_detected");
  assert.equal((await runScan(scanner({ verdict: "block" }), input, { now: NOW })).scan.status, "detected");
  assert.equal((await runScan(scanner({ verdict: "allow" }), input, { now: NOW })).scan.status, "no_detection");
});

test("anything that is not an explicit verdict is scan_failed: clean, safe, ok, pass, booleans, missing, wrong case", async () => {
  for (const bad of ["clean", "safe", "ok", "pass", "passed", "CLEAN", "Allow", "allowed", "", " allow", true, false, 1, 0, null, undefined, {}, ["allow"]]) {
    const r = await runScan(scanner({ verdict: bad }), input, { now: NOW });
    assert.equal(r.verdict, "scan_failed", JSON.stringify(bad));
    assert.equal(r.reason_code, "could_not_check");
  }
  for (const res of [undefined, null, "clean", true, {}, { status: "no_detection" }]) assert.equal((await runScan(scanner(res), input, { now: NOW })).verdict, "scan_failed", JSON.stringify(res));
});

test("a scanner that throws, rejects or times out is scan_failed (a block, never a pass)", async () => {
  const boom = { name: "boom", version: "1", scan: async () => { throw new Error("engine crashed"); } };
  assert.deepEqual((({ verdict, scan }) => [verdict, scan.status])(await runScan(boom, input, { now: NOW })), ["scan_failed", "error"]);
  const hang = { name: "hang", version: "1", scan: () => new Promise(() => {}) };
  const r = await runScan(hang, input, { now: NOW, timeoutMs: 20 });
  assert.deepEqual([r.verdict, r.scan.status], ["scan_failed", "timeout"]);
  const aborted = { name: "abort", version: "1", scan: ({ signal }) => new Promise((res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) };
  assert.equal((await runScan(aborted, input, { now: NOW, timeoutMs: 20 })).scan.status, "timeout");
});

test("a malformed scanner (no name, no scan function, a name with spaces) is scan_failed", async () => {
  for (const s of [{ version: "1", scan: async () => ({ verdict: "allow" }) }, { name: "x" }, { name: "Bad Name", version: "1", scan: async () => ({ verdict: "allow" }) }]) assert.equal((await runScan(s, input, { now: NOW })).verdict, "scan_failed");
});

test("a third-party scanner without a recorded consent never sees the file; with one, the reference is kept in the record", async () => {
  let called = 0;
  const tp = { name: "vendor-api", version: "3", thirdParty: true, scan: async () => { called++; return { verdict: "allow" }; } };
  assert.equal((await runScan(tp, input, { now: NOW })).verdict, "scan_failed"); assert.equal(called, 0);
  const ok = await runScan({ ...tp, consentRef: "DPA-2026-004" }, input, { now: NOW });
  assert.equal(ok.verdict, "allow"); assert.equal(ok.scan.third_party_consent_ref, "DPA-2026-004"); assert.equal(called, 1);
});

test("no scanner: the default is needs_sandbox with scanner none and status not_run, never an implicit pass", async () => {
  for (const s of [undefined, null, NO_SCANNER]) {
    const r = await runScan(s, input, { now: NOW });
    assert.equal(r.verdict, "needs_sandbox"); assert.equal(r.reason_code, "scanner_not_configured");
    assert.deepEqual([r.scan.scanner, r.scan.status, r.scan.scanned_at], ["none", "not_run", null]);
  }
  // a scanner called "none" that answers allow still cannot grant one
  const liar = { name: "none", version: "0", scan: async () => ({ verdict: "allow" }) };
  assert.equal((await runScan(liar, input, { now: NOW })).verdict, "needs_sandbox");
});

test("verdicts combine worst first", () => {
  assert.equal(worst("allow", "allow_with_limits"), "allow_with_limits");
  assert.equal(worst("allow_with_limits", "needs_sandbox", "allow"), "needs_sandbox");
  assert.equal(worst("needs_sandbox", "scan_failed"), "scan_failed");
  assert.equal(worst("scan_failed", "block", "allow"), "block");
  assert.deepEqual(Object.keys(SEVERITY).sort(), [...VERDICTS].sort());
});

/* ---------- decision ---------- */
const policy = (o = {}) => ({ id: "t-policy", allowed_types: [TYPES.pdf, TYPES.png, TYPES.text], max_bytes: 1000, on_needs_sandbox: "hold", ...o });
const sniffed = (o = {}) => ({ type: TYPES.pdf, family: "document", matches_declared: true, polyglot_suspect: false, ...o });
const tri = (verdict, reason_code = "none") => ({ verdict, reason_code });
/** A scan result in the runScan shape (decide() refuses anything else): the status and scanner a real run would carry for that verdict. */
const sc = (verdict, reason_code = "none") => ({ verdict, reason_code, scan: verdict === "block" ? { status: "detected", scanner: "fake-av" } : verdict === "scan_failed" ? { status: "error", scanner: "fake-av" } : verdict === "needs_sandbox" ? { status: "not_run", scanner: "none" } : { status: "no_detection", scanner: "fake-av" } });

test("edge refusals come first and store nothing: too large, a type the form does not allow, an archive", () => {
  const big = decide({ policy: policy(), size: 1001, sniffed: sniffed() });
  assert.deepEqual([big.verdict, big.reason_code, big.stage, big.store], ["block", "too_large", "rejected", false]);
  const type = decide({ policy: policy(), size: 10, sniffed: sniffed({ type: TYPES.html, family: "script" }) });
  assert.deepEqual([type.verdict, type.reason_code, type.stage], ["block", "type_not_allowed", "rejected"]);
  const exe = decide({ policy: policy({ allowed_types: [TYPES.pdf] }), size: 10, sniffed: sniffed({ type: "application/x-msdownload", family: "executable" }) });
  assert.equal(exe.reason_code, "type_not_allowed");
  const gz = decide({ policy: policy(), size: 10, sniffed: sniffed({ type: "application/gzip", family: "archive" }) });
  assert.equal(gz.reason_code, "archive_not_allowed");
  // a type outside ALLOWABLE_TYPES is never allowed even when a hand-written policy lists it
  assert.equal(decide({ policy: policy({ allowed_types: ["application/x-msdownload"] }), size: 10, sniffed: sniffed({ type: "application/x-msdownload" }) }).verdict, "block");
});

test("with no scanner the verdict is needs_sandbox and the form decides: hold, or release for download only", () => {
  const hold = decide({ policy: policy(), size: 10, sniffed: sniffed(), triage: tri("allow_with_limits"), scan: sc("needs_sandbox", "scanner_not_configured") });
  assert.deepEqual([hold.verdict, hold.stage, hold.limits], ["needs_sandbox", "held", []]);
  assert.equal(hold.reason_code, "scanner_not_configured");
  const rel = decide({ policy: policy({ on_needs_sandbox: "release_download_only" }), size: 10, sniffed: sniffed(), triage: tri("allow_with_limits"), scan: sc("needs_sandbox", "scanner_not_configured") });
  assert.deepEqual([rel.verdict, rel.stage, rel.limits], ["needs_sandbox", "released", ["download_only", "open_only_in_sandbox"]]);
});

test("allow_with_limits needs a scanner that said allow: limits by family; plain text can reach allow", () => {
  const doc = decide({ policy: policy(), size: 10, sniffed: sniffed(), triage: tri("allow_with_limits"), scan: sc("allow") });
  assert.deepEqual([doc.verdict, doc.stage, doc.limits], ["allow_with_limits", "released", ["download_only", "open_only_in_sandbox"]]);
  const img = decide({ policy: policy(), size: 10, sniffed: sniffed({ type: TYPES.png, family: "image" }), triage: tri("allow_with_limits"), scan: sc("allow") });
  assert.deepEqual(img.limits, ["reencode_before_inline", "no_inline_render"]);
  const txt = decide({ policy: policy(), size: 10, sniffed: sniffed({ type: TYPES.text, family: "text" }), triage: tri("allow"), scan: sc("allow") });
  assert.deepEqual([txt.verdict, txt.stage, txt.limits, txt.reason_code], ["allow", "released", [], "none"]);
});

test("the worst contribution wins and a block is kept in quarantine, a scan_failed is held", () => {
  const triBlock = decide({ policy: policy(), size: 10, sniffed: sniffed(), triage: tri("block", "active_content_found"), scan: sc("allow") });
  assert.deepEqual([triBlock.verdict, triBlock.reason_code, triBlock.stage, triBlock.store], ["block", "active_content_found", "blocked", true]);
  const scanBlock = decide({ policy: policy(), size: 10, sniffed: sniffed(), triage: tri("allow_with_limits"), scan: sc("block", "malware_detected") });
  assert.equal(scanBlock.reason_code, "malware_detected");
  const failed = decide({ policy: policy(), size: 10, sniffed: sniffed(), triage: tri("allow_with_limits"), scan: sc("scan_failed", "could_not_check") });
  assert.deepEqual([failed.verdict, failed.stage, failed.reason_code], ["scan_failed", "quarantined", "could_not_check"]);
  assert.equal(decide({ policy: policy(), size: 10, sniffed: sniffed({ polyglot_suspect: true }), triage: tri("allow_with_limits"), scan: sc("allow") }).reason_code, "polyglot_suspect");
  assert.equal(decide({ policy: policy(), size: 10, sniffed: sniffed({ matches_declared: false }), triage: tri("allow_with_limits"), scan: sc("allow") }).reason_code, "type_mismatch");
  // incomplete triage is needs_sandbox even with a scanner that allows
  assert.equal(decide({ policy: policy(), size: 10, sniffed: sniffed(), triage: tri("needs_sandbox", "could_not_check"), scan: sc("allow") }).verdict, "needs_sandbox");
});

test("no combination of inputs ever yields a verdict outside the list, and allow/allow_with_limits always needs a scanner allow", () => {
  const verdicts = VERDICTS;
  for (const t of verdicts) for (const s of [...verdicts, null]) for (const match of [true, false]) for (const poly of [true, false]) {
    const d = decide({ policy: policy(), size: 10, sniffed: sniffed({ matches_declared: match, polyglot_suspect: poly }), triage: tri(t), scan: s ? sc(s) : null });
    assert.ok(VERDICTS.includes(d.verdict));
    if (d.verdict === "allow" || d.verdict === "allow_with_limits") assert.ok(s === "allow" || s === "allow_with_limits", `${t}/${s}`);
    if (d.verdict === "allow" || d.verdict === "allow_with_limits") assert.ok(match && !poly);
  }
  assert.ok(ALLOWABLE_TYPES.length > 5);
});

test("a scanner status of error, timeout or detected forces a non-pass verdict whatever verdict the scanner reports; not_run is at best a hold", async () => {
  for (const [status, verdict, floor] of [["error", "allow", "scan_failed"], ["timeout", "allow_with_limits", "scan_failed"], ["error", "needs_sandbox", "scan_failed"], ["detected", "allow", "block"], ["detected", "allow_with_limits", "block"], ["not_run", "allow", "needs_sandbox"]]) {
    const r = await runScan(scanner({ verdict, status }), input, { now: NOW });
    assert.equal(r.verdict, floor, `${verdict} + ${status}`);
    assert.notEqual(r.reason_code, "none");
  }
  assert.equal((await runScan(scanner({ verdict: "allow", status: "no_detection" }), input, { now: NOW })).verdict, "allow");
});

test("decide() floors a runScan-shaped scan itself: a caller cannot hand it allow next to status error, detected or scanner none", async () => {
  const policy = { max_bytes: 1000, allowed_types: [TYPES.pdf], on_needs_sandbox: "hold" };
  const sniffed = { type: TYPES.pdf, family: "document", matches_declared: true };
  const triage = { verdict: "allow_with_limits", reason_code: "none" };
  const block = (scan) => decide({ policy, size: 10, sniffed, triage, scan });
  const blk = (status, scanner = "fake-av") => ({ verdict: "allow", reason_code: "none", scan: { status, scanner } });
  assert.equal(block(blk("error")).verdict, "scan_failed");
  assert.equal(block(blk("timeout")).verdict, "scan_failed");
  assert.equal(block(blk("detected")).verdict, "block");
  assert.equal(block(blk("no_detection", "none")).verdict, "needs_sandbox");
  assert.equal(block(blk("not_run")).verdict, "needs_sandbox");
  assert.equal(block(blk("bogus")).verdict, "scan_failed");
  assert.equal(block(blk("no_detection")).verdict, "allow_with_limits");
  // what runScan itself returns decides the same way
  assert.equal(block(await runScan(NO_SCANNER, input, { now: NOW })).verdict, "needs_sandbox");
});

test("decide() refuses a scan without the runScan shape: a bare { verdict, reason_code } is scan_failed / could_not_check and held, never a pass", () => {
  const policy = { max_bytes: 1000, allowed_types: [TYPES.pdf], on_needs_sandbox: "hold" };
  const sniffed = { type: TYPES.pdf, family: "document", matches_declared: true };
  const triage = { verdict: "allow_with_limits", reason_code: "none" };
  const good = { verdict: "allow", reason_code: "none", scan: { status: "no_detection", scanner: "fake-av" } };
  assert.equal(decide({ policy, size: 10, sniffed, triage, scan: good }).verdict, "allow_with_limits");
  for (const bare of [{ verdict: "allow", reason_code: "none" }, { verdict: "allow" }, { ...good, scan: {} }, { ...good, scan: { status: "no_detection" } }, { ...good, scan: { status: "no_detection", scanner: "" } }, { ...good, scan: { status: "clean", scanner: "fake-av" } }, { ...good, scan: "no_detection" }]) {
    const d = decide({ policy, size: 10, sniffed, triage, scan: bare });
    assert.deepEqual([d.verdict, d.reason_code, d.stage], ["scan_failed", "could_not_check", "quarantined"], JSON.stringify(bare));
  }
});
