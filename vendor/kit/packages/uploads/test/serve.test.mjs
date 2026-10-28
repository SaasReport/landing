import { test } from "node:test";
import assert from "node:assert/strict";
import { serveHeaders, contentDisposition, signDownload, verifyDownload, downloadResponse, SERVE_CSP, memoryBucket } from "../src/index.js";
import { createHash } from "node:crypto";
import { enc } from "./fixtures.mjs";

const NOW = (s = 0) => () => new Date(Date.parse("2026-10-07T12:00:00Z") + s * 1000);
const SECRET = "0123456789abcdef-secret";

test("every download is an attachment with nosniff, a sandboxing CSP, no cache and a same-site resource policy", () => {
  const h = serveHeaders({ filename: "report.pdf", type: "application/pdf", size: 12 });
  assert.equal(h.get("content-type"), "application/pdf");
  assert.match(h.get("content-disposition"), /^attachment; filename="report\.pdf"; filename\*=UTF-8''report\.pdf$/);
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("content-security-policy"), SERVE_CSP); assert.match(SERVE_CSP, /^sandbox; default-src 'none'/);
  assert.equal(h.get("cache-control"), "private, no-store"); assert.equal(h.get("cross-origin-resource-policy"), "same-site"); assert.equal(h.get("content-length"), "12");
});

test("anything that could run in a browser is served as application/octet-stream, whatever the sniffed type says", () => {
  for (const type of ["text/html", "image/svg+xml", "application/xml", "application/javascript", "text/x-script", "application/x-httpd-php", "application/x-msdownload", "weird/thing", undefined]) {
    assert.equal(serveHeaders({ filename: "a", type, size: 1 }).get("content-type"), "application/octet-stream", String(type));
  }
  for (const type of ["image/png", "application/pdf", "text/plain", "application/json"]) assert.equal(serveHeaders({ filename: "a", type, size: 1 }).get("content-type"), type);
});

test("a hostile filename cannot break out of the header: quotes, CRLF, path, non-ASCII, RTL, percent", () => {
  for (const name of ['a".pdf', 'a"; filename="b.exe', "a\r\nSet-Cookie: x=1", "../../etc/passwd", "نامه.pdf", "a‮exe.pdf", "100%.pdf", "a'b(c)*.pdf"]) {
    const v = contentDisposition(name);
    assert.ok(!/[\r\n]/.test(v), name); assert.match(v, /^attachment; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9%._~-]*$/, `${JSON.stringify(name)} -> ${v}`);
    assert.doesNotThrow(() => serveHeaders({ filename: name, type: "text/plain", size: 1 }));
    assert.ok(!v.includes("/"), v);
  }
  assert.equal(contentDisposition("نامه.pdf").includes("filename*=UTF-8''%D9%86"), true);
});

test("signed download tokens: valid, tampered, expired, wrong subject, wrong secret, malformed", async () => {
  const token = await signDownload({ secret: SECRET, uploadId: "upl_" + "a".repeat(32), subject: "lead-1", ttlSeconds: 300, now: NOW() });
  assert.deepEqual(await verifyDownload({ secret: SECRET, token, subject: "lead-1", now: NOW(100) }), { ok: true, uploadId: "upl_" + "a".repeat(32), subject: "lead-1" });
  assert.equal((await verifyDownload({ secret: SECRET, token, subject: "lead-1", now: NOW(301) })).reason, "expired");
  assert.equal((await verifyDownload({ secret: SECRET, token, subject: "lead-2", now: NOW(1) })).reason, "wrong_subject");
  assert.equal((await verifyDownload({ secret: SECRET, token, subject: null, now: NOW(1) })).reason, "wrong_subject");
  assert.equal((await verifyDownload({ secret: "another-secret-value", token, subject: "lead-1", now: NOW(1) })).reason, "bad_signature");
  const [p, s] = token.split(".");
  const forged = `${Buffer.from(JSON.stringify({ u: "upl_" + "b".repeat(32), s: "lead-1", e: 9999999999 })).toString("base64url")}.${s}`;
  assert.equal((await verifyDownload({ secret: SECRET, token: forged, subject: "lead-1", now: NOW(1) })).reason, "bad_signature");
  for (const bad of ["", "abc", "a.b.c", `${p}.`, `.${s}`, null, undefined, `${p}.!!!`]) assert.equal((await verifyDownload({ secret: SECRET, token: bad, now: NOW(1) })).ok, false, String(bad));
  await assert.rejects(signDownload({ secret: "short", uploadId: "x" }), /16 characters/);
  const anon = await signDownload({ secret: SECRET, uploadId: "upl_" + "c".repeat(32), now: NOW() });
  assert.equal((await verifyDownload({ secret: SECRET, token: anon, now: NOW(1) })).ok, true);
});

const record = (o = {}) => ({ stage: "released", verdict: "allow_with_limits", size_bytes: 5, sha256: createHash("sha256").update("%PDF-").digest("hex"), declared: { filename_normalised: "doc.pdf" }, sniffed: { type: "application/pdf" }, storage: { released_key: "r/f/abc" }, ...o });
test("a released file is served as a download; anything else does not exist for the outside (404)", async () => {
  const bucket = memoryBucket(); await bucket.put("r/f/abc", enc("%PDF-"));
  const ok = await downloadResponse({ record: record(), bucket });
  assert.equal(ok.status, 200); assert.equal(await ok.text(), "%PDF-"); assert.match(ok.headers.get("content-disposition"), /^attachment;/);
  assert.equal((await downloadResponse({ record: record({ verdict: "needs_sandbox" }), bucket })).status, 200);
  assert.equal((await downloadResponse({ record: record({ verdict: "block" }), bucket })).status, 200, "the stage is the authority: only intake and a person's release() reach released");
  for (const r of [record({ stage: "held" }), record({ stage: "quarantined" }), record({ stage: "deleted" }), record({ stage: "blocked" }), record({ stage: "pending" }), record({ op: { action: "rescan", to: "held" } }), record({ storage: { released_key: null } }), record({ storage: { released_key: "r/f/missing" } }), null])
    assert.equal((await downloadResponse({ record: r, bucket })).status, 404, JSON.stringify(r)?.slice(0, 60));
});
