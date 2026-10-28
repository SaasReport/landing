/**
 * Email HTML building blocks: table-based, inline-styled markup that mail clients render, mirrored for RTL
 * and LTR. Every function returns a fragment that sits inside the 600px shell the engine's compiler wraps
 * around the body blocks (a <tr> per block).
 */
import { DEFAULT_COLORS } from "./config.js";
import { DIGIT_SETS, digits as toDigits } from "@saasreport/format";

/** A style context for one locale: direction, font stack, colours, line heights, CSS class prefix. */
export function styler({ dir, font, colors: c, lineHeight: lh, cssPrefix, digits }) {
  const rtl = dir === "rtl";
  const start = rtl ? "right" : "left";
  const end = rtl ? "left" : "right";
  const FONT = `font-family:${font}`;
  const set = Object.keys(DIGIT_SETS).find((k) => DIGIT_SETS[k] === digits) || "latin";
  const num = (n) => toDigits(n, set);

  const cardOpen = (pad = "36px 36px 8px") =>
    `<tr><td class="${cssPrefix}-card" dir="${dir}" style="background:${c.card};padding:${pad};direction:${dir};text-align:${start};${FONT}">`;
  const CARD_CLOSE = "</td></tr>";

  const para = (t, size = 15, color = c.ink, extra = "") =>
    `<p dir="${dir}" style="margin:0 0 16px;font-size:${size}px;line-height:${lh.p};color:${color};text-align:${start};${FONT};${extra}">${t}</p>`;

  const h1 = (t) =>
    `<h1 class="${cssPrefix}-h1" dir="${dir}" style="margin:0 0 18px;font-size:26px;line-height:${lh.h1};font-weight:800;color:${c.ink};text-align:${start};${FONT}">${t}</h1>`;

  const h2 = (t) =>
    `<h2 dir="${dir}" style="margin:26px 0 12px;font-size:16px;line-height:${lh.h2};font-weight:700;color:${c.accentText || c.accent};text-align:${start};${FONT}">${t}</h2>`;

  const refPill = (refLabel, dateLabel) =>
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="margin:0 0 22px"><tr>`
    + `<td style="background:${c.pill};border:1px solid ${c.pillBorder};border-radius:10px;padding:10px 16px;${FONT};font-size:14px;color:${c.ink}">`
    + `${refLabel}: <bdi dir="ltr" style="font-weight:800;letter-spacing:.5px;direction:ltr;unicode-bidi:isolate">\${reference}</bdi>${rtl ? "&rlm;" : "&lrm;"}`
    + `<br><span style="color:${c.muted};font-size:13px">${dateLabel}: \${submitted_at}</span></td></tr></table>`;

  const steps = (items) => {
    const pad = rtl ? "2px 10px 12px 0" : "2px 0 12px 10px";
    const rows = items.map((t, i) =>
      `<tr><td width="34" valign="top" style="padding:0 0 12px"><div style="width:26px;height:26px;border-radius:8px;background:${c.ink};color:${c.onInk};text-align:center;line-height:26px;font-size:13px;font-weight:700;${FONT}">${num(i + 1)}</div></td>`
      + `<td valign="top" dir="${dir}" style="padding:${pad};font-size:14px;line-height:${lh.step};color:${c.ink};text-align:${start};${FONT}">${t}</td></tr>`).join("");
    return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" dir="${dir}" width="100%" style="margin:0 0 8px">${rows}</table>`;
  };

  const cta = (label, href) =>
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="margin:10px 0 26px"><tr>`
    + `<td style="border-radius:12px;background:${c.accent}"><a href="${href}" style="display:inline-block;padding:13px 26px;${FONT};font-size:15px;font-weight:700;color:${c.onAccent};text-decoration:none;border-radius:12px">${label}</a></td></tr></table>`;

  /** The header: the project's mark (a PNG logo, or the name as a wordmark), the domain, the two-tone rule. */
  const header = ({ logo, name, domain }) => {
    const mark = logo
      ? `<img src="${logo.src}" width="${logo.width}" height="${logo.height}" alt="${logo.alt || name}" style="display:block;border:0;width:${logo.width}px;height:auto">`
      : `<span style="${FONT};font-size:20px;line-height:1.4;font-weight:800;color:${c.ink}">${name}</span>`;
    const [railRadius, accentRadius] = rtl ? ["0 2px 2px 0", "2px 0 0 2px"] : ["2px 0 0 2px", "0 2px 2px 0"];
    return `<tr><td class="${cssPrefix}-head" dir="${dir}" style="background:${c.card};border-radius:14px 14px 0 0;padding:28px 36px 0;direction:${dir};text-align:${start};${FONT}">`
      + `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" dir="${dir}"><tr>`
      + `<td style="text-align:${start}">${mark}</td>`
      + `<td class="${cssPrefix}-domain" style="${FONT};font-size:12px;color:${c.muted};text-align:${end};direction:ltr">${domain}</td></tr></table>`
      + `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" dir="${dir}" style="margin-top:22px"><tr><td width="50%" style="height:4px;line-height:4px;font-size:0;background:${c.rail};border-radius:${railRadius}">&nbsp;</td><td width="50%" style="height:4px;line-height:4px;font-size:0;background:${c.accent};border-radius:${accentRadius}">&nbsp;</td></tr></table>`
      + `</td></tr>`;
  };

  const signature = ({ closing, team, tagline, site, domain }) =>
    cardOpen("8px 36px 30px")
    + `<div style="border-top:1px solid ${c.line};padding-top:22px"></div>`
    + para(`${closing}<br><strong style="font-weight:800">${team}</strong><br>`
      + (tagline ? `<span style="color:${c.muted};font-size:13px">${tagline}</span><br>` : "")
      + `<a href="${site}" style="color:${c.accentText || c.accent};text-decoration:underline;font-size:13px;direction:ltr;unicode-bidi:embed">${domain}</a>`, 14, c.ink, "margin:0")
    + CARD_CLOSE;

  /** The legal block: paragraphs in muted small type; the last (the copyright line) in bold. */
  const legal = (paras) =>
    `<tr><td class="${cssPrefix}-foot" dir="${dir}" style="background:${c.background};border-radius:0 0 18px 18px;border-top:1px solid ${c.line};padding:22px 36px 26px;direction:${dir};text-align:${start};${FONT}">`
    + paras.map((p, i) => i < paras.length - 1
      ? para(p, 12, c.muted, `line-height:${lh.legal};margin:0 0 10px`)
      : para(p, 12, c.muted, `line-height:${lh.legal};margin:0;font-weight:700`)).join("")
    + "</td></tr>";

  /** A notice row (the unsubscribe line of subscription templates), in the legal block's style. */
  const notice = (t) =>
    `<tr><td class="${cssPrefix}-foot" dir="${dir}" style="background:${c.background};padding:0 36px 22px;direction:${dir};text-align:${start};${FONT}">`
    + para(t, 12, c.muted, `line-height:${lh.legal};margin:0`) + "</td></tr>";

  /**
   * One legal-notice block (base, audience or jurisdiction) above the legal footer: a small bold title and its
   * paragraphs in the legal block's type. The first (the base notice) opens with the footer rule.
   */
  const noticeBlock = ({ title, paragraphs, first = false }) =>
    `<tr><td class="${cssPrefix}-foot" dir="${dir}" style="background:${c.background};${first ? `border-top:1px solid ${c.line};` : ""}padding:${first ? "22px" : "2px"} 36px 8px;direction:${dir};text-align:${start};${FONT}">`
    + para(`<strong style="font-weight:700;color:${c.ink}">${title}</strong>`, 12, c.muted, `line-height:${lh.legal};margin:0 0 6px`)
    + paragraphs.map((p) => para(p, 12, c.muted, `line-height:${lh.legal};margin:0 0 10px`)).join("")
    + "</td></tr>";

  return { rtl, start, end, FONT, num, cardOpen, CARD_CLOSE, para, h1, h2, refPill, steps, cta, header, signature, legal, notice, noticeBlock };
}

const esc = (v) =>
  String(v == null ? "" : v).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/**
 * The `fields_html` fragment a form handler passes to an acknowledgement: the submitted fields as a two-column
 * table. Escapes every label and value (the engine passes *_html params through untouched).
 */
export function fieldsHtml(rows, { dir = "rtl", font = "Arial,sans-serif", colors = {} } = {}) {
  const c = { ...DEFAULT_COLORS, ...colors };   // the project's brand.colors (resolveConfig); neutral defaults otherwise
  const align = dir === "rtl" ? "right" : "left";
  const tr = rows.map(([k, v], i) => {
    const bg = i % 2 ? c.card : c.background;
    return `<tr><td valign="top" style="padding:10px 14px;background:${bg};font-size:13px;color:${c.muted};width:38%;font-family:${font};text-align:${align}">${esc(k)}</td>`
      + `<td valign="top" style="padding:10px 14px;background:${bg};font-size:14px;color:${c.ink};font-family:${font};text-align:${align};word-break:break-word">${esc(v).replace(/\n/g, "<br>")}</td></tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="border:1px solid ${c.line};border-radius:12px;border-collapse:separate;overflow:hidden;margin:0 0 22px">${tr}</table>`;
}

/** The `fields_text` counterpart of fieldsHtml. */
export const fieldsText = (rows) => rows.map(([k, v]) => `${k}: ${v}`).join("\n");

/**
 * A `steps_html` fragment: the steps of a path as pills joined by arrows, in the brand's colours (colors.pill,
 * pillBorder, accent, ink) and font, the arrow pointing along the reading direction. `escape` defaults to the HTML escape.
 */
export function stepsHtml(steps, { dir = "ltr", font, colors = {}, lineHeight = 2.2, escape = esc } = {}) {
  const c = { ...DEFAULT_COLORS, ...colors };
  const rtl = dir === "rtl";
  const pill = (s) => `<span style="display:inline-block;background:${c.pill};border:1px solid ${c.pillBorder};border-radius:8px;padding:2px 10px;margin:0 0 6px">${escape(s)}</span>`;
  return `<p dir="${rtl ? "rtl" : "ltr"}" style="margin:0 0 18px;font-size:14px;line-height:${lineHeight};color:${c.ink}${font ? `;font-family:${font}` : ""}">${steps.map(pill)
    .join(` <span style="color:${c.accentText || c.accent}">${rtl ? "&larr;" : "&rarr;"}</span> `)}</p>`;
}
