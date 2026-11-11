/**
 * The per-project comms config: normalised with defaults, and checked. See README.md for the full shape.
 */
import fa from "./locales/fa.js";
import en from "./locales/en.js";
import ar from "./locales/ar.js";
import { checkNotices, noticeSelection } from "./notices.js";
import { fillOn, ensureContrast, contrast } from "@saasreport/core/colour";
import { OWNER_SECRET_NAMES } from "@saasreport/core/form-deliveries";

export const LOCALE_PACKS = { fa, en, ar };

/** Neutral defaults; a project sets its own brand colours (or derives them with colorsFromTokens). */
export const DEFAULT_COLORS = {
  ink: "#111111", accent: "#1D4ED8", muted: "#666666", rail: "#BDBDBD", line: "#E5E5E5",
  background: "#FAFAFA", card: "#FFFFFF", pill: "#EFF6FF", pillBorder: "#C6D4F6", onInk: "#FFFFFF",
};

/** WCAG contrast of two #RRGGBB colours (short forms are expanded): the one formula of @saasreport/core/colour. */
const long = (h) => (/^#[0-9a-f]{3}$/i.test(h) ? "#" + h.slice(1).split("").map((c) => c + c).join("") : h);
export const emailContrast = (a, b) => contrast(long(a), long(b));

/**
 * The text roles of an email. Mail clients read no custom properties, so they are inline values, but the derivation is the ONE of
 * @saasreport/core/colour (the site's): accentText and onAccent are the colours @saasreport/site derives from the same tokens, handed in
 * with them (colorsFromTokens({ color: colorRoles(tokens.color) })); a config that names an accent without them gets them from the
 * same functions (fillOn for the text on the accent, ensureContrast for the accent's text on the page, the card and the pill), so
 * a bright accent still reads. emailContrastProblems holds every pair to AA either way.
 */
export function emailRoles(c) {
  const hex = { ink: long(c.ink), onInk: long(c.onInk || c.ink) };
  const onAccent = c.onAccent || (c.accent ? fillOn(hex, long(c.accent)) : hex.onInk);
  const accentText = c.accentText || (c.accent ? ensureContrast(long(c.accent), [c.background, c.card, c.pill].filter(Boolean).map(long), 4.5, hex.ink) : hex.ink);
  return { onAccent, accentText };
}

/** Email contrast problems (WCAG AA 4.5:1 for text): [message]. */
export function emailContrastProblems(c, where = "brand.colors") {
  const pairs = [["ink", "background"], ["ink", "card"], ["ink", "pill"], ["muted", "background"], ["muted", "card"], ["accentText", "background"], ["accentText", "card"], ["onAccent", "accent"], ["onInk", "ink"]];
  return pairs.filter(([f, b]) => c[f] && c[b]).map(([f, b]) => [f, b, emailContrast(c[f], c[b])]).filter(([, , r]) => r < 4.5).map(([f, b, r]) => `${where}.${f} on ${b}: ${r.toFixed(2)}:1, below the 4.5:1 an email text needs (WCAG AA)`);
}

export const DEFAULT_FONT = { stack: "Arial,'Segoe UI',Tahoma,sans-serif", faces: [] };

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export const langOf = (tag) => String(tag).split("-")[0].toLowerCase();


/**
 * Email colours from @saasreport/site design tokens ({ color: { accent, ink, muted, rail, line, bg, surface, accentTint } }),
 * so the emails match the site. Explicit `brand.colors` in the comms config still win.
 */
export function colorsFromTokens(tokens = {}) {
  const t = tokens.color || tokens;
  const out = {};
  if (t.ink) out.ink = t.ink;
  if (t.accent) out.accent = t.accent;
  if (t.pillBorder) out.pillBorder = t.pillBorder;   // derived by @saasreport/site (colorRoles), like accentText and onAccent
  if (t.muted) out.muted = t.muted;
  if (t.rail) out.rail = t.rail;
  if (t.line) out.line = t.line;
  if (t.bg) out.background = t.bg;
  if (t.surface) out.card = t.surface;
  if (t.accentTint) out.pill = t.accentTint;
  if (t.onInk) out.onInk = t.onInk;
  // the site's derivation, passed in with the tokens (derived roles included): one source for accentText and onAccent
  if (t.accentText) out.accentText = t.accentText;
  if (t.onAccent) out.onAccent = t.onAccent;
  return out;
}

const withRoles = (c) => ({ ...c, ...emailRoles(c) });

/** Fill defaults and derive per-locale values. Throws if checkConfig finds problems. */
export function resolveConfig(config) {
  const problems = checkConfig(config);
  if (problems.length) throw new Error(`comms config:\n  - ${problems.join("\n  - ")}`);
  const locales = config.locales.map((tag) => {
    const lang = langOf(tag);
    const pack = { ...LOCALE_PACKS[lang], ...(config.packs?.[lang] || {}) };
    const fonts = { ...DEFAULT_FONT, ...(config.brand.fonts?.[lang] || config.brand.fonts?.default || {}) };
    return { tag, lang, pack, dir: pack.dir, fonts };
  });
  const site = config.site.replace(/\/$/, "");
  return {
    ...config,
    site,
    locales,
    primary: locales[0],
    idPrefix: config.idPrefix,
    cssPrefix: config.cssPrefix || config.idPrefix,
    domain: config.brand.domain || new URL(site).host,
    colors: withRoles({ ...DEFAULT_COLORS, ...(config.brand.colors || {}) }),
    links: { contact: `${site}/#contact`, ...(config.links || {}) },
    timeZone: config.timeZone || "UTC",
    legalEntity: config.legal?.entity || {},
    manifest: {
      version: "1.0", schema: "kit.comms.manifest.v1", constitutionRef: "constitution/38-COMMS-RAIL.md",
      retryPolicy: "exponential.3x", ttlSeconds: 300,
      frameworkRefs: { ack: ["iso-27001.a-13-2-1"], ops: ["iso-27001.a-13-2-1"] },
      suppress: { ack: ["hard-bounce", "complaint", "dsar-erasure"], ops: ["hard-bounce"] },
      ...(config.manifest || {}),
    },
    ops: config.ops || [],
    // the declared forms and their owner (kit.forms-config.v1): checkConfig has refused a config with templates and no owner
    forms: config.forms ? { owner: { ...config.forms.owner, address: String(config.forms.owner.address).toLowerCase() }, declared: config.forms.declared || (config.templates || []).map((t) => t.key) } : null,
  };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

/** Problems with a comms config, as readable strings; [] when it is usable. */
export function checkConfig(c) {
  const out = [];
  if (!isObj(c)) return ["config must be an object"];
  if (!/^[a-z0-9-]+$/.test(c.project || "")) out.push("project: lower-case worker name prefix (e.g. my-site), required");
  // Worker deployment identity is separate from business project/tenant identity.
  if (c.workers?.namePrefix != null &&
      !/^[a-z][a-z0-9-]{1,30}$/.test(c.workers.namePrefix))
    out.push("workers.namePrefix: lowercase deployment prefix, 2..31 chars, required when overridden");
  if (!/^[a-z0-9]+$/.test(c.idPrefix || "")) out.push("idPrefix: short lower-case id prefix for templates and audit events (e.g. saasreport), required");
  try { new URL(c.site); } catch { out.push("site: absolute https URL, required"); }
  if (!Array.isArray(c.locales) || !c.locales.length) out.push("locales: non-empty list of locale tags, the first is primary");
  const langs = (c.locales || []).map(langOf);
  for (const l of langs) if (!LOCALE_PACKS[l] && !c.packs?.[l]?.legal) out.push(`locales: no locale pack for "${l}" (built in: fa, en, ar; or give packs.${l})`);
  if (!isObj(c.brand)) out.push("brand: required");
  else for (const l of langs) if (!c.brand.name?.[l]) out.push(`brand.name.${l}: required`);
  if (isObj(c.brand)) out.push(...emailContrastProblems(withRoles({ ...DEFAULT_COLORS, ...(c.brand.colors || {}) })));   // email text is held to AA like the site's (docs/COLOUR.md)
  if (!EMAIL.test(c.sender?.address || "")) out.push("sender.address: the allowed sender address, required");
  if (c.sender?.replyTo && !EMAIL.test(c.sender.replyTo)) out.push("sender.replyTo: must be an email address");
  if (!c.manifest?.adopted) out.push("manifest.adopted: the date the template registry was adopted (YYYY-MM-DD), required");
  const keys = new Set();
  for (const [i, t] of (c.templates || []).entries()) {
    const at = `templates[${i}]${t?.key ? ` (${t.key})` : ""}`;
    if (!/^[a-z0-9-]+$/.test(t?.key || "")) { out.push(`${at}.key: required, lower-case`); continue; }
    if (keys.has(t.key)) out.push(`${at}.key: duplicate`);
    keys.add(t.key);
    for (const l of langs) {
      const cp = t.copy?.[l];
      if (!cp) { out.push(`${at}.copy.${l}: required`); continue; }
      for (const f of ["subject", "preheader", "title"]) if (!cp[f]) out.push(`${at}.copy.${l}.${f}: required`);
      if (!Array.isArray(cp.intro) || !cp.intro.length) out.push(`${at}.copy.${l}.intro: list of paragraphs, required`);
      if (!Array.isArray(cp.steps) || !cp.steps.length) out.push(`${at}.copy.${l}.steps: list of next steps, required`);
    }
    if (t.unsubscribe && !c.links?.unsubscribe) out.push(`${at}.unsubscribe: needs links.unsubscribe`);
    if (t.notices) {
      if (!c.legal?.notices) out.push(`${at}.notices: needs legal.notices`);
      const sel = noticeSelection({}, t.notices);
      for (const a of sel.audiences) if (!(c.legal?.notices?.audiences || []).includes(a)) out.push(`${at}.notices.audiences: "${a}" is not offered in legal.notices.audiences`);
      for (const j of sel.jurisdictions) if (!(c.legal?.notices?.jurisdictions || []).includes(j)) out.push(`${at}.notices.jurisdictions: "${j}" is not offered in legal.notices.jurisdictions`);
    }
  }
  if (!(c.templates || []).length) out.push("templates: at least one acknowledgement template");
  if (c.legal?.notices) out.push(...checkNotices(c.legal.notices, langs).map((q) => `legal.${q}`));
  for (const [i, o] of (c.ops || []).entries()) if (!/^[a-z0-9-]+$/.test(o?.key || "")) out.push(`ops[${i}].key: required`);
  out.push(...formsProblems(c, keys));
  return out;
}

/**
 * The forms block (kit.forms-config.v1, docs/FORMS.md): every form a config declares is delivered twice by the comms engine, the
 * submitter's receipt and the owner's notification, so a config with forms must name the owner's ops template and the engine secret
 * that holds the owner's recipients. Refused here, when the specs are built (npm run comms:check), never discovered at run time.
 */
function formsProblems(c, templateKeys) {
  if (!(c.templates || []).length) return [];
  const f = c.forms;
  if (!isObj(f) || !isObj(f.owner)) return ["forms.owner: required: every form notifies its owner (forms: { owner: { template: <ops key>, secret: \"OPS_NOTIFY_TO\" } }, kit.forms-config.v1)"];
  const out = [];
  for (const k of Object.keys(f)) if (!["owner", "declared"].includes(k)) out.push(`forms.${k}: unknown (owner, declared)`);
  for (const k of Object.keys(f.owner)) if (!["template", "secret", "address"].includes(k)) out.push(`forms.owner.${k}: unknown (template, secret, address)`);
  // one address per project, its own info@ (owner, 2026-10-13): Email Routing forwards it to the owner, so the zone owns the destination
  // an invalid site is reported by its own check above; here it only means there is no domain to compare with
  const domain = c.brand?.domain || (URL.canParse(String(c.site)) ? new URL(c.site).host : "");
  const want = `info@${String(domain).toLowerCase()}`;
  if (String(f.owner.address || "").toLowerCase() !== want) out.push(`forms.owner.address: must be the project's own ${want} (got "${f.owner.address ?? ""}")`);
  const ops = new Set((c.ops || []).map((o) => o?.key));
  if (!ops.has(f.owner.template)) out.push(`forms.owner.template: "${f.owner.template ?? ""}" is not an ops key (${[...ops].join(", ") || "no ops declared"})`);
  if (!OWNER_SECRET_NAMES.includes(f.owner.secret)) out.push(`forms.owner.secret: the comms-engine secret NAME that holds the owner's recipients, one of ${OWNER_SECRET_NAMES.join(", ")} (kit.forms-config.v1), required`);
  if (f.declared !== undefined) {
    if (!Array.isArray(f.declared) || !f.declared.length) out.push("forms.declared: a non-empty list of form ids (default: every template)");
    else {
      if (new Set(f.declared).size !== f.declared.length) out.push("forms.declared: duplicate form id");
      for (const id of f.declared) if (!templateKeys.has(id)) out.push(`forms.declared: "${id}" has no acknowledgement template (templates[].key)`);
      // every acknowledgement template is a form the site may post: one left out of `declared` would be refused by the engine (404)
      for (const key of templateKeys) if (!f.declared.includes(key)) out.push(`forms.declared: template "${key}" is not declared as a form: every acknowledgement template is a form (leave \`declared\` out to declare them all)`);
    }
  }
  return out;
}

/** Every string in the config that still starts with TODO, as [path, value] pairs: what a project must still fill in. */
export function todos(config, path = "") {
  const out = [];
  if (typeof config === "string") { if (/^TODO\b/.test(config)) out.push([path, config]); return out; }
  if (Array.isArray(config)) config.forEach((v, i) => out.push(...todos(v, `${path}[${i}]`)));
  else if (isObj(config)) for (const [k, v] of Object.entries(config)) out.push(...todos(v, path ? `${path}.${k}` : k));
  return out;
}
