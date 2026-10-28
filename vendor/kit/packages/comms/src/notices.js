/**
 * Legal notices tailored to audience and jurisdiction: one base notice, plus optional blocks keyed by audience
 * (retail, professional, institutional) and by jurisdiction (IR, SA, AE, GB, EU, US, SG, MY, ID, or a project's
 * own code). The same data renders in the email footer (specs.js, the comms engine) and on a site's legal page
 * (@saasreport/site, page type "notices"). Pure: no I/O.
 *
 * A project's notices (comms config `legal.notices`, and the site page's `notices`):
 *   {
 *     audiences: ["institutional"],          // the audience blocks the project offers
 *     jurisdictions: ["GB", "AE"],          // the jurisdiction blocks it offers (drafts are not published, see below)
 *     default: { audiences: [], jurisdictions: [] },   // picked when a recipient or page picks nothing (kit: base only)
 *     values: { legal_entity, registration, registered_address, audience_gb, regulatory_statement_gb, … },
 *     status: { GB: "approved by counsel, 2027-01-15" },   // a jurisdiction's status once counsel has signed it off
 *     copy: { en: { base: { title, paragraphs }, audiences: { … }, jurisdictions: { … } } },   // project wording, over the kit's
 *   }
 *
 * Rules that keep a draft from being published:
 *   - Every jurisdiction block has a status; the kit's are all DRAFT_STATUS. A block whose status starts with
 *     "draft" is left out of specs and pages unless the caller passes { drafts: true } (previews only).
 *   - Text holds {{placeholders}}. {{brand}}, {{site}} and {{domain}} are filled from the config; legal_entity,
 *     registration and registered_address from legal.entity (unless they still start with TODO); the rest from
 *     `values`. A paragraph with an unfilled placeholder is left out ({ placeholders: "omit" }, the default) or
 *     kept with the placeholder visible ({ placeholders: "show" }, previews). noticeTodos() lists every one.
 */
import en from "./notices/en.js";
import fa from "./notices/fa.js";
import ar from "./notices/ar.js";

export const NOTICE_LIBRARY = { en, fa, ar };
export const AUDIENCES = ["retail", "professional", "institutional"];
export const JURISDICTIONS = ["IR", "SA", "AE", "GB", "EU", "US", "SG", "MY", "ID"];
export const DRAFT_STATUS = "draft — needs counsel review";
/** The status of each kit jurisdiction block: all drafts until a project records counsel's sign-off in `status`. */
export const JURISDICTION_STATUS = Object.fromEntries(JURISDICTIONS.map((c) => [c, DRAFT_STATUS]));

const PH = /\{\{([a-z0-9_]+)\}\}/g;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const langOf = (tag) => String(tag).split("-")[0].toLowerCase();
const isDraft = (status) => /^draft\b/i.test(String(status || ""));
const pick = (v, lang) => (isObj(v) ? v[lang] ?? v.default : v);
const unfilled = (v) => v == null || v === "" || /^TODO\b/.test(String(v));

/** The selection a recipient or page makes, normalised: { audiences: [], jurisdictions: [] } (base only by default). */
export function noticeSelection(notices = {}, selection) {
  const s = selection ?? notices.default ?? {};
  return { audiences: [...(s.audiences || [])], jurisdictions: [...(s.jurisdictions || [])].map((c) => String(c).toUpperCase()) };
}

/** A jurisdiction's status: the project's recorded status, or the kit's (a draft). */
export const jurisdictionStatus = (notices, code) => notices?.status?.[code] ?? JURISDICTION_STATUS[code] ?? null;

/** The wording of one block in one language: the project's copy over the kit's. */
function wording(notices, lang, kind, key) {
  const lib = NOTICE_LIBRARY[lang] || {};
  const own = notices?.copy?.[lang] || {};
  if (kind === "base") return own.base ?? lib.base;
  return own[kind]?.[key] ?? lib[kind]?.[key];
}

/** The page strings of a language (title, lead, labels), the project's over the kit's. */
export function noticePageStrings(notices, lang) {
  return { ...(NOTICE_LIBRARY[lang]?.page || NOTICE_LIBRARY.en.page), ...(notices?.copy?.[lang]?.page || {}) };
}

/** Problems with a project's notices for the given languages, as readable strings; [] when usable. */
export function checkNotices(notices, langs = ["en"]) {
  const out = [];
  if (notices == null) return out;
  if (!isObj(notices)) return ["notices: must be an object"];
  const ls = langs.map(langOf);
  for (const k of ["audiences", "jurisdictions"]) if (notices[k] != null && !Array.isArray(notices[k])) out.push(`notices.${k}: must be a list`);
  for (const a of notices.audiences || []) if (!AUDIENCES.includes(a) && !ls.every((l) => notices.copy?.[l]?.audiences?.[a])) out.push(`notices.audiences: "${a}" is not a kit audience (${AUDIENCES.join(", ")}) and has no copy`);
  for (const j of notices.jurisdictions || []) {
    if (!/^[A-Z]{2}$/.test(j)) out.push(`notices.jurisdictions: "${j}" must be a two-letter upper-case code`);
    if (!jurisdictionStatus(notices, j)) out.push(`notices.status.${j}: every jurisdiction block needs a status (e.g. "${DRAFT_STATUS}")`);
  }
  for (const l of ls) {
    if (!wording(notices, l, "base")) out.push(`notices.copy.${l}.base: no kit wording for "${l}"; give title and paragraphs`);
    for (const a of notices.audiences || []) if (!wording(notices, l, "audiences", a)) out.push(`notices.copy.${l}.audiences.${a}: missing`);
    for (const j of notices.jurisdictions || []) if (!wording(notices, l, "jurisdictions", j)) out.push(`notices.copy.${l}.jurisdictions.${j}: missing`);
  }
  const sel = noticeSelection(notices);
  for (const a of sel.audiences) if (!(notices.audiences || []).includes(a)) out.push(`notices.default.audiences: "${a}" is not offered in notices.audiences`);
  for (const j of sel.jurisdictions) if (!(notices.jurisdictions || []).includes(j)) out.push(`notices.default.jurisdictions: "${j}" is not offered in notices.jurisdictions`);
  for (const [k, v] of Object.entries(notices.values || {})) if (!/^[a-z0-9_]+$/.test(k)) out.push(`notices.values.${k}: placeholder names are lower_snake_case`);
  // The comms engine fills ${param} at send time; notice wording is fixed text, so it must not contain any.
  if (/\$\{/.test(JSON.stringify([notices.copy || {}, notices.values || {}]))) out.push("notices: wording and values must not contain ${…} (use {{placeholder}})");
  return out;
}

/** The placeholder values of one language: built-ins, the legal entity, then the project's values. */
export function noticeValues(notices, lang, { brand, site, entity = {} } = {}) {
  const v = {};
  if (brand) v.brand = pick(brand, lang);
  if (site) { v.site = site.replace(/\/$/, ""); v.domain = new URL(site).host; }
  const ent = { legal_entity: entity.name, registration: entity.registration, registered_address: entity.address };
  for (const [k, x] of Object.entries(ent)) if (!unfilled(pick(x, lang))) v[k] = pick(x, lang);
  for (const [k, x] of Object.entries(notices?.values || {})) if (!unfilled(pick(x, lang))) v[k] = pick(x, lang);
  return v;
}

/** Fill {{placeholders}} in one string: { text, missing: [names] }. Unfilled ones stay as {{name}}. */
export function fillNotice(text, values) {
  const missing = [];
  const out = String(text).replace(PH, (m, k) => (values[k] != null ? String(values[k]) : (missing.push(k), m)));
  return { text: out, missing };
}

/**
 * Every block the project offers, in one language, ready to render:
 *   [{ id, kind: "base" | "audience" | "jurisdiction", key, title, paragraphs: [string], status, draft, missing: [names] }]
 * Order: base, audiences (kit order), jurisdictions (the project's order). Draft jurisdictions are left out
 * unless { drafts: true }; paragraphs with unfilled placeholders unless { placeholders: "show" }.
 */
export function noticeBlocks(notices, lang, { brand, site, entity, drafts = false, placeholders = "omit" } = {}) {
  if (!notices) return [];
  const l = langOf(lang);
  const values = noticeValues(notices, l, { brand, site, entity });
  const make = (kind, key, w, status = null) => {
    if (!w) return null;
    const missing = [];
    const paragraphs = [];
    for (const p of w.paragraphs || []) {
      const f = fillNotice(p, values);
      missing.push(...f.missing);
      if (!f.missing.length || placeholders === "show") paragraphs.push(f.text);
    }
    if (!paragraphs.length) return null;
    const title = fillNotice(w.title || "", values).text;
    return { id: kind === "base" ? "base" : `${kind}-${key.toLowerCase()}`, kind, key, title, paragraphs, status, draft: isDraft(status), missing: [...new Set(missing)] };
  };
  const out = [make("base", "base", wording(notices, l, "base"))];
  const offered = [...(notices.audiences || [])].sort((a, b) => (AUDIENCES.indexOf(a) + 1 || 99) - (AUDIENCES.indexOf(b) + 1 || 99));
  for (const a of offered) out.push(make("audience", a, wording(notices, l, "audiences", a)));
  for (const j of notices.jurisdictions || []) {
    const status = jurisdictionStatus(notices, j);
    if (isDraft(status) && !drafts) continue;
    out.push(make("jurisdiction", j, wording(notices, l, "jurisdictions", j), status));
  }
  return out.filter(Boolean);
}

/** The blocks a recipient or page gets: the base, then the selected audiences and jurisdictions that are on offer. */
export function selectNotices(blocks, selection) {
  const s = noticeSelection({}, selection);
  return blocks.filter((b) => b.kind === "base"
    || (b.kind === "audience" && s.audiences.includes(b.key))
    || (b.kind === "jurisdiction" && s.jurisdictions.includes(b.key)));
}

/**
 * What the owner still has to provide, per language: [{ lang, block, placeholder }] for every unfilled placeholder
 * in an offered block (drafts included), plus [{ lang, block, status }] for every draft jurisdiction.
 */
export function noticeTodos(notices, langs = ["en"], ctx = {}) {
  const out = [];
  if (!notices) return out;
  for (const l of langs.map(langOf)) {
    for (const b of noticeBlocks(notices, l, { ...ctx, drafts: true, placeholders: "show" })) {
      for (const p of b.missing) out.push({ lang: l, block: b.id, placeholder: p });
      if (b.draft) out.push({ lang: l, block: b.id, status: b.status });
    }
  }
  return out;
}

/** Every placeholder name the kit's wording uses (the owner's checklist), sorted. */
export function noticePlaceholders(langs = Object.keys(NOTICE_LIBRARY)) {
  const names = new Set();
  const walk = (v) => { if (typeof v === "string") for (const m of v.matchAll(PH)) names.add(m[1]); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  for (const l of langs) { const { page, ...rest } = NOTICE_LIBRARY[l]; walk(rest); walk(page); }
  return [...names].sort();
}
