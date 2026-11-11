// The legal notices page (/legal/notices/): the same notices data as the email footer, per locale and direction,
// with only the blocks the page picks, and nothing that is a draft or has an unfilled placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildSite, checkProject } from "../src/index.js";
import sample from "../../../examples/site-sample/site.config.js";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
const withPage = (page) => ({ ...sample, pages: [...sample.pages.filter((p) => p.type !== "notices"), { type: "notices", path: "/legal/notices/", content: { en: {}, ar: {} }, ...page }] });

test("the sample's notices page: en LTR and ar RTL, base + the professional block, alternates and a switch", () => {
  const { files, sitemap } = buildSite(sample, { root: SAMPLE });
  const en = files["legal/notices/index.html"], ar = files["ar/legal/notices/index.html"];
  assert.match(en, /<html lang="en" dir="ltr">/);
  assert.match(ar, /<html lang="ar" dir="rtl">/);
  assert.match(en, /<h1>Legal notices<\/h1>/);
  assert.match(en, /<section class="lg-block lg-block--base" id="base"[\s\S]*<h2 id="base-t">Important information<\/h2>/);
  assert.match(en, /id="audience-professional"[\s\S]*For professional readers/);
  assert.doesNotMatch(en, /For institutions|For the general public/, "only the picked audience");
  assert.match(ar, /<h2 id="base-t">معلومات مهمة<\/h2>/);
  assert.match(ar, /للقرّاء المهنيين/);
  assert.match(en, /<link rel="alternate" hreflang="ar" href="https:\/\/example\.org\/ar\/legal\/notices\/">/);
  assert.match(en, /<a class="btn btn--ghost btn--sm" href="\/ar\/legal\/notices\/" hreflang="ar" lang="ar"[^>]*>العربية<\/a>/);
  assert.match(en, /<link rel="stylesheet" href="\/pages\.css\?v=[a-f0-9]{10}">/);
  assert.match(en, /<meta name="twitter:card" content="summary_large_image">/, "social card like the other inner pages");
  for (const html of [en, ar]) {
    assert.doesNotMatch(html, /\{\{|lg-draft|lg-ph/, "nothing unfilled, nothing draft");
    assert.doesNotMatch(html, /authori[sz]ed|regulated by|licensed by/i, "no regulatory claims");
    assert.deepEqual([...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1].trim()), ['type="application/ld+json"'], "CSP: no inline scripts but JSON-LD");
  }
  assert.ok(sitemap.some((u) => u.loc === "https://example.org/legal/notices/"));
});

test("pages pick their blocks; drafts and placeholders appear only in an explicit preview (noindex)", () => {
  const notices = { audiences: ["retail", "institutional"], jurisdictions: ["GB"] };
  const pub = buildSite(withPage({ notices, select: { audiences: ["institutional"], jurisdictions: ["GB"] } }), { root: SAMPLE }).files["legal/notices/index.html"];
  assert.match(pub, /For institutions/);
  assert.doesNotMatch(pub, /United Kingdom|For the general public/, "a draft jurisdiction is not published even when picked");
  assert.match(pub, /<meta name="robots" content="index, follow">/);
  const prev = buildSite(withPage({ notices, select: { jurisdictions: ["GB"] }, drafts: true, placeholders: "show" }), { root: SAMPLE }).files["legal/notices/index.html"];
  assert.match(prev, /<span class="lg-draft">Draft: needs counsel review<\/span>/);
  assert.match(prev, /<mark class="lg-ph" dir="ltr">\{\{audience_gb\}\}<\/mark>/);
  assert.match(prev, /<meta name="robots" content="noindex, nofollow">/);
  const ent = buildSite(withPage({ notices, entity: { name: "Example Ltd", registration: "No. 1", address: "1 Road" } }), { root: SAMPLE }).files["legal/notices/index.html"];
  assert.match(ent, /Published by Example Ltd \(No\. 1\), 1 Road\./);
  assert.doesNotMatch(ent, /id="lg-toc-t"/, "base only: no table of contents");
});

test("check: the notices data is required and the page may only pick offered blocks", () => {
  const p = checkProject(withPage({ notices: { audiences: ["retail"] }, select: { audiences: ["institutional"] } }));
  assert.ok(p.some((x) => /\(notices\): select\.audiences: "institutional" is not offered/.test(x)));
  assert.ok(checkProject(withPage({})).some((x) => /\(notices\): notices: the project's notices data is required/.test(x)));
});
