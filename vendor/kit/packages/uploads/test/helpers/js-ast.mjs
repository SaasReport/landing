// Reads JavaScript with a real parser (acorn) and reports everything that can build or run a regular expression: regex literals,
// every reference to RegExp (new, call, alias, Reflect.construct, globalThis.RegExp, computed access to a global), and the string
// methods that turn their argument into a pattern (match, matchAll, search) or may be handed a RegExp (replace, replaceAll, split).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

export function hasQuantifier(source) {
  let inClass = false, openParen = false;   // openParen: the previous token was an unescaped "(" ("(?" is group syntax)
  for (let i = 0; i < source.length; i++) {
    const c = source[i], afterParen = openParen;
    openParen = false;
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { openParen = true; continue; }
    if (c === "*" || c === "+") return true;
    if (c === "?" && !afterParen) return true;
    if (c === "{") { let j = i + 1; while (j < source.length && "0123456789,".includes(source[j])) j++; if (j > i + 1 && source[j] === "}") return true; }
  }
  return false;
}

const GLOBALS = new Set(["globalThis", "window", "self", "global"]);
const PATTERN_METHODS = new Set(["match", "matchAll", "search"]);
const MAYBE_PATTERN_METHODS = new Set(["replace", "replaceAll", "split"]);
const ALL_PATTERN_METHODS = new Set([...PATTERN_METHODS, ...MAYBE_PATTERN_METHODS]);
const propName = (m) => (!m.computed && m.property.type === "Identifier" ? m.property.name : m.computed && m.property.type === "Literal" && typeof m.property.value === "string" ? m.property.value : null);
const isStringLike = (n) => n && ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral");   // a template literal is always a string: a literal replacement, never a pattern

/** Every finding in one source text: { kind: "regex" | "regexp-reference" | "global-access" | "string-pattern" | "pattern-argument", line, detail }. */
export function findings(src) {
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  const out = [];
  const fns = [];   // the enclosing named functions: a registry entry may be narrowed to one of them
  const add = (kind, node, detail) => out.push({ kind, line: node.loc.start.line, fn: fns.at(-1) ?? null, detail });
  (function walk(node, parent, key) {
    if (!node || typeof node.type !== "string") return;
    const named = (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id ? node.id.name : null;
    if (named) fns.push(named);
    if (node.type === "Literal" && node.regex) add("regex", node, { pattern: node.regex.pattern, flags: node.regex.flags, quantified: hasQuantifier(node.regex.pattern) });
    if (node.type === "Identifier" && node.name === "RegExp" && !(parent?.type === "Property" && key === "key" && !parent.shorthand) && !(parent?.type === "MemberExpression" && key === "property" && !parent.computed)) add("regexp-reference", node, "RegExp");
    if (node.type === "ObjectPattern") for (const prop of node.properties) { const k = prop.key; if (k && ((k.type === "Identifier" && k.name === "RegExp") || (k.type === "Literal" && k.value === "RegExp"))) add("regexp-reference", prop, "destructured RegExp"); }
    if (node.type === "MemberExpression") {
      if (!node.computed && node.property.name === "RegExp") add("regexp-reference", node, ".RegExp");
      if (node.computed && node.object.type === "Identifier" && GLOBALS.has(node.object.name) && !(node.property.type === "Literal")) add("global-access", node, `${node.object.name}[computed]`);
      if (node.computed && node.property.type === "Literal" && node.property.value === "RegExp") add("regexp-reference", node, '["RegExp"]');
    }
    if (node.type === "Identifier" && (node.name === "eval" || node.name === "Function") && !(parent?.type === "MemberExpression" && key === "property" && !parent.computed) && !(parent?.type === "Property" && key === "key" && !parent.shorthand)) add("dynamic-code", node, node.name);
    if (node.type === "MemberExpression" && propName(node) === "constructor") add("dynamic-code", node, ".constructor");
    if (node.type === "MemberExpression" && ALL_PATTERN_METHODS.has(propName(node)) && !(parent?.type === "CallExpression" && key === "callee")) add("pattern-method-reference", node, `.${propName(node)} used as a value (.call, .apply, .bind, an alias)`);
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.computed && node.callee.property.type !== "Literal") add("computed-method", node, `[${node.callee.property.type}](...)`);
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && propName(node.callee) !== null) {
      const name = propName(node.callee), first = node.arguments[0];
      if (PATTERN_METHODS.has(name) && !(first?.type === "Literal" && first.regex)) add("string-pattern", node, `.${name}(${first?.type ?? ""})`);
      if (MAYBE_PATTERN_METHODS.has(name) && first && !isStringLike(first) && !(first.type === "Literal" && first.regex)) add("pattern-argument", node, `.${name}(${first.type})`);
    }
    for (const k of Object.keys(node)) {
      if (k === "loc") continue;
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) walk(c, node, k);
      else if (v && typeof v === "object") walk(v, node, k);
    }
    if (named) fns.pop();
  })(ast, null, null);
  return out;
}

export function jsFiles(path) {
  if (!statSync(path).isDirectory()) return [path];
  const out = [];
  for (const f of readdirSync(path)) { const p = join(path, f); if (statSync(p).isDirectory()) out.push(...jsFiles(p)); else if (f.endsWith(".js") || f.endsWith(".mjs")) out.push(p); }
  return out;
}
export const read = (p) => readFileSync(p, "utf8");
