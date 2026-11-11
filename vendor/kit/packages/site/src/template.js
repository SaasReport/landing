/**
 * The kit's text templates: theme CSS, client scripts (demo engines, page helpers) and inner pages are files with
 * {{placeholders}}, rendered with a project's tokens, locale pack, strings and data. The syntax:
 *
 *   {{path}}                 a value (dotted path: {{color.accent}}, {{s.home.03}}, {{d.cast.bank1}})
 *   {{path|filter|filter}}   filtered: attr, html, dq, sq, tl (JS string contexts), json, css, rgb, url, digits, …
 *   {{#each path}}…{{/each}} a list; inside, {{.}} is the item, {{.name}} a field, {{@index}}, {{@n}} (1-based),
 *                            {{@first}}, {{@last}}; plain paths fall back to the enclosing scopes
 *   {{#if path}}…{{else}}…{{/if}}, {{#unless path}}…{{/unless}}   truthy: not null/false/""/0/empty list
 *   {{> name}}               a partial (ctx.partials[name]), rendered in the current scope
 *
 * Values are inserted as they are (content is trusted, author-written); filters escape for a context. An unknown
 * path or filter throws, so a missing string never reaches a page silently.
 */

const TAG = /\{\{(\.|[.@]?[\w@-]+(?:\.[\w@-]+)*)((?:\|[\w-]+(?::[^|}]*)?)*)\}\}/g;

/** Parse text (no blocks) into text, value and partial nodes. */
function parse(src) {
  const out = [];
  let last = 0;
  for (const m of src.matchAll(/\{\{> ([\w-]+)\}\}|\{\{(\.|[.@]?[\w@-]+(?:\.[\w@-]+)*)((?:\|[\w-]+(?::[^|}]*)?)*)\}\}/g)) {
    if (m[1]) { if (m.index > last) out.push(src.slice(last, m.index)); last = m.index + m[0].length; out.push({ partial: m[1] }); continue; }
    m.splice(1, 1);
    if (m.index > last) out.push(src.slice(last, m.index));
    last = m.index + m[0].length;
    out.push({ path: m[1], filters: m[2] ? m[2].slice(1).split("|").map((f) => { const [name, ...arg] = f.split(":"); return { name, arg: arg.join(":") }; }) : [] });
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

// Blocks use a space: {{#each items}}. Tokenise them before the value regex.
const BLOCK = /\{\{(#each|#if|#unless) ([.@]?[\w@-]*(?:\.[\w@-]+)*)\}\}/g;

function tree(src, file) {
  const out = { kids: [] };
  const stack = [out];
  const top = () => stack[stack.length - 1];
  const push = (n) => (top().inAlt ? top().alt : top().kids).push(n);
  let last = 0;
  const marks = [];
  for (const m of src.matchAll(BLOCK)) marks.push({ at: m.index, len: m[0].length, open: m[1].slice(1), path: m[2] });
  const flushText = (text) => { for (const n of parse(text)) push(n); };
  // Walk the source, handling block openers here and closers / else in the text parser pass below.
  const pieces = [];
  for (const mk of marks) { pieces.push({ text: src.slice(last, mk.at) }, { open: mk.open, path: mk.path }); last = mk.at + mk.len; }
  pieces.push({ text: src.slice(last) });
  for (const p of pieces) {
    if (p.open) { const b = { block: p.open, path: p.path, kids: [] }; push(b); stack.push(b); continue; }
    // split the text at closers and else
    let j = 0;
    for (const m of p.text.matchAll(/\{\{(\/each|\/if|\/unless|else)\}\}/g)) {
      flushText(p.text.slice(j, m.index));
      j = m.index + m[0].length;
      const b = top();
      if (m[1] === "else") {
        if (!b.block || b.block === "each") throw new Error(`${file}: {{else}} outside an if/unless block`);
        b.alt = []; b.inAlt = true;
      } else {
        if (b.block !== m[1].slice(1)) throw new Error(`${file}: {{${m[1]}}} closes {{#${b.block || "?"}}}`);
        stack.pop();
      }
    }
    flushText(p.text.slice(j));
  }
  if (stack.length > 1) throw new Error(`${file}: {{#${top().block} ${top().path}}} is not closed`);
  return out.kids;
}

const escAttr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

import { roleVar, toneStyle } from "./tokens.js";
/** Built-in filters. `this` is the render context (for locale-aware filters). */
export const FILTERS = {
  raw: (v) => v,
  attr: escAttr,
  html: (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  dq: (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n"),
  sq: (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n"),
  tl: (v) => String(v).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"),
  tln: (v) => String(v).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/\n/g, "\\n"),
  jskey: (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)),
  jslist: (v) => `[${[].concat(v).map((x) => JSON.stringify(x)).join(", ")}]`,
  jsnum: (n) => (Number.isInteger(n) && Math.abs(n) >= 10000 ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_") : String(n)),
  jsnums: (v) => `[${[].concat(v).join(", ")}]`,
  jsmap: (o) => `{${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")}}`,
  json: (v) => JSON.stringify(v),
  jsonld: (v) => JSON.stringify(v).replace(/</g, "\\u003c"),
  css: (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a "),
  rgb: (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16)).join(","),
  url: (v) => encodeURIComponent(v),
  /** a #RRGGBB that is one of the project's colour roles becomes var(--c-role): the swatch paints the role, never a copy of its value; anything else is left for kit check tokens to flag */
  role(v) { const m = Object.entries(this.colorHex || {}).find(([, h]) => String(h).toUpperCase() === String(v).toUpperCase()); return m ? `var(${roleVar(m[0])})` : String(v); },
  /** a colour role name (accent, chart2 …) → var(--c-role); anything else is a content error: colours in content are roles, never values (colour canon) */
  roleRef(v) { if (!(String(v) in (this.colorHex || {}))) throw new Error(`unknown colour role "${v}": content names a role (accent, ink, chart1 … chart6), never a hex value`); return `var(${roleVar(String(v))})`; },
  /** a tone role name (accent, ok, chart2 …) → the inline style of a solid tone: --c (the fill) and --on-c (the text colour derived for that fill) */
  tone(v) { return toneStyle(this.colorHex || {}, v); },
  lower: (v) => String(v).toLowerCase(),
  upper: (v) => String(v).toUpperCase(),
  digits(v) { return this.L ? this.L.toDigits(v) : String(v); },
  count: (v) => (Array.isArray(v) ? v.length : Object.keys(v || {}).length),
  join: (v, sep = ", ") => [].concat(v).join(sep),
};

const truthy = (v) => !(v == null || v === false || v === "" || v === 0 || (Array.isArray(v) && v.length === 0));

function lookup(path, scopes, file) {
  if (path === ".") return scopes[0].item;
  if (path.startsWith("@")) {
    const s = scopes.find((x) => x.meta);
    if (!s) throw new Error(`${file}: {{${path}}} outside {{#each}}`);
    if (!(path.slice(1) in s.meta)) throw new Error(`${file}: unknown loop variable {{${path}}}`);
    return s.meta[path.slice(1)];
  }
  const own = path.startsWith(".");
  const keys = (own ? path.slice(1) : path).split(".");
  const get = (o) => keys.reduce((x, k) => (x == null ? undefined : x[k]), o);
  if (own) return get(scopes[0].item);
  for (const s of scopes) {
    const base = s.item;
    if (base && typeof base === "object" && keys[0] in base) return get(base);
  }
  return undefined;
}

function run(nodes, scopes, ctx, file) {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") { out += n; continue; }
    if (n.block === "each") {
      const list = lookup(n.path, scopes, file);
      if (list == null) throw new Error(`${file}: {{#each ${n.path}}}: no such list`);
      const arr = Array.isArray(list) ? list : Object.entries(list).map(([key, value]) => ({ key, value }));
      arr.forEach((item, i) => {
        out += run(n.kids, [{ item, meta: { index: i, n: i + 1, first: i === 0, last: i === arr.length - 1 } }, ...scopes], ctx, file);
      });
      continue;
    }
    if (n.partial) {
      const p = ctx.partials?.[n.partial];
      if (p == null) throw new Error(`${file}: unknown partial {{> ${n.partial}}}`);
      out += run(tree(p, `${file} > ${n.partial}`), scopes, ctx, file);
      continue;
    }
    if (n.block === "if" || n.block === "unless") {
      let v = truthy(lookup(n.path, scopes, file));
      if (n.block === "unless") v = !v;
      out += run(v ? n.kids : n.alt || [], scopes, ctx, file);
      continue;
    }
    let v = lookup(n.path, scopes, file);
    if (v === undefined) throw new Error(`${file}: unknown placeholder {{${n.path}}}`);
    for (const f of n.filters) {
      const fn = ctx.filters?.[f.name] || FILTERS[f.name];
      if (!fn) throw new Error(`${file}: unknown filter ${f.name} in {{${n.path}|${f.name}}}`);
      v = fn.call(ctx, v, ...(f.arg ? [f.arg] : []));
    }
    out += v == null ? "" : String(v);
  }
  return out;
}

const cache = new Map();

/** Render a template string with a context object ({ …values, filters?: { name: fn } }). */
export function renderTemplate(src, ctx = {}, file = "template") {
  let t = cache.get(src);
  if (!t) { t = tree(src, file); cache.set(src, t); }
  return run(t, [{ item: ctx }], ctx, file);
}

/** Every placeholder path a template uses (values and blocks), for checks and docs. */
export function templateKeys(src) {
  const keys = new Set();
  for (const m of src.matchAll(BLOCK)) keys.add(m[2]);
  for (const m of src.matchAll(TAG)) keys.add(m[1]);
  return [...keys];
}
