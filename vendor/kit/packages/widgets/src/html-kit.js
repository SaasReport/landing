/**
 * Helpers a plugin's static HTML shares: escaping, the tone attribute, paragraphs, dates, key/value lists, decisions.
 * Pure string functions; the engine passes the same set to every plugin's render as its fifth argument.
 */
import { fillIn } from "./chrome.js";
export { fillIn, parseExpr, evalExpr };
import { parseExpr, evalExpr } from "./util.js";

export const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const arrow = (locale) => (locale?.dir === "rtl" ? "←" : "→");
/** {date} in a text: the item's own date, formatted for the locale. */
export const withDate = (f, t, at) => (t && at ? String(t).replace(/\{date\}/g, f.date(at)) : t);
export const toneAttr = (t) => ` data-tone="${esc(t || "info")}"`;
export const p = (cls, v) => (v == null || v === "" ? "" : `<p class="${cls}">${esc(v)}</p>`);
export const timeEl = (f, iso) => (iso ? `<time datetime="${esc(iso)}">${esc(f.date(iso))}</time>` : "");
export const val = (c, f, v) => (v === true ? `<span class="kw-yes" aria-label="${esc(c.yes)}">✓</span>` : v === false ? `<span class="kw-no" aria-label="${esc(c.no)}">—</span>` : typeof v === "number" ? esc(f.num(v)) : esc(v));
export const fields = (c, f, list) => (list?.length ? `<dl class="kw-kv">${list.map((l) => `<div${l.tone ? toneAttr(l.tone) : ""}><dt>${esc(l.label)}</dt><dd>${val(c, f, l.value)}</dd></div>`).join("")}</dl>` : "");
export const expectedBox = (c, list) => (list?.length ? `<div class="kw-expect"><h5>${esc(c.expected)}</h5><ul>${list.map((o) => `<li><b>${esc(o.label)}</b> ${esc(o.text)}</li>`).join("")}</ul></div>` : "");
export const decision = (c, d) => (d ? `<span class="kw-decision" data-decision="${esc(d)}">${esc(c[d])}</span>` : "");
export const json = (v) => esc(JSON.stringify(v, null, 2));


/** What render(w, c, f, locale, h) receives as `h`. */
export const HTML_KIT = { esc, arrow, withDate, toneAttr, p, timeEl, val, fields, expectedBox, decision, json, fillIn, parseExpr, evalExpr };
