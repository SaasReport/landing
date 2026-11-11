/** Building blocks shared by the landing section templates. Every template returns lines (joined with "\n"). */
import { attr, button, pad } from "../html.js";

/** The section header: eyebrow (optionally with the accent dot), h2 title, lead paragraph(s). */
export function head(h = {}, { start = false, indent = 4, extra = [], attrs = "" } = {}) {
  const p = pad(indent);
  const out = [`${p}<header class="sec-head${start ? " sec-head--start" : ""} reveal"${attrs}>`];
  if (h.eyebrow != null) out.push(`${p}  <p class="eyebrow">${h.dot ? '<span class="dot"></span>' : ""}${h.eyebrow}</p>`);
  if (h.title != null) out.push(`${p}  <h2>${h.title}</h2>`);
  for (const l of [].concat(h.lead ?? [])) out.push(`${p}  <p>${l}</p>`);
  out.push(...extra.map((l) => `${p}  ${l}`));
  out.push(`${p}</header>`);
  return out;
}

/** <!-- ============ comment ============ --> <section …><div class="wrap">…</div>[after]</section> */
export function section(s, inner, { cls = "section", wrap = "wrap", after = [], attrs = "" } = {}) {
  const variant = s.surface ? ` section--${s.surface}` : "";
  return [
    ...(s.comment ? [`<!-- ============ ${s.comment} ============ -->`] : []),
    `<section class="${cls}${variant}"${s.id ? ` id="${attr(s.id)}"` : ""}${attrs}>`,
    `  <div class="${wrap}">`,
    ...inner,
    `  </div>`,
    ...after,
    `</section>`,
  ];
}

/** A row of calls to action. inline: one line; otherwise one action per line. */
export function actions(list = [], { indent = 4, cls = "actions actions--center", reveal = true, inline = false, defaults = {} } = {}) {
  if (!list?.length) return [];
  const p = pad(indent);
  const open = `<div class="${cls}${reveal ? " reveal" : ""}">`;
  if (inline) return [`${p}${open}${list.map((a) => button(a, defaults)).join("")}</div>`];
  return [`${p}${open}`, ...list.map((a) => `${p}  ${button(a, defaults)}`), `${p}</div>`];
}

/** The «demo data» footnote under terminal views: <p class="tx-note"><b>label</b><span>text</span></p>. */
export const note = (n, indent = 4) => (n ? [`${pad(indent)}<p class="tx-note"><b>${n.label}</b><span>${n.text}</span></p>`] : []);

/** A mount point for a client-side view (terminal layer): <div class="tx-stage" data-tx-view="…"></div>. */
export const stage = (view, indent = 4) => [`${pad(indent)}<div class="tx-stage" data-tx-view="${attr(view)}"></div>`];

/** An add-on block below a section (a second wrap): optional heading, a stage and a note. */
export function addon(a) {
  if (!a) return [];
  const out = [`  <div class="wrap tx-addon">`];
  if (a.title) out.push(`    <header class="sec-head reveal" style="margin-bottom:28px"><h3 style="font-size:clamp(20px,2.4vw,26px)">${a.title}</h3></header>`);
  out.push(...stage(a.view), ...note(a.note), `  </div>`);
  return out;
}
