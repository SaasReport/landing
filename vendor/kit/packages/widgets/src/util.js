/**
 * Small helpers of the widget engine: hashing, JSON pointers, the text values of a spec (a string, a {locale: string}
 * map, or a value taken from a source) and the safe arithmetic of the calculator archetype.
 */
import { createHash } from "node:crypto";

export const sha16 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
export const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Canonical JSON (sorted keys, two-space indent) so builds are byte-stable. */
export function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}

/** Value at a JSON Pointer ("/a/b~1c/0") in a document; undefined when it does not resolve. */
export function pointer(doc, ptr) {
  if (ptr === "" || ptr === "/") return doc;
  return ptr.replace(/^\//, "").split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((o, k) => (o == null ? undefined : o[k]), doc);
}
export const escPtr = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");

/** Every string in a JSON value (deep), for traceability: what a widget may say. */
export function strings(v, out = new Set()) {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/** Add days to an ISO date (UTC). */
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ---------- calculator expressions: + - * / ( ) and min max round floor ceil pow over input ids ---------- */
const FNS = { min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil, pow: Math.pow, abs: Math.abs, gte: (a, b) => (a >= b ? 1 : 0), lte: (a, b) => (a <= b ? 1 : 0) };

export function tokenize(src) {
  const out = []; const re = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),])/y;
  let m; re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (!(m = re.exec(src))) { if (/^\s*$/.test(src.slice(re.lastIndex))) break; throw new Error(`cannot read "${src.slice(re.lastIndex)}"`); }
    out.push(m[1]);
  }
  return out;
}

/** Parse an expression into a tree; `names` is the set of allowed identifiers (input ids). */
export function parseExpr(src, names) {
  const t = tokenize(src); let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const expect = (x) => { if (next() !== x) throw new Error(`expected "${x}" in ${src}`); };
  function primary() {
    const k = next();
    if (k == null) throw new Error(`unexpected end of ${src}`);
    if (k === "(") { const e = add(); expect(")"); return e; }
    if (k === "-") return { op: "neg", a: primary() };
    if (/^\d/.test(k)) return { num: +k };
    if (FNS[k] && peek() === "(") { next(); const args = [add()]; while (peek() === ",") { next(); args.push(add()); } expect(")"); return { fn: k, args }; }
    if (names && !names.has(k)) throw new Error(`unknown name "${k}" in ${src} (inputs: ${[...names].join(", ")})`);
    return { ref: k };
  }
  function mul() { let a = primary(); while (peek() === "*" || peek() === "/") { const op = next(); a = { op, a, b: primary() }; } return a; }
  function add() { let a = mul(); while (peek() === "+" || peek() === "-") { const op = next(); a = { op, a, b: mul() }; } return a; }
  const tree = add();
  if (i < t.length) throw new Error(`unexpected "${t[i]}" in ${src}`);
  return tree;
}

export function evalExpr(tree, vars) {
  if ("num" in tree) return tree.num;
  if (tree.ref) return Number(vars[tree.ref]);
  if (tree.fn) return FNS[tree.fn](...tree.args.map((a) => evalExpr(a, vars)));
  if (tree.op === "neg") return -evalExpr(tree.a, vars);
  const a = evalExpr(tree.a, vars), b = evalExpr(tree.b, vars);
  return tree.op === "+" ? a + b : tree.op === "-" ? a - b : tree.op === "*" ? a * b : a / b;
}

/** Plain text of a string that may hold HTML (content sources often do): tags dropped, entities decoded, spaces collapsed. */
export function plain(s) {
  if (typeof s !== "string" || !/[<&]/.test(s)) return s;
  return s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}
