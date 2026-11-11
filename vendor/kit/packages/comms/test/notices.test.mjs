// Legal notices tailored to audience and jurisdiction: the kit's draft wording, the data model (base + audience and
// jurisdiction blocks), what is never published (draft jurisdictions, unfilled placeholders), the email footer
// (specs, compiler, engine) and the per-recipient pick.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTICE_LIBRARY, AUDIENCES, JURISDICTIONS, DRAFT_STATUS, JURISDICTION_STATUS, checkNotices, noticeBlocks, selectNotices,
  noticeTodos, noticePlaceholders, buildSpecs, renderPreviews, compileTemplate, engineRuntime, checkConfig,
} from "../src/index.js";
import { createCommsEngine } from "../workers/comms-engine/engine.js";
import sample from "../examples/saasreport/comms.config.js";

/** A right-to-left Persian variant of the sample, built in the test: the locale packs and notice wording are the kit's, the copy is the sample's English text under the `fa` key. */
const persian = (config) => {
  const loc = (v) => (v && typeof v === "object" && "en" in v ? { fa: v.en } : v);
  return {
    ...config, locales: ["fa-IR"], timeZone: "Asia/Tehran",
    brand: { ...config.brand, name: loc(config.brand.name), fonts: { fa: config.brand.fonts.en } },
    sender: { ...config.sender, name: loc(config.sender.name) },
    signature: loc(config.signature), preview: loc(config.preview),
    templates: config.templates.map((x) => ({ ...x, copy: { fa: x.copy.en } })),
  };
};
const fa = persian(sample);
import sampleAr from "../examples/saasreport-ar/comms.config.js";

const NOW = new Date("2026-09-30T12:00:00Z");
const withNotices = (config, notices) => ({ ...config, legal: { ...(config.legal || {}), notices } });

test("library: fa, en and ar wording for the base, every audience and every jurisdiction", () => {
  assert.deepEqual(AUDIENCES, ["retail", "professional", "institutional"]);
  assert.deepEqual(JURISDICTIONS, ["IR", "SA", "AE", "GB", "EU", "US", "SG", "MY", "ID"]);
  for (const [lang, lib] of Object.entries(NOTICE_LIBRARY)) {
    assert.ok(lib.base.title && lib.base.paragraphs.length >= 4, `${lang} base`);
    for (const a of AUDIENCES) assert.ok(lib.audiences[a].paragraphs.length, `${lang} ${a}`);
    for (const j of JURISDICTIONS) assert.ok(lib.jurisdictions[j].title && lib.jurisdictions[j].paragraphs.length, `${lang} ${j}`);
    assert.ok(!/\$\{/.test(JSON.stringify(lib)), `${lang}: no \${…}, which the engine would try to fill`);
  }
  assert.equal(NOTICE_LIBRARY.fa.dir, "rtl");
  assert.equal(NOTICE_LIBRARY.en.dir, "ltr");
});

test("library: the base says informational only, no advice (incl. Shariah), no offer, who it is for, data are examples", () => {
  const b = NOTICE_LIBRARY.en.base.paragraphs.join(" ");
  assert.match(b, /general information only/);
  assert.match(b, /not investment, financial, legal, tax or Shariah advice/);
  assert.match(b, /not an offer, invitation or solicitation/);
  assert.match(b, /are examples/);
  assert.match(b, /for people who build, test and run financial products/);
  assert.match(NOTICE_LIBRARY.fa.base.paragraphs.join(" "), /توصیه سرمایه‌گذاری، مالی، حقوقی، مالیاتی یا شرعی/);
});

test("library: fa wording as reviewed by the owner (contract carve-out, «حذف کنیم», natural and legal persons)", () => {
  const fa = NOTICE_LIBRARY.fa;
  const b = fa.base.paragraphs.join(" ");
  // «این‌که» with a ZWNJ: the owner's orthography (docs/PERSIAN.md, rule fa-in-ke-zwnj)
  assert.match(b, /^.*مگر این\u200cکه به طور مشخص و با صراحت در شرایط قرارداد ذکر شده باشد، این محتوا فناوری \{\{brand\}\}/);
  assert.match(b, /تغییر دهیم یا حذف کنیم\./);
  assert.match(fa.audiences.retail.paragraphs[0], /وضعیت مالی یا نیازهای اشخاص حقیقی و حقوقی تهیه شده است/);
  const all = JSON.stringify(fa);
  for (const old of ["جز در جایی", "برداریم", "نیازهای هیچ شخصی", "دمو"]) assert.ok(!all.includes(old), old);
  assert.doesNotMatch(all, /·\s*[۰-۹]|[۰-۹]\s*·/);
});

test("library: no regulatory claims; entity facts are placeholders; every jurisdiction is a draft needing counsel review", () => {
  const all = JSON.stringify(NOTICE_LIBRARY);
  for (const claim of [/\b(is|are) (authori[sz]ed|regulated|licensed|registered) (by|with)\b/i, /\bFCA\b|\bSEC\b|\bDFSA\b|\bMAS\b|\bCMA\b|\bSAMA\b|\bOJK\b/, /\bFSP No\b|\bAFSL\b/]) {
    assert.doesNotMatch(all, claim);
  }
  assert.equal(DRAFT_STATUS, "draft — needs counsel review");
  for (const j of JURISDICTIONS) assert.equal(JURISDICTION_STATUS[j], DRAFT_STATUS, j);
  assert.deepEqual(noticePlaceholders().filter((p) => !/^(audience|regulatory_statement)_/.test(p)), ["brand", "legal_entity", "registered_address", "registration"]);
  for (const j of JURISDICTIONS) for (const p of [`audience_${j.toLowerCase()}`, `regulatory_statement_${j.toLowerCase()}`]) assert.ok(noticePlaceholders().includes(p), p);
});

test("blocks: base only by default; the pick adds audiences (kit order) and published jurisdictions", () => {
  const n = { audiences: ["institutional", "retail"], jurisdictions: ["GB"], status: { GB: "approved by counsel" }, values: { audience_gb: "professional clients", regulatory_statement_gb: "Statement." } };
  const all = noticeBlocks(n, "en", { brand: "X", site: "https://x.example" });
  assert.deepEqual(all.map((b) => b.id), ["base", "audience-retail", "audience-institutional", "jurisdiction-gb"]);
  assert.deepEqual(selectNotices(all).map((b) => b.id), ["base"], "default: the base notice only");
  assert.deepEqual(selectNotices(all, { audiences: ["institutional"], jurisdictions: ["gb"] }).map((b) => b.id), ["base", "audience-institutional", "jurisdiction-gb"]);
  assert.match(all[0].paragraphs[0], /^The material from X /, "{{brand}} filled");
  assert.equal(all[3].draft, false);
  assert.equal(all[3].status, "approved by counsel");
});

test("never published: draft jurisdictions and paragraphs with unfilled placeholders (unless previewing)", () => {
  const n = { audiences: ["professional"], jurisdictions: ["AE", "SG"] };
  const pub = noticeBlocks(n, "en", { brand: "X" });
  assert.deepEqual(pub.map((b) => b.id), ["base", "audience-professional"], "draft jurisdictions are left out");
  assert.ok(!JSON.stringify(pub).includes("{{"), "no placeholder reaches a published block");
  assert.ok(!pub[0].paragraphs.some((p) => p.startsWith("Published by")), "the issuer line waits for the entity");
  const prev = noticeBlocks(n, "en", { brand: "X", drafts: true, placeholders: "show" });
  assert.deepEqual(prev.map((b) => b.id), ["base", "audience-professional", "jurisdiction-ae", "jurisdiction-sg"]);
  assert.ok(prev[2].draft && prev[2].status === DRAFT_STATUS);
  assert.match(prev[2].paragraphs.join(" "), /\{\{audience_ae\}\}/);
  const filled = noticeBlocks(n, "en", { brand: "X", entity: { name: "X Ltd", registration: "No. 1", address: "1 Road" } });
  assert.equal(filled[0].paragraphs.at(-1), "Published by X Ltd (No. 1), 1 Road.");
  const todo = noticeBlocks(n, "en", { brand: "X", entity: { name: "TODO: entity" } });
  assert.ok(!todo[0].paragraphs.some((p) => p.includes("TODO")), "TODO values count as unfilled");
});

test("todos: every unfilled placeholder and every draft status, per language", () => {
  const t = noticeTodos({ audiences: ["institutional"], jurisdictions: ["GB"] }, ["en", "fa"], { brand: "X" });
  assert.deepEqual(t.filter((x) => x.lang === "en").map((x) => x.placeholder || x.status), ["legal_entity", "registration", "registered_address", "audience_gb", "regulatory_statement_gb", DRAFT_STATUS]);
  assert.equal(t.filter((x) => x.lang === "fa").length, 6);
});

test("check: unknown audiences, bad codes, picks that are not offered, ${…} in wording", () => {
  assert.deepEqual(checkNotices({ audiences: ["professional"], default: { audiences: ["professional"] } }, ["en", "fa"]), []);
  const p = checkNotices({ audiences: ["vip"], jurisdictions: ["gb", "XX"], default: { audiences: ["retail"] }, copy: { en: { base: { title: "t", paragraphs: ["${x}"] } } } }, ["en"]);
  assert.ok(p.some((x) => /"vip" is not a kit audience/.test(x)));
  assert.ok(p.some((x) => /"gb" must be a two-letter upper-case code/.test(x)));
  assert.ok(p.some((x) => /notices\.status\.XX/.test(x)), "a project's own jurisdiction needs a status");
  assert.ok(p.some((x) => /default\.audiences: "retail" is not offered/.test(x)));
  assert.ok(p.some((x) => /must not contain \$\{…\}/.test(x)));
  assert.ok(checkNotices({ audiences: ["professional"] }, ["de"]).some((x) => /copy\.de\.base/.test(x)), "a language without kit wording needs its own");
  const bad = withNotices(sampleAr, { audiences: ["institutional"] });
  bad.templates = [{ ...bad.templates[0], notices: { audiences: ["retail"] } }];
  assert.ok(checkConfig(bad).some((x) => /notices\.audiences: "retail" is not offered/.test(x)));
});

test("without legal.notices the specs carry no notice blocks", () => {
  const t = buildSpecs(fa)["manifest.json"].templates[0];
  assert.equal(t.notice_blocks, undefined);
  assert.ok(!t.body_blocks.some((b) => b.startsWith("footer.notice.")));
});

test("email: the base notice sits above the legal footer; the template's default and the recipient's pick add blocks", () => {
  const c = withNotices(fa, { audiences: ["professional", "retail"], jurisdictions: ["IR"], default: { audiences: ["professional"] } });
  const specs = buildSpecs(c);
  const t = specs["manifest.json"].templates.find((x) => x.template_id === "saasreport.contact.ack.v1");
  assert.deepEqual(t.body_blocks, ["header.saasreport-mark", "body.contact", "footer.signature.saasreport", "footer.notice.saasreport.base", "footer.legal.saasreport"]);
  assert.deepEqual(t.notice_blocks, { base: "footer.notice.saasreport.base", audiences: { retail: "footer.notice.saasreport.audience.retail", professional: "footer.notice.saasreport.audience.professional" }, jurisdictions: {} }, "IR is a draft: not offered");
  assert.deepEqual(t.notice_default, { audiences: ["professional"], jurisdictions: [] });
  const ops = specs["manifest.json"].templates.find((x) => x.template_id.includes(".ops."));
  assert.equal(ops.notice_blocks, undefined, "internal alerts carry no notices");
  const blocks = new Map(specs["blocks.json"].blocks.map((b) => [b.block_id, b]));
  const params = { name: "سارا", reference: "REF-1", submitted_at: "امروز", fields_html: "", fields_text: "", product: "صکوک", year_fa: "۱۴۰۵", year_en: "۲۰۲۶" };
  const shell = engineRuntime(c).shells["fa-IR"];
  const compile = (notices) => compileTemplate({ template: t, blocks, links: new Map(specs["links.json"].links.map((l) => [l.link_id, l])), params, shell, notices });
  const def = compile();
  assert.ok(def.ok, JSON.stringify(def));
  assert.match(def.text, /اطلاعات مهم[\s\S]*برای متخصصان[\s\S]*این پیام به‌صورت خودکار/, "base, then the default audience, then the legal footer");
  assert.doesNotMatch(def.text, /برای عموم مخاطبان/);
  assert.match(def.html, /<td class="saasreport-foot" dir="rtl" style="[^"]*border-top:1px solid #[0-9A-Fa-f]{6};padding:22px 36px 8px;direction:rtl;text-align:right/, "RTL notice row");
  const retail = compile({ audiences: ["retail"] });
  assert.match(retail.text, /برای عموم مخاطبان/);
  assert.doesNotMatch(retail.text, /برای متخصصان/, "the recipient's pick replaces the default");
  assert.doesNotMatch(compile({}).text, /برای متخصصان|برای عموم مخاطبان/, "an empty pick: base only");
  const bad = compile({ jurisdictions: ["IR"] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "unknown_notice");
  assert.equal(bad.status, 400);
});

test("email previews: LTR English with drafts and placeholders shown only when asked", () => {
  const c = withNotices(sampleAr, { audiences: ["institutional"], jurisdictions: ["GB", "AE"] });
  const pub = renderPreviews(c, { now: NOW, notices: { audiences: ["institutional"] } }).find((p) => p.template_id === "saasreport.contact.ack.v1");
  assert.match(pub.text, /Important information[\s\S]*For institutions/);
  assert.doesNotMatch(pub.text + pub.html, /\{\{|United Kingdom|draft/);
  assert.match(pub.html, /border-top:1px solid #[0-9A-F]{6};padding:22px 36px 8px;direction:ltr;text-align:left/i);
  const ar = renderPreviews(c, { now: NOW }).find((p) => p.template_id === "saasreport.contact.ack.ar.v1");
  assert.match(ar.text, /معلومات مهمة/);
  assert.match(ar.html, /direction:rtl;text-align:right[^"]*"><p dir="rtl"[^>]*><strong[^>]*>معلومات مهمة/);
  const draft = renderPreviews(c, { now: NOW, drafts: true, placeholders: "show", notices: { jurisdictions: ["GB"] } }).find((p) => p.template_id === "saasreport.contact.ack.v1");
  assert.match(draft.text, /United Kingdom\nFor readers in the United Kingdom: this material is intended only for \{\{audience_gb\}\}/);
});

test("engine: a dispatch picks the recipient's notices; an unknown pick is a 400", async () => {
  const c = withNotices(sampleAr, { audiences: ["institutional", "professional"] });
  const specs = buildSpecs(c);
  const sent = [];
  const DB = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }) }) };   // an empty D1: no suppression rows
  const env = { DB, MAIL_SENDER: { fetch: async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ message_id: "m1" })); } } };
  // dispatch mechanics (the notice pick): the manifest without its forms, whose gate (templates only through submit) forms.test.mjs proves
  const { forms, owner, ...manifest } = specs["manifest.json"];
  const engine = createCommsEngine({ config: c, specs: { manifest, blocks: specs["blocks.json"], links: specs["links.json"], providers: specs["providers.json"] } });
  const body = { template_id: "saasreport.contact.ack.v1", to: ["a@example.com"], params: { name: "A", reference: "R", submitted_at: "now", fields_html: "", fields_text: "" } };
  const ok = await engine.dispatchCore({ ...body, notices: { audiences: ["institutional"] } }, env);
  assert.equal(ok.status, 200);
  assert.match(sent[0].text, /For institutions/);
  assert.doesNotMatch(sent[0].text, /For professional readers/);
  const bad = await engine.dispatchCore({ ...body, notices: { audiences: ["retail"] } }, env);
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.error, "unknown_notice");
});
