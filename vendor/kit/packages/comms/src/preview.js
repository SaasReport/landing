/**
 * HTML previews: every template of a config, per locale, compiled by the same compiler the engine uses,
 * with sample params. What you see is what the mail client gets.
 */
import { resolveConfig, DEFAULT_COLORS } from "./config.js";
import { buildSpecs } from "./specs.js";
import { engineRuntime, copyrightYears } from "./runtime.js";
import { fieldsHtml, fieldsText } from "./html.js";
import { compileTemplate } from "../workers/comms-engine/compiler.js";

/** Sample params for a template: the locale pack's sample person and fields, plus config.preview[lang] values. */
export function sampleParams(config, template, { now } = {}) {
  const r = resolveConfig(config);
  const rt = engineRuntime(config);
  const loc = r.locales.find((l) => l.tag === template.locale) || r.primary;
  const s = loc.pack.sample;
  const rows = [[s.fieldName, s.name], [s.fieldEmail, "sara@example.com"], [s.fieldCompany, s.company], [s.fieldMessage, s.message]];
  const extra = { ...(r.preview?.[loc.lang] || {}) };
  const params = {
    ...copyrightYears(rt.years, rt.timeZone, now),
    name: s.name, reference: `${r.idPrefix.toUpperCase()}-7K3M9Q`, submitted_at: s.submittedAt,
    fields_html: fieldsHtml(rows, { dir: loc.dir, font: loc.fonts.stack, colors: r.colors }),
    fields_text: fieldsText(rows),
    form_label: extra.form_label || s.fieldMessage,
  };
  for (const p of template.required_params) if (params[p] === undefined) params[p] = extra[p] ?? `[${p}]`;
  return { ...params, ...extra };
}

/**
 * [{ template_id, locale, dir, subject, html, text }] for every template in the config. `notices` picks the
 * recipient's notice blocks ({ audiences, jurisdictions }); `drafts: true` and `placeholders: "show"` preview
 * draft jurisdiction blocks and unfilled placeholders, which are never published.
 */
export function renderPreviews(config, { now = new Date(), specs, notices, drafts, placeholders } = {}) {
  const sp = specs || buildSpecs(config, { drafts, placeholders });
  const rt = engineRuntime(config);
  const blocks = new Map(sp["blocks.json"].blocks.map((b) => [b.block_id, b]));
  const links = new Map(sp["links.json"].links.map((l) => [l.link_id, l]));
  return sp["manifest.json"].templates.map((t) => {
    const params = sampleParams(config, t, { now });
    const c = compileTemplate({ template: t, blocks, links, params, shell: rt.shells[t.locale], notices: t.notice_blocks ? notices : undefined });
    if (!c.ok) throw new Error(`preview ${t.template_id}: ${c.error} ${c.detail}`);
    return { template_id: t.template_id, locale: t.locale, dir: t.direction, subject: c.subject, html: c.html, text: c.text };
  });
}

const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

/** An index page linking every preview of one or more projects: [{ title, dir, previews }] → HTML. */
export function previewIndex(projects, { colors = {}, font = "Arial,sans-serif" } = {}) {
  const c = { ...DEFAULT_COLORS, ...colors };
  const sections = projects.map((p) => `<h2>${esc(p.title)}</h2><ul>${p.previews.map((v) =>
    `<li><a href="${esc(p.dir)}/${esc(v.template_id)}.html">${esc(v.template_id)}</a> <small>${esc(v.locale)} · ${esc(v.dir)}</small><br><span dir="${v.dir === "rtl" ? "rtl" : "ltr"}">${esc(v.subject)}</span></li>`).join("")}</ul>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email previews</title>`
    + `<style>body{font-family:${esc(font)};background:${c.background};color:${c.ink};max-width:880px;margin:24px auto;padding:0 16px}a{color:${c.accentText || c.accent}}li{margin:0 0 10px}small{color:${c.muted}}</style>`
    + `<h1>Email previews</h1>${sections}</html>\n`;
}
