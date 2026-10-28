/**
 * Small HTML helpers shared by the section templates. Content strings are trusted, author-written HTML
 * (inline markup such as <br>, <b> or <span class="t-accent"> is allowed); attribute values are escaped.
 */
export const attr = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const text = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const pad = (n) => " ".repeat(n);

/** Render extra attributes: { "data-x": "v", "data-flag": true, "data-json": { … } } (objects become JSON in single quotes). */
export function attrs(o = {}) {
  let s = "";
  for (const [k, v] of Object.entries(o)) {
    if (v === false || v == null) continue;
    if (v === true) s += ` ${k}`;
    else if (typeof v === "object") s += ` ${k}='${JSON.stringify(v).replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'`;
    else s += ` ${k}="${attr(v)}"`;
  }
  return s;
}

/** An icon from the sprite: <svg class="ico"><use href="#i-name"/></svg>. */
export const ico = (name, sm = false, cls = "") => `<svg class="ico${sm ? " ico--sm" : ""}${cls ? ` ${cls}` : ""}"><use href="#i-${name}"/></svg>`;

/**
 * A call to action. { label, href?, modal?, style: "primary"|"ghost"|"light"|"line"|"dark", size?: "sm"|"lg",
 * block?, icon?, iconSize?: "sm"|"md", class?, attrs? }. A link when it has an href, otherwise a button (a modal opener).
 */
export function button(a, defaults = {}) {
  const o = { ...defaults, ...a };
  const cls = ["btn", `btn--${o.style || "primary"}`, o.size && `btn--${o.size}`, o.block && "btn--block", o.class].filter(Boolean).join(" ");
  const icon = o.icon ? ico(o.icon, (o.iconSize || defaults.iconSize) === "sm") : "";
  const extra = attrs(o.attrs);
  if (o.href) return `<a class="${cls}" href="${attr(o.href)}"${o.modal ? ` data-modal="${attr(o.modal)}"` : ""}${extra}>${icon}${o.label}</a>`;
  return `<button class="${cls}"${o.modal ? ` data-modal="${attr(o.modal)}"` : ""}${extra}>${icon}${o.label}</button>`;
}

/** A plain link: <a href>, or a link-styled modal opener when there is no href. */
export function link(l) {
  if (l.href) return `<a href="${attr(l.href)}"${l.modal ? ` data-modal="${attr(l.modal)}"` : ""}>${l.label}</a>`;
  return `<button class="link" data-modal="${attr(l.modal)}">${l.label}</button>`;
}

/** "a" or ["a","b"] or [["a","b"],["c"]] → rows of items (a layout hint: one source line per row). */
export function rows(list) {
  if (!Array.isArray(list)) return [[list]];
  return list.length && list.every(Array.isArray) ? list : [list];
}
export const flat = (list) => rows(list).flat();
