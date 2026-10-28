/**
 * Portable deterministic content derivatives (NOT the audio/video encoders).
 * Only supplied, evidence-linked fact strings are rendered. No LLM/network/fonts.
 * Audio is encoded by @saasreport/podcast; MP4/WebM by an injected approved adapter.
 */
import { sha256 } from "./sha256.js";
import { MEDIA_CONTRACT } from "./media.js";

const text = (s) => typeof s === "string" && !!s.trim();
const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const BCP = /^(fa|ar)(-|$)/i;
function assert(x, why) { if (!x) throw new TypeError("media derivative: " + why); }
function check(bundle, facts) {
  assert(bundle?.contract === MEDIA_CONTRACT, "canonical bundle required");
  assert(Array.isArray(facts) && facts.length > 0 && facts.length <= 5, "1-5 verified facts required");
  const allowed = new Set(bundle.source.citations.map((c) => c.ref));
  for (const f of facts) {
    assert(text(f?.heading) && text(f.text) && [...f.heading].length <= 65 &&
      [...f.text].length <= 240, "fact heading or body invalid");
    assert(Array.isArray(f.citations) && f.citations.length &&
      f.citations.every((id) => allowed.has(id)), "fact citation missing or not in reviewed source");
  }
}
function splitLine(value, max = 45) {
  const words = value.split(/\s+/).filter(Boolean), lines = [], out = [];
  for (const word of words) {
    if ([...word].length > max) {
      if (out.length) { lines.push(out.join(" ")); out.length = 0; }
      for (let i = 0; i < [...word].length; i += max) lines.push([...word].slice(i, i + max).join(""));
      continue;
    }
    if ([...([...out, word].join(" "))].length > max) { lines.push(out.join(" ")); out.length = 0; }
    out.push(word);
  }
  if (out.length) lines.push(out.join(" "));
  return lines;
}
function seconds(s) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, n = Math.floor(ms / 1000) % 60;
  return [h,m,n].map((a) => String(a).padStart(2, "0")).join(":") + "." + String(ms % 1000).padStart(3,"0");
}
export function renderMediaDerivatives(bundle, facts, { theme, clipSeconds = 45 } = {}) {
  check(bundle, facts);
  assert(theme && ["primary", "surface", "subtle"].every((role) => /^#[a-fA-F0-9]{6}$/.test(theme[role] || "")), "resolved canonical theme tokens required");
  const colour = theme.primary;
  assert(Number.isInteger(clipSeconds) && clipSeconds >= 10 && clipSeconds <= 180, "clip length 10-180s required");
  const rtl = BCP.test(bundle.locale), dir = rtl ? "rtl" : "ltr";
  const safeFacts = facts.map((f) => ({ heading: f.heading.trim(), text: f.text.trim(),
    citations: [...new Set(f.citations)].sort() }));
  const refs = bundle.source.citations.map((c) =>
    '<li><a href="' + xml(c.url) + '" rel="noopener noreferrer">' + xml(c.ref) + "</a></li>").join("");
  const html = '<!doctype html>\n<html lang="' + xml(bundle.locale) + '" dir="' + dir +
    '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + xml(bundle.title) + '</title></head><body><main><article><h1>' + xml(bundle.title) +
    '</h1>' + safeFacts.map((f) => '<section><h2>' + xml(f.heading) + '</h2><p>' + xml(f.text) +
      '</p><small>' + f.citations.map(xml).join(", ") + '</small></section>').join("") +
    '</article><aside><h2>Sources</h2><ul>' + refs + '</ul></aside></main></body></html>\n';
  const width = 1080, pad = 70, lineHeight = 38;
  const blocks = [];
  let y = 190;
  for (const f of safeFacts) {
    blocks.push('<text x="' + (rtl ? width - pad : pad) + '" y="' + y + '" text-anchor="' +
      (rtl ? "end" : "start") + '" font-size="34" font-weight="700">' + xml(f.heading) + '</text>');
    y += 56;
    for (const line of splitLine(f.text, 49)) {
      blocks.push('<text x="' + (rtl ? width - pad : pad) + '" y="' + y + '" text-anchor="' +
        (rtl ? "end" : "start") + '" font-size="26">' + xml(line) + '</text>');
      y += lineHeight;
    }
    y += 48;
  }
  const height = y + 115;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height +
    '" role="img" lang="' + xml(bundle.locale) + '" direction="' + dir + '">' +
    '<title>' + xml(bundle.title) + '</title><desc>Verified source: ' + xml(bundle.source.ref) +
    '</desc><rect width="100%" height="100%" fill="' + theme.surface + '"/>' +
    '<rect width="100%" height="22" fill="' + colour + '"/>' +
    '<g fill="' + colour + '" font-family="system-ui, sans-serif" direction="' + dir + '">' +
    '<text x="' + (rtl ? width - pad : pad) + '" y="105" font-size="46" font-weight="700" text-anchor="' +
    (rtl ? "end" : "start") + '">' + xml(bundle.title) + '</text>' + blocks.join("") + '</g>' +
    '<text x="' + (rtl ? width - pad : pad) + '" y="' + (height - 48) +
    '" font-family="system-ui, sans-serif" font-size="20" fill="' + theme.subtle + '" text-anchor="' +
    (rtl ? "end" : "start") + '">' + xml(bundle.source.ref) + '</text></svg>\n';
  const step = clipSeconds / safeFacts.length;
  const storyboard = safeFacts.map((f, i) => ({
    scene: i + 1, starts_at_seconds: +(i * step).toFixed(3),
    ends_at_seconds: +((i + 1) * step).toFixed(3), title: f.heading,
    subtitle: f.text, source_citations: f.citations,
  }));
  const captions = "WEBVTT\n\n" + storyboard.map((scene) => seconds(scene.starts_at_seconds) +
    " --> " + seconds(scene.ends_at_seconds) + "\n" + scene.title + "\n" + scene.subtitle).join("\n\n") + "\n";
  return Object.freeze({
    bundle_id: bundle.idempotency_key, locale: bundle.locale, source_sha256: bundle.source.sha256,
    blog: Object.freeze({ media_type: "text/html", body: html, sha256: sha256(html), state: "rendered-unpublished" }),
    infographic: Object.freeze({ media_type: "image/svg+xml", body: svg, sha256: sha256(svg), alt: bundle.title, state: "rendered-unpublished" }),
    clip: Object.freeze({ storyboards: storyboard, captions, captions_sha256: sha256(captions),
      desired_seconds: clipSeconds, state: "storyboard-needs-video-provider" }),
    podcast: Object.freeze({ state: "needs-reviewed-script-and-tts" }),
    published: false,
  });
}
