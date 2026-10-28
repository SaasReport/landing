import test from "node:test";
import assert from "node:assert/strict";
import { MEDIA_KINDS, MEDIA_CONTRACT, planMediaBundle, assessMediaBundle } from "../src/media.js";
const H = "a".repeat(64);
const V = "b".repeat(64);
const sample = (extra = {}) => ({
  project: "factory-os", tenant: "example-site", content_id: "asset-001", edition: "v1",
  title: "Explainer", locale: "fa-IR",
  source: { ref: "docs/verified/1", sha256: H, verified_at: "2026-10-25T10:00:00Z",
    citations: [{ ref: "official:1", url: "https://example.org/primary", verified: true }] },
  ...extra,
});
const receipts = (b) => b.slots.map((s) => ({
  kind: s.kind, slot_id: s.slot_id, source_sha256: H, content_sha256: V,
  bytes: 1024, media_type: s.accepted_media_types[0], storage_key: s.prefix + "rendered.bin",
  url: "https://media.example.org/rendered", state: "verified",
  evidence: { observed_at: "2026-10-25T10:10:00Z", http_status: 200,
    duration_seconds: 60, range_status: 206, transcript_url: "https://media.example.org/transcript",
    feed_url: "https://media.example.org/feed.xml", alt: "Description", source_sha256: H,
    canonical_url: "https://media.example.org/blog", word_count: 130,
    captions_url: "https://media.example.org/captions.vtt" },
}));
test("independent multi-project 4-kind plan with deterministic safe identifiers", () => {
  const a = planMediaBundle(sample());
  const b = planMediaBundle(sample());
  assert.deepEqual(a, b);
  assert.equal(a.contract, MEDIA_CONTRACT);
  assert.deepEqual(a.required_kinds, MEDIA_KINDS);
  assert.equal(a.slots.length, 4);
  assert.ok(a.slots.every((s) => s.prefix.startsWith("example-site/factory-os/")));
  assert.equal(a.state, "planned-not-published");
  assert.equal(a.slots[0].kind, "podcast");
});
test("no source verification or unapproved regulation produces a render plan", () => {
  assert.throws(() => planMediaBundle(sample({ source: { sha256: H } })), /source.ref/);
  assert.throws(() => planMediaBundle(sample({ regulated: true })), /editorial approval/);
  const approved = sample({ regulated: true });
  approved.source.review = { state: "approved", reviewer: "editor-001", at: "2026-10-25T10:02:00Z" };
  assert.equal(planMediaBundle(approved).regulated, true);
});
test("a missing derivative is BLOCKED even when podcast has been rendered", () => {
  const b = planMediaBundle(sample());
  const v = assessMediaBundle(b, receipts(b).slice(0, 3));
  assert.equal(v.ok, false);
  assert.equal(v.published, false);
  assert.deepEqual(v.blockers, [{ kind: "clip", reason: "missing_required_artifact" }]);
});
test("proven delivery evidence is ready for promotion but never claims live publication", () => {
  const b = planMediaBundle(sample());
  const v = assessMediaBundle(b, receipts(b));
  assert.equal(v.ok, true);
  assert.equal(v.status, "observed-ready-for-promotion");
  assert.equal(v.published, false);
});
test("cross-project R2 leak, wrong digest, missed range, duplicate and unknown kind are blocked", () => {
  const b = planMediaBundle(sample());
  const r = receipts(b);
  r[0].storage_key = "foreign/site/audio.mp3";
  r[1].source_sha256 = V;
  r[2].evidence.http_status = 500;
  r[3].evidence.range_status = 200;
  const v = assessMediaBundle(b, [...r, r[0], { kind: "unknown" }]);
  assert.equal(v.ok, false);
  assert.ok(v.blockers.some((x) => x.reason === "cross_tenant_or_unsafe_storage"));
  assert.ok(v.blockers.some((x) => x.reason === "source_digest_mismatch"));
  assert.ok(v.blockers.some((x) => x.reason === "public_get_unverified"));
  assert.ok(v.blockers.some((x) => x.reason === "clip_captions_or_byte_range_unverified"));
  assert.ok(v.blockers.some((x) => x.reason === "duplicate_receipt"));
  assert.ok(v.blockers.some((x) => x.reason === "unexpected_kind"));
});
test("restricted policy can't silently exclude all media types, duplicate or unsafe namespace", () => {
  assert.throws(() => planMediaBundle(sample({ required_kinds: [] })), /invalid required_kinds/);
  assert.throws(() => planMediaBundle(sample({ required_kinds: ["podcast", "podcast"] })), /invalid required_kinds/);
  assert.throws(() => planMediaBundle(sample({ tenant: "../another" })), /safe stable slug/);
  assert.equal(planMediaBundle(sample({ required_kinds: ["blog"] })).slots.length, 1);
});
