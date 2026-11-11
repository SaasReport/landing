/**
 * @saasreport/core/media — project-neutral T=0 contract for audio, graphics, articles and short video.
 * PURE: no network, queue, D1, R2, filesystem, provider selection or implicit publishing.
 * Project-specific adapters render and observe artefacts; this boundary decides admissibility.
 */
export const MEDIA_KINDS = Object.freeze(["podcast", "infographic", "blog", "clip"]);
export const MEDIA_CONTRACT = "kit.media-bundle.v1";
const MIME = Object.freeze({
  podcast: ["audio/mpeg"],
  infographic: ["image/svg+xml", "image/png"],
  blog: ["text/html", "text/markdown"],
  clip: ["video/mp4", "video/webm"],
});
const HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const validIso = (s) => typeof s === "string" && ISO.test(s) && Number.isFinite(Date.parse(s));
const https = (s) => typeof s === "string" && /^https:\/\/[^\s/#?]+(?:[^\s]*)$/.test(s);
const nonempty = (s) => typeof s === "string" && !!s.trim();
const unique = (xs) => new Set(xs).size === xs.length;
function assert(ok, reason) { if (!ok) throw new TypeError("media contract: " + reason); }
function checkToken(value, name) { assert(TOKEN.test(value || ""), name + " must be a safe stable slug"); }
function checkSource(source, regulated) {
  assert(source && nonempty(source.ref), "source.ref required");
  assert(HEX.test(source.sha256 || ""), "source.sha256 must be sha256 hex");
  assert(validIso(source.verified_at), "source.verified_at must be a verified UTC instant");
  assert(Array.isArray(source.citations) && source.citations.length > 0, "verified citation required");
  for (const c of source.citations) {
    assert(c && nonempty(c.ref) && c.verified === true && https(c.url), "citation must have reference, HTTPS URL and verification");
  }
  if (regulated) {
    assert(source.review && source.review.state === "approved" && nonempty(source.review.reviewer) && validIso(source.review.at), "regulated media requires independent editorial approval");
  }
}
/** One content identity, FOUR independently addressable outputs. No Iran/OpenFinance-specific paths. */
export function planMediaBundle({ project, tenant, content_id, edition, title, locale, source,
                                  regulated = false, required_kinds = MEDIA_KINDS } = {}) {
  for (const [name, value] of Object.entries({ project, tenant, content_id, edition })) checkToken(value, name);
  assert(nonempty(title), "title required");
  assert(typeof locale === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(locale), "locale required");
  assert(typeof regulated === "boolean", "regulated must be a boolean");
  assert(Array.isArray(required_kinds) && required_kinds.length > 0 &&
    unique(required_kinds) && required_kinds.every((k) => MEDIA_KINDS.includes(k)), "invalid required_kinds");
  checkSource(source, regulated);
  const namespace = [tenant, project, content_id, edition].join("/");
  const key = namespace + "/" + source.sha256;
  const slots = required_kinds.map((kind) => Object.freeze({
    kind, slot_id: key + "/" + kind, prefix: namespace + "/" + kind + "/",
    accepted_media_types: MIME[kind].slice(), state: "planned-not-rendered",
  }));
  return Object.freeze({
    contract: MEDIA_CONTRACT, project, tenant, content_id, edition, title, locale,
    regulated, idempotency_key: key,
    source: Object.freeze({ ref: source.ref, sha256: source.sha256, verified_at: source.verified_at,
      citations: source.citations.map((c) => Object.freeze({ ref: c.ref, url: c.url, verified: true })),
      ...(regulated ? { review: { ...source.review } } : {}) }),
    required_kinds: Object.freeze(required_kinds.slice()), slots: Object.freeze(slots), state: "planned-not-published",
  });
}

/** Validate render + real remote delivery observations. All four are required unless an explicit policy says otherwise. */
export function assessMediaBundle(bundle, receipts = []) {
  assert(bundle?.contract === MEDIA_CONTRACT && bundle.state === "planned-not-published", "unknown or non-planned bundle");
  assert(Array.isArray(receipts), "receipts must be an array");
  const blockers = [], seen = new Set();
  const required = new Map(bundle.slots.map((slot) => [slot.kind, slot]));
  for (const receipt of receipts) {
    const kind = receipt?.kind;
    const slot = required.get(kind);
    if (!slot) { blockers.push({ kind: kind ?? "unknown", reason: "unexpected_kind" }); continue; }
    if (seen.has(kind)) { blockers.push({ kind, reason: "duplicate_receipt" }); continue; }
    seen.add(kind);
    const missing = [];
    if (receipt.slot_id !== slot.slot_id) missing.push("slot_identity_mismatch");
    if (receipt.source_sha256 !== bundle.source.sha256) missing.push("source_digest_mismatch");
    if (receipt.state !== "verified") missing.push("not_verified");
    if (!HEX.test(receipt.content_sha256 || "")) missing.push("missing_artifact_digest");
    if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0) missing.push("invalid_bytes");
    if (!slot.accepted_media_types.includes(receipt.media_type)) missing.push("wrong_media_type");
    if (!nonempty(receipt.storage_key) || !receipt.storage_key.startsWith(slot.prefix) ||
        receipt.storage_key.includes("..")) missing.push("cross_tenant_or_unsafe_storage");
    if (!https(receipt.url)) missing.push("missing_public_https_url");
    const ev = receipt.evidence || {};
    if (!validIso(ev.observed_at) || ev.http_status !== 200) missing.push("public_get_unverified");
    if (kind === "podcast") {
      if (!Number.isFinite(ev.duration_seconds) || ev.duration_seconds < 45 || ev.duration_seconds > 80) missing.push("audio_duration_out_of_range");
      if (!https(ev.transcript_url) || !https(ev.feed_url)) missing.push("audio_transcript_or_rss_missing");
      if (ev.range_status !== 206) missing.push("audio_byte_range_unverified");
    }
    if (kind === "infographic" && (!nonempty(ev.alt) || !ev.source_sha256 || ev.source_sha256 !== bundle.source.sha256)) missing.push("accessible_source_link_missing");
    if (kind === "blog" && (!https(ev.canonical_url) || !Number.isSafeInteger(ev.word_count) || ev.word_count < 1)) missing.push("canonical_blog_unverified");
    if (kind === "clip" && (!https(ev.captions_url) || !Number.isFinite(ev.duration_seconds) || ev.duration_seconds <= 0 || ev.range_status !== 206)) missing.push("clip_captions_or_byte_range_unverified");
    blockers.push(...missing.map((reason) => ({ kind, reason })));
  }
  for (const kind of required.keys()) if (!seen.has(kind)) blockers.push({ kind, reason: "missing_required_artifact" });
  return Object.freeze({ bundle_id: bundle.idempotency_key, expected: required.size, received: seen.size,
    ok: blockers.length === 0, status: blockers.length ? "blocked-not-published" : "observed-ready-for-promotion",
    blockers: Object.freeze(blockers), published: false });
}
