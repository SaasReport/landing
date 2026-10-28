/**
 * The colour canon scan (docs/COLOUR.md): a colour literal is written in exactly one place, the token sources, and in the
 * CSS that declares the colour roles (a custom property named --c-<role>). Everything else paints with var(--c-<role>),
 * or with color-mix(in srgb, var(--c-<role>) N%, transparent) for an alpha. The scan covers source and generated output:
 *
 *   hex         #rgb #rgba #rrggbb #rrggbbaa (also URL-encoded, %23FF5A00, inside a data: URI)
 *   function    rgb() rgba() hsl() hsla() hwb() lab() lch() oklab() oklch() color() with no var() inside
 *   named       white, black, red … as the value of a colour property (color, background, border, fill, stroke, box-shadow …)
 *
 * Where a literal is allowed without an allow-list entry: the value of a --c-* custom property; <meta name="theme-color">
 * and the manifest (the browser's own chrome cannot read a stylesheet); nothing else. A reviewed exception is an entry in
 * canon.allow.json (category "colour-literal") with the reason.
 *
 * scanColour(file, text) → [{ line, literal, kind }]; roleProblems(files) → undeclared var(--c-*) uses.
 */
import { literals } from "./files.js";

const NAMED = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));
const COLOUR_PROP = /^(color|background|background-color|background-image|border|border-(top|right|bottom|left|inline|block)(-(start|end))?(-color)?|border-color|outline|outline-color|fill|stroke|stop-color|flood-color|lighting-color|caret-color|accent-color|text-decoration|text-decoration-color|text-emphasis-color|column-rule|column-rule-color|box-shadow|text-shadow|filter|scrollbar-color|-webkit-text-fill-color|-webkit-text-stroke|-webkit-text-stroke-color|-webkit-tap-highlight-color|--[\w-]+)$/;
export const HEX = /(?<![\w&#%-])(?:#|%23)(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[-\d.%\s,/a-z]*\)/gi;   // numeric arguments only: color(var(...)) and color-mix() are not literals
const FUNC_NUMERIC = /^\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[-\d.%\s,/]+(?:deg|rad|turn|grad|none)?[-\d.%\s,/]*\)$/i;

const blank = (s) => s.replace(/[^\n]/g, " ");
const lineOf = (text, at) => text.slice(0, at).split("\n").length;
const NO_PAINT = /^(transparent|currentcolor|inherit|initial|unset|revert|revert-layer|none|auto|normal)$/i;

/** Literals inside a declaration value: [{ literal, kind }]. `prop` (lowercase) decides whether names count. */
export function valueLiterals(prop, value) {
  const out = [];
  let v = value;
  // url(...) holds paths and data URIs: only a data URI's encoded colours count
  v = v.replace(/url\(\s*(["']?)([^)]*?)\1\s*\)/gi, (m, q, u) => { if (/^data:/i.test(u)) { let d = u; try { d = decodeURIComponent(u); } catch { /* not percent-encoded: the URI is read as written */ } for (const h of d.match(HEX) || []) out.push({ literal: h, kind: "hex" }); for (const f of d.match(/\b(?:rgba?|hsla?)\([^)]*\)/gi) || []) out.push({ literal: f, kind: "function" }); for (const [, val] of d.matchAll(/\b(?:fill|stroke|stop-color)\s*=\s*['"]([a-z]+)['"]/gi)) if (NAMED.has(val.toLowerCase())) out.push({ literal: val, kind: "named" }); } return " "; });
  v = v.replace(/"[^"]*"|'[^']*'/g, " ");
  for (const h of v.match(HEX) || []) out.push({ literal: h, kind: "hex" });
  for (const f of v.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/gi) || []) if (!/var\(|\{\{/.test(f)) out.push({ literal: f, kind: "function" });
  if (COLOUR_PROP.test(prop)) {
    const bare = v.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, " ").replace(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/gi, " ").replace(/(--|\.|#)[\w-]+/g, " ");
    for (const w of bare.match(/[a-z]+/gi) || []) if (NAMED.has(w.toLowerCase()) && !NO_PAINT.test(w)) out.push({ literal: w, kind: "named" });
  }
  return out;
}

/** A CSS text → declarations [{ prop, value, line }] (rules, @media/@supports groups, @font-face; strings, url() and () are opaque). */
export function cssDeclarations(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, blank);
  const out = [], stack = [];
  let buf = "", bufStart = 0, paren = 0, quote = "";
  const decl = (b, at) => {
    const i = b.indexOf(":");
    if (i < 1) return;
    const prop = b.slice(0, i).trim().toLowerCase();
    if (!/^(--)?[a-z-]+[\w-]*$/.test(prop)) return;
    out.push({ prop, value: b.slice(i + 1), line: lineOf(text, at + (b.length - b.trimStart().length)) });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { buf += c; if (c === "\\") { buf += text[++i] || ""; } else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === "(") paren++;
    if (c === ")") paren = Math.max(0, paren - 1);
    if (paren) { buf += c; continue; }
    if (c === "{") { const pre = buf.trim(); stack.push(/^@(media|supports|layer|container|keyframes|-webkit-keyframes|document|scope)/i.test(pre) ? "group" : "rule"); buf = ""; bufStart = i + 1; continue; }
    if (c === "}") { if (stack[stack.length - 1] === "rule") decl(buf, bufStart); stack.pop(); buf = ""; bufStart = i + 1; continue; }
    if (c === ";") { if (stack[stack.length - 1] === "rule") decl(buf, bufStart); buf = ""; bufStart = i + 1; continue; }
    buf += c;
  }
  return out;
}

const roleDecl = (prop) => /^--c-[\w-]+$/.test(prop);

function scanCss(css) {
  const out = [];
  for (const d of cssDeclarations(css)) {
    if (roleDecl(d.prop)) continue;
    for (const l of valueLiterals(d.prop, d.value)) out.push({ line: d.line, ...l });
  }
  return out;
}

const SVG_ATTR = /\b(fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*"([^"]*)"|\b(fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*'([^']*)'/gi;

function scanMarkup(src0) {
  const out = [];
  const src = src0.replace(/<script\b[\s\S]*?<\/script>/gi, blank);   // code is scanned as code below, never as attributes
  const code = src0;
  const add = (at, items) => { for (const l of items) out.push({ line: lineOf(src, at), ...l }); };
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) { const base = lineOf(src, m.index + m[0].indexOf(">")); for (const l of scanCss(m[1])) out.push({ ...l, line: base + l.line - 1 }); }
  for (const m of src.matchAll(/\sstyle\s*=\s*"([^"]*)"|\sstyle\s*=\s*'([^']*)'/gi)) { const body = m[1] ?? m[2]; for (const d of cssDeclarations(`x{${body}}`)) if (!roleDecl(d.prop)) add(m.index, valueLiterals(d.prop, d.value)); }
  for (const m of src.matchAll(SVG_ATTR)) {
    const prop = (m[1] || m[3]).toLowerCase(), val = m[2] ?? m[4];
    if (/^\{\{|^var\(|^url\(|^currentcolor$|^none$|^inherit$|^transparent$/i.test(val.trim())) continue;
    const found = valueLiterals(prop, val);
    // fill="white" etc.
    if (!found.length && NAMED.has(val.trim().toLowerCase())) found.push({ literal: val.trim(), kind: "named" });
    add(m.index, found);
  }
  for (const m of code.matchAll(/<script\b(?![^>]*\bsrc=)(?![^>]*\btype=["']?(?:application\/(?:ld\+)?json|importmap|speculationrules|text\/template))[^>]*>([\s\S]*?)<\/script>/gi)) { const base = lineOf(code, m.index + m[0].indexOf(">")); for (const l of scanJs(m[1])) out.push({ ...l, line: base + l.line - 1 }); }
  return out;
}

const JS_NAMED_CONTEXT = /(fillStyle|strokeStyle|shadowColor|\.color|\.background(?:Color)?|setProperty|borderColor|fill|stroke|color)\b\s*[=:(,]?\s*$/;

function scanJs(src) {
  const out = [];
  for (const lit of literals(src)) {
    const v = lit.value;
    if (/^(?:https?:)?\/\/|^\/[\w.-]/.test(v) && !/\{|;/.test(v)) continue;   // a URL or a path: its #fragment is an anchor, not a colour
    if (/^#[\w-]+$/.test(v) && /(href|hash|querySelector|closest|matches|location|getElementById|\bid\b|target)\W*$/.test(lit.context) && !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) continue;
    if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) && /(href|hash|querySelector|closest|matches|location|getElementById)\W*$/.test(lit.context)) continue;
    const seen = new Set();
    const add = (l) => { const k = l.literal + l.kind; if (!seen.has(k)) { seen.add(k); out.push({ line: lit.line, ...l }); } };
    if (/[{;]/.test(v) && /:/.test(v)) { for (const d of cssDeclarations(`x{${v.replace(/\$\{[^}]*\}/g, " ")}}`)) if (!roleDecl(d.prop)) for (const l of valueLiterals(d.prop, d.value)) add(l); }
    for (const h of v.match(HEX) || []) add({ literal: h, kind: "hex" });
    for (const f of v.match(/\b(?:rgba?|hsla?)\([^()]*\)/gi) || []) if (!/var\(|\$\{|\{\{/.test(f)) add({ literal: f, kind: "function" });
    if (NAMED.has(v.trim().toLowerCase()) && !NO_PAINT.test(v.trim()) && JS_NAMED_CONTEXT.test(lit.context)) add({ literal: v.trim(), kind: "named" });
    for (const m of v.matchAll(/\b(?:fill|stroke|stop-color)\s*=\s*\\?["']([a-z]+)\\?["']/gi)) if (NAMED.has(m[1].toLowerCase())) add({ literal: m[1], kind: "named" });
  }
  return out;
}

function scanJson(src) {
  const out = [];
  src.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const v = m[1];
      if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || FUNC_NUMERIC.test(v)) out.push({ line: i + 1, literal: v, kind: /^#/.test(v) ? "hex" : "function" });
      else if (/style\s*=|\bfill=|\bstroke=/.test(v)) for (const x of scanMarkup(v.replace(/\\"/g, '"'))) out.push({ line: i + 1, literal: x.literal, kind: x.kind });
    }
  });
  return out;
}

/** Colour literals of one file by its extension: [{ line, literal, kind }]. */
export function scanColour(file, text) {
  if (/\.css$/i.test(file)) return scanCss(text);
  if (/\.(html?|svg|xml)$/i.test(file)) return scanMarkup(text).filter((l) => !/theme-color|TileColor/.test(text.split("\n")[l.line - 1] || ""));
  if (/\.(m?js|cjs|ts|tsx|jsx)$/i.test(file)) return scanJs(text);
  if (/\.json$/i.test(file)) return scanJson(text);
  return [];
}

export const COLOUR_FILES = /\.(css|html?|svg|m?js|cjs|ts|tsx|jsx|json)$/i;

/** var(--c-x) used but never declared as a --c-x custom property in any of the given { file, text }: [{ file, line, name }]. */
export function roleProblems(files) {
  const declared = new Set();
  const uses = [];
  for (const { file, text } of files) {
    if (!/\.(css|html?|svg)$/i.test(file)) continue;
    for (const m of text.matchAll(/(--c-[\w-]+)\s*:/g)) declared.add(m[1]);
    text.split("\n").forEach((l, i) => { for (const m of l.matchAll(/var\(\s*(--c-[\w-]+)/g)) uses.push({ file, line: i + 1, name: m[1] }); });
  }
  return declared.size ? uses.filter((u) => !declared.has(u.name)) : [];
}
