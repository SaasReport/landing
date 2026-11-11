/**
 * The finding-class engine (wo-0008): every rule is a contract declared in the registry (finding-class.schema.json, `detect`),
 * and this one engine runs it with canonical parsers only. Nothing here knows a class: a detector is a tree-sitter query
 * (web-tree-sitter, Microsoft's prebuilt grammars in @vscode/tree-sitter-wasm), command patterns over the commands
 * tree-sitter-bash parses (also inside a workflow or package.json, read with yaml / jsonc-parser), a JSON Schema over a
 * config (smol-toml, jsonc-parser, yaml) or over the facts git reports, or a pattern over text a CommonMark parser
 * (marked) extracted. A file its parser cannot read is a finding, never skipped.
 *
 *   runDetectors(cls, ctx) → [{ file, line, match, context, problem }]
 *   ctx = { root, files, read(file), registry, validate(value, schema) → [messages], git() → facts, commandTable(), parseArgs,
 *           today (YYYY-MM-DD, the builtin a schema detector binds) or now (the clock it is read from, UTC; the machine's when neither) }
 *
 * Custom query predicates (declared in the schema): #any-of-set? @c "set", #bound? / #not-bound? @c "name",
 * #has-descendant? / #not-has-descendant? @c "type" …, #only-children? @c "type" …, #not-references? @body @names.
 */
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { matchesGlob, posix, win32, join as joinPath, sep } from "node:path";
import { Parser, Language, Query, CaptureQuantifier } from "web-tree-sitter";
import YAML from "yaml";
import { parse as parseToml } from "smol-toml";
import { parseTree, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { marked } from "marked";
import { iso, localDay } from "@saasreport/core/dates";

const require = createRequire(import.meta.url);
let ready = null;
const grammars = new Map();
async function grammar(name) {
  if (!ready) ready = Parser.init();
  await ready;
  if (!grammars.has(name)) grammars.set(name, await Language.load(readFileSync(require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${name}.wasm`))));
  return grammars.get(name);
}
const PREDICATES = new Set(["any-of-set?", "bound?", "not-bound?", "has-descendant?", "not-has-descendant?", "only-children?", "not-references?", "param-unused?", "permissive-verdict?", "guarded-by-missing?", "within?"]);
const queries = new WeakMap();   // per grammar: the same query text compiles differently for each language
/**
 * Compile a contract's query and refuse a broken one loudly (a broken rule must never match nothing): every capture is
 * captured by some pattern (a typo in a predicate is not), the required capture is in every pattern, and every set and
 * bind a predicate names is declared.
 */
function query(lang, name, source, need = { capture: null, sets: null, binds: null }) {
  if (!queries.has(lang)) queries.set(lang, new Map());
  const cache = queries.get(lang);
  const key = `${source}\0${need.capture ?? ""}\0${(need.binds || []).join(",")}`;
  if (!cache.has(key)) {
    const q = new Query(lang, source);
    const where = `${name} query`;
    const zero = CaptureQuantifier?.Zero ?? 0;
    q.captureNames.forEach((c, i) => {
      if (!q.captureQuantifiers.some((p) => p[i] !== undefined && p[i] !== zero)) throw new Error(`${where}: @${c} is used but no pattern captures it (a typo disables the rule)`);
    });
    if (need.capture) {
      const at = q.captureNames.indexOf(need.capture);
      for (let i = 0; i < q.patternCount(); i++) if (at < 0 || !q.captureQuantifiers[i] || q.captureQuantifiers[i][at] === undefined || q.captureQuantifiers[i][at] === zero) throw new Error(`${where}: pattern ${i + 1} has no @${need.capture}: it could never report`);
    }
    for (const preds of q.predicates) for (const p of preds || []) {
      if (!PREDICATES.has(p.operator)) throw new Error(`${where}: unknown predicate #${p.operator} (known: ${[...PREDICATES].map((x) => `#${x}`).join(", ")})`);
      const word = p.operands.find((o) => o.type === "string")?.value;
      if (p.operator === "permissive-verdict?" && need.sets) for (const o of p.operands.filter((x) => x.type === "string")) if (!need.sets[o.value]) throw new Error(`${where}: set "${o.value}" is not declared in the registry`);
      if (p.operator === "any-of-set?" && need.sets && !need.sets[word]) throw new Error(`${where}: set "${word}" is not declared in the registry`);
      if ((p.operator === "bound?" || p.operator === "not-bound?") && need.binds && !need.binds.includes(word)) throw new Error(`${where}: bind "${word}" is not declared by this detector`);
    }
    cache.set(key, q);
  }
  return cache.get(key);
}
async function parse(name, text) {
  const lang = await grammar(name);   // initializes the engine before the first parser
  const p = new Parser();
  p.setLanguage(lang);
  const tree = p.parse(text);
  p.delete();
  return tree;
}

const lineOf = (text, n) => text.split("\n")[n - 1] ?? "";
const first = (s) => s.split("\n")[0].trim().slice(0, 120);
const inFiles = (spec, f) => spec.include.some((g) => matchesGlob(f, g)) && !(spec.exclude || []).some((g) => matchesGlob(f, g));

/** The first parse error of a tree, or null. */
function parseError(tree) {
  if (!tree.rootNode.hasError) return null;
  const stack = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop();
    if (n.isError || n.isMissing) return n;
    for (let i = n.childCount - 1; i >= 0; i--) if (n.child(i).hasError || n.child(i).isError || n.child(i).isMissing) stack.push(n.child(i));
  }
  return tree.rootNode;
}

function* descendants(node) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    yield n;
    for (let i = n.childCount - 1; i >= 0; i--) stack.push(n.child(i));
  }
}
const NAMES = new Set(["identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"]);

const FUNCTIONS = new Set(["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "generator_function", "function_definition"]);
const ancestors = function* (n) { for (let p = n.parent; p; p = p.parent) { yield p; if (FUNCTIONS.has(p.type)) return; } };
const unparen = (n) => { while (n && n.type === "parenthesized_expression") n = n.namedChildren[0]; return n; };
const rootName = (n) => { n = unparen(n); while (n && n.type === "member_expression") n = n.childForFieldName("object"); return n?.type === "identifier" ? n.text : null; };
const keyText = (k) => (k.type === "string" ? k.text.slice(1, -1) : k.text);

/** The dependencies of the function around a node: its parameters, and the names its body reads off them (x = param.member). */
function dependenciesOf(node) {
  let fn = null;
  for (const a of ancestors(node)) if (FUNCTIONS.has(a.type)) fn = a;
  if (!fn) return new Set();
  const params = fn.childForFieldName("parameters") || fn.childForFieldName("parameter");
  // every name a parameter binds: plain, defaulted, destructured ({ db }, { DB: store }), rest; never a type annotation
  const BINDING = new Set(["identifier", "shorthand_property_identifier_pattern"]);
  const names = new Set(params ? [...descendants(params)].filter((d) => BINDING.has(d.type) && !/type/.test(d.parent?.type || "") && !(d.parent?.type === "pair_pattern" && d.parent.childForFieldName("key")?.id === d.id)).map((d) => d.text) : []);
  const body = fn.childForFieldName("body");
  for (const d of body ? descendants(body) : []) {
    if (d.type !== "variable_declarator") continue;
    const name = d.childForFieldName("name"), value = unparen(d.childForFieldName("value"));
    if (name?.type === "identifier" && value?.type === "member_expression" && names.has(rootName(value))) names.add(name.text);   // a read off a dependency, not a lookup (a subscript is data)
  }
  return names;
}

/** Whether a condition is true when a dependency is absent: !x, x == null, x === undefined, typeof x === "undefined", either side of || and &&. */
function testsMissing(cond, deps) {
  const c = unparen(cond);
  if (!c) return false;
  if (c.type === "unary_expression" && c.child(0)?.type === "!") return deps.has(rootName(c.childForFieldName("argument")));
  if (c.type === "binary_expression") {
    const op = c.childForFieldName("operator")?.type, l = unparen(c.childForFieldName("left")), r = unparen(c.childForFieldName("right"));
    if (op === "||" || op === "&&") return testsMissing(l, deps) || testsMissing(r, deps);
    if (["==", "==="].includes(op)) {
      const nul = (x) => x && (x.type === "null" || x.type === "undefined");
      if (nul(r) && deps.has(rootName(l))) return true;
      if (nul(l) && deps.has(rootName(r))) return true;
      const tof = (x) => x?.type === "unary_expression" && x.child(0)?.type === "typeof" && deps.has(rootName(x.childForFieldName("argument")));
      const undef = (x) => x?.type === "string" && x.text.slice(1, -1) === "undefined";
      return (tof(l) && undef(r)) || (tof(r) && undef(l));
    }
  }
  return false;
}
/** Whether a condition is true only when a dependency is there: x, x.y, x != null, x !== undefined, null != x. */
function testsPresent(cond, deps) {
  const c = unparen(cond);
  if (!c) return false;
  if (c.type === "identifier" || c.type === "member_expression") return deps.has(rootName(c));
  if (c.type === "binary_expression" && ["!=", "!=="].includes(c.childForFieldName("operator")?.type)) {
    const l = unparen(c.childForFieldName("left")), r = unparen(c.childForFieldName("right"));
    const nul = (x) => x && (x.type === "null" || x.type === "undefined");
    return (nul(r) && deps.has(rootName(l))) || (nul(l) && deps.has(rootName(r)));
  }
  return false;
}

/** Whether a statement always leaves its function (return or throw, also as the last statement of a block). */
function exits(stmt) {
  if (!stmt) return false;
  if (stmt.type === "return_statement" || stmt.type === "throw_statement") return true;
  if (stmt.type === "statement_block") return exits(stmt.namedChildren.filter((c) => c.type !== "comment").at(-1));
  return false;
}

/** Whether a node sits in the branch taken when a dependency of its own function is absent. */
function guardedByMissing(node) {
  const deps = dependenciesOf(node);
  if (!deps.size) return false;
  let child = node;
  for (const a of ancestors(node)) {
    const inside = (f) => { const b = a.childForFieldName(f); return b && child.startIndex >= b.startIndex && child.endIndex <= b.endIndex; };
    if (a.type === "if_statement" && inside("consequence") && testsMissing(a.childForFieldName("condition"), deps)) return true;
    if (a.type === "if_statement" && inside("alternative") && testsPresent(a.childForFieldName("condition"), deps)) return true;   // else of if (db)
    if (a.type === "binary_expression" && ["??", "||"].includes(a.childForFieldName("operator")?.type) && inside("right") && testsPresent(a.childForFieldName("left"), deps)) return true;   // db ?? { … }
    if (a.type === "statement_block" || a.type === "program") {
      // fall-through: an earlier if (db) …return in the same block means this statement runs only when db is absent
      for (const sib of a.namedChildren) {
        if (sib.startIndex >= child.startIndex) break;
        if (sib.type === "if_statement" && !sib.childForFieldName("alternative") && testsPresent(sib.childForFieldName("condition"), deps) && exits(sib.childForFieldName("consequence"))) return true;
      }
    }
    if (a.type === "ternary_expression") {
      const cond = a.childForFieldName("condition");
      if (inside("consequence") && testsMissing(cond, deps)) return true;
      if (inside("alternative") && testsPresent(cond, deps)) return true;
    }
    child = a;
  }
  return false;
}


/** Evaluate the engine's own predicates on one match (tree-sitter evaluates #eq? / #match? / #any-of? itself). */
function holds(predicates, match, env) {
  const cap = (name) => match.captures.filter((c) => c.name === name).map((c) => c.node);
  for (const p of predicates) {
    const [a, ...rest] = p.operands;
    const nodes = a?.type === "capture" ? cap(a.name) : [];
    const words = rest.filter((o) => o.type === "string").map((o) => o.value);
    switch (p.operator) {
      case "any-of-set?": { const set = env.sets[words[0]]; if (!set) throw new Error(`query names an undeclared set "${words[0]}"`); if (!nodes.every((n) => set.includes(n.text))) return false; break; }
      case "bound?": if (!nodes.every((n) => env.bound(words[0]).has(n.text))) return false; break;
      case "not-bound?": if (nodes.some((n) => env.bound(words[0]).has(n.text))) return false; break;
      // node types name syntax nodes (named nodes): the keyword in import.meta is not the dynamic import node
      case "has-descendant?": if (!nodes.every((n) => [...descendants(n)].some((d) => d !== n && d.isNamed && words.includes(d.type)))) return false; break;
      case "not-has-descendant?": if (nodes.some((n) => [...descendants(n)].some((d) => d !== n && d.isNamed && words.includes(d.type)))) return false; break;
      case "param-unused?": {
        // a function or catch clause that never uses its parameters in its body (or has none)
        for (const n of nodes) {
          const params = n.childForFieldName("parameters") || n.childForFieldName("parameter");
          const body = n.childForFieldName("body");
          if (!params || !body) continue;
          const names = new Set([...descendants(params)].filter((d) => NAMES.has(d.type)).map((d) => d.text));
          if ([...descendants(body)].some((d) => NAMES.has(d.type) && names.has(d.text))) return false;
        }
        break;
      }
      case "permissive-verdict?": {
        // an object that grants: a pair whose key is in the first set with the value true, or in the second with false
        const [allow, deny] = words.map((w) => env.sets[w] || (() => { throw new Error(`query names an undeclared set "${w}"`); })());
        const grants = (o) => o.namedChildren.some((p) => p.type === "pair" && ((allow.includes(keyText(p.childForFieldName("key"))) && p.childForFieldName("value")?.type === "true") || (deny.includes(keyText(p.childForFieldName("key"))) && p.childForFieldName("value")?.type === "false")));
        if (!nodes.every(grants)) return false;
        break;
      }
      case "guarded-by-missing?": if (!nodes.every(guardedByMissing)) return false; break;
      case "within?": if (!nodes.every((n) => { for (let p = n.parent; p; p = p.parent) if (words.includes(p.type)) return true; return false; })) return false; break;
      case "only-children?": if (!nodes.every((n) => n.namedChildren.every((c) => words.includes(c.type)))) return false; break;
      case "not-references?": {
        const names = new Set(rest.filter((o) => o.type === "capture").flatMap((o) => cap(o.name)).flatMap((n) => [...descendants(n)].filter((d) => NAMES.has(d.type)).map((d) => d.text)));
        if (nodes.some((n) => [...descendants(n)].some((d) => NAMES.has(d.type) && names.has(d.text)))) return false;
        break;
      }
      default: throw new Error(`unknown query predicate #${p.operator}`);
    }
  }
  return true;
}

/** Every match of a query on a tree, with the engine's predicates applied. */
function run(lang, src, tree, env, need = {}) {
  const q = query(lang, need.name || "contract", src, { capture: need.capture || null, sets: env.sets, binds: env.binds });
  return q.matches(tree.rootNode).filter((m) => holds(q.predicates[m.patternIndex] || [], m, env));
}

function commentText(node) {
  return node.text.replace(/^(\/\/|\/\*|#)\s*/, "").replace(/\*\/$/, "").trim();
}
function related(reason, finding, relation) {
  if (relation === "ancestor") return reason.startIndex <= finding.startIndex && reason.endIndex >= finding.endIndex && reason.id !== finding.id;
  if (relation === "inside") return reason.startIndex >= finding.startIndex && reason.endIndex <= finding.endIndex;
  // a property of the one options object passed straight to the finding (a call), and that object's last word on it: no later
  // spread, no later pair under the same key however written (env, "env", ["env"]), no second options object
  if (relation === "option-of") {
    const obj = reason.parent, args = obj?.parent;
    if (obj?.type !== "object" || args?.type !== "arguments" || !args.parent) return false;
    if (args.parent.startIndex !== finding.startIndex || args.parent.endIndex !== finding.endIndex || args.parent.type !== finding.type) return false;
    if (args.namedChildren.filter((a) => a.type === "object").length !== 1) return false;
    // a computed key that is not one string literal ([k], ["e" + "nv"]) can name any key: it counts as the same key
    const ANY = Symbol("any key");
    const keyOf = (n) => {
      if (n.type !== "pair" && n.type !== "method_definition") return null;   // a method or accessor (get env() {}, env() {}) names a key as a pair does
      const k = n.childForFieldName(n.type === "pair" ? "key" : "name");
      if (k?.type === "computed_property_name") { const inner = k.namedChildren; return inner.length === 1 && inner[0].type === "string" ? inner[0].text.slice(1, -1) : ANY; }
      return k?.text.replace(/^(["'`])(.*)\1$/, "$2");
    };
    const key = keyOf(reason);
    const later = obj.namedChildren.filter((n) => n.startIndex > reason.startIndex);
    return !later.some((n) => n.type === "spread_element" || keyOf(n) === key || keyOf(n) === ANY || (n.type === "shorthand_property_identifier" && n.text === key));
  }
  if (relation === "first-line") return reason.startPosition.row === finding.startPosition.row && reason.startIndex >= finding.startIndex;
  if (relation === "same-line") return reason.startPosition.row === finding.endPosition.row && reason.startIndex >= finding.endIndex;
  throw new Error(`unknown relation ${relation}`);
}

/** The source units of a file for a detector: the file itself, or the strings its structured form holds at `select`. */
function units(file, text, d) {
  if (!d.embedded) return [{ text, line: 1 }];
  const out = [];
  const match = (path, sel) => sel.length === path.length && sel.every((s, i) => s === "*" || s === String(path[i]));
  const sels = d.embedded.select.map((s) => s.split("."));
  if (d.embedded.format === "yaml") {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) throw Object.assign(new Error(doc.errors[0].message), { line: doc.errors[0].linePos?.[0]?.line || 0 });
    const lineAt = (i) => text.slice(0, i).split("\n").length;
    let visits = 0;
    const walk = (node, path) => {
      if (++visits > 200000) throw new Error("more than 200000 nodes once aliases are followed: refused");   // an alias bomb
      if (YAML.isAlias(node)) return walk(node.resolve(doc), path);   // an alias runs what its anchor holds
      if (YAML.isMap(node)) for (const p of node.items) {
        const key = String(YAML.isScalar(p.key) ? p.key.value : p.key);
        walk(p.value, key === "<<" ? path : [...path, key]);   // a merge key (<<: *defaults) adds its keys here
      }
      else if (YAML.isSeq(node)) node.items.forEach((c, i) => walk(c, [...path, String(i)]));
      else if (YAML.isScalar(node) && typeof node.value === "string" && sels.some((s) => match(path, s))) {
        const block = node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
        // GitHub evaluates ${{ … }} before the shell runs: the shell sees a word in its place
        const value = d.embedded.github_expressions ? node.value.replace(/\$\{\{[\s\S]*?\}\}/g, "GITHUB_EXPRESSION") : node.value;
        out.push({ text: value, line: lineAt(node.range[0]) + (block ? 1 : 0) });
      }
    };
    walk(doc.contents, []);
  } else {
    const errors = [];
    const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
    if (!root || errors.length) throw Object.assign(new Error(errors.length ? `${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}` : "not JSON"), { line: errors.length ? text.slice(0, errors[0].offset).split("\n").length : 0 });
    const walk = (node, path) => {
      if (node.type === "string" && sels.some((s) => match(path, s))) out.push({ text: node.value, line: text.slice(0, node.offset).split("\n").length });
      if (node.type === "object") for (const p of node.children || []) walk(p.children[1], [...path, p.children[0].value]);
      if (node.type === "array") (node.children || []).forEach((c, i) => walk(c, [...path, String(i)]));
    };
    walk(root, []);
  }
  return out;
}

const isTemplate = (registry, f) => (registry.templates?.include || []).some((g) => matchesGlob(f, g));
const grammarOf = (registry, f) => registry.grammars[f.slice(f.lastIndexOf("."))];

/** What a JS file imports, as module specifiers: static and dynamic import, re-export, require. The parsed source, never the text: a comment or a string is no import. */
const IMPORTS = `(import_statement source: (string (string_fragment) @spec))
(export_statement source: (string (string_fragment) @spec))
(call_expression function: (import) arguments: (arguments . (string (string_fragment) @spec)))
(call_expression function: (identifier) @fn arguments: (arguments . (string (string_fragment) @spec)) (#eq? @fn "require"))`;

/** The repository paths a file imports through relative specifiers (the bare ones are packages, named by importedSpecifiers). */
export async function importedPaths(file, text, registry) {
  return (await importedSpecifiers(file, text, registry)).filter((s) => s.startsWith(".")).map((s) => posix.normalize(posix.join(posix.dirname(file), s)));
}

/** Every module specifier a file imports, as written. */
export async function importedSpecifiers(file, text, registry) {
  const name = grammarOf(registry, file);
  if (!name) return [];
  const lang = await grammar(name), tree = await parse(name, text);
  try { return [...new Set(run(lang, IMPORTS, tree, { sets: {}, binds: [], bound: () => new Set() }, { name: "imports", capture: "spec" }).flatMap((m) => m.captures.filter((c) => c.name === "spec").map((c) => c.node.text)))]; } finally { tree.delete(); }
}

/**
 * Whether a file is one of the modules or reaches one of them through relative imports, to a fixed point (any depth; a visited set, so a
 * cycle ends). `read(path)` returns a file's text, or null for a path that is no file here (a package, a directory, a missing file): there is
 * nothing to follow in it. `cache` (path to its imports) is shared by the files of one run: each file is parsed once.
 */
export async function inModuleSet(file, modules, registry, read, cache = new Map()) {
  const seen = new Set(), queue = [file];
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (modules.includes(cur)) return true;
    if (!cache.has(cur)) {
      const text = read(cur);
      cache.set(cur, text === null || text === undefined ? [] : await importedPaths(cur, text, registry));
    }
    queue.push(...cache.get(cur));
  }
  return false;
}

const importCaches = new WeakMap();   // per run (ctx): what each file imports, parsed once

async function queryDetector(cls, d, ctx) {
  const out = [];
  const scoped = [];
  if (!importCaches.has(ctx)) importCaches.set(ctx, new Map());
  const here = new Set(ctx.files), cache = importCaches.get(ctx), read = (p) => (here.has(p) ? ctx.read(p) : null);
  for (const x of ctx.files.filter((x) => inFiles(d.files, x))) {
    if (d.files.importing && !(await inModuleSet(x, d.files.importing, ctx.registry, read, cache))) continue;
    if (d.files.not_importing && (await inModuleSet(x, d.files.not_importing, ctx.registry, read, cache))) continue;
    scoped.push(x);
  }
  for (const f of scoped) {
    const name = d.grammar || grammarOf(ctx.registry, f);
    if (!name) throw new Error(`${f} matches the detector's files but no grammar is declared for it: a file a contract covers is never skipped`);
    if (!d.embedded && isTemplate(ctx.registry, f)) continue;   // a declared template: checked as the build renders it
    const lang = await grammar(name), text = ctx.read(f);
    for (const u of units(f, text, d)) {
      const tree = await parse(name, u.text);
      const err = parseError(tree);
      if (err) { out.push({ file: f, line: u.line + err.startPosition.row, match: "parse error", context: first(lineOf(u.text, err.startPosition.row + 1)), problem: `${name} cannot parse this file: a gate never skips what it cannot read; fix the syntax` }); tree.delete(); continue; }
      const cache = new Map();
      const env = { sets: ctx.registry.sets, binds: (d.bind || []).map((b) => b.as), bound: (n) => {
        if (!cache.has(n)) {
          const names = new Set();
          for (const b of (d.bind || []).filter((x) => x.as === n)) { for (const x of b.default || []) names.add(x); for (const m of run(lang, b.query, tree, env, { name: `bind ${b.as}`, capture: "name" })) for (const c of m.captures) if (c.name === "name") names.add(c.node.text); }
          cache.set(n, names);
        }
        return cache.get(n);
      } };
      const reasons = (d.unless || []).map((x) => ({ ...x, nodes: run(lang, x.query, tree, env, { name: "unless", capture: "reason" }).flatMap((m) => m.captures.filter((c) => c.name === "reason").map((c) => c.node)) }));
      const seen = new Set();
      for (const m of run(lang, d.query, tree, env, { name: cls.id, capture: "finding" })) {
        const node = m.captures.find((c) => c.name === "finding").node;   // every pattern captures it (checked at compile)
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        const excused = reasons.some((r) => r.nodes.some((n) => related(n, node, r.relation) && (r.min_length === undefined || (n.type === "comment" ? commentText(n).length >= r.min_length : true))));
        if (excused) continue;
        const line = u.line + node.startPosition.row;
        out.push({ file: f, line, col: node.startPosition.column + 1, match: node.text.replace(/\s+/g, " ").trim().slice(0, 120), context: first(lineOf(text, line)), problem: d.problem });
      }
      tree.delete();
    }
  }
  return out;
}

/** The value of a parsed bash word: quotes and escapes resolved by the grammar's own nodes. */
function wordOf(n) {
  if (n.type === "string") return (n.namedChildren.map((c) => c.text).join("") || n.text.slice(1, -1)).replace(/\\\n/gu, "").replace(/\\([\\"$`])/gu, "$1");
  if (n.type === "raw_string") return n.text.slice(1, -1);
  if (n.type === "concatenation") return n.namedChildren.map(wordOf).join("");
  if (n.type === "word" || n.type === "command_name") return n.text.replace(/\\\n/gu, "").replace(/\\(.)/gsu, "$1");   // n\pm is npm, \; is ;
  return n.text;
}
// a word known only when the step runs ($X, ${{ … }}, $(…)) is carried as RUNTIME + its text: it may be any word, so a
// pattern that tests its position matches it (npm $SUB -g x, npx "$PKG")
const RUNTIME = "\u0000";
const atRuntime = (w) => w.startsWith(RUNTIME);
const shownWord = (w) => (atRuntime(w) ? w.slice(1) : w);
const matcherOk = (m, w, sets) => atRuntime(w) || (typeof m === "string" ? m === w : m.in ? (sets[m.in] || (() => { throw new Error(`undeclared set ${m.in}`); })()).includes(w) : new RegExp(m.re, "u").test(w));
/**
 * How many following words an option takes as values, from the flags a command declares: a whole word (--rcfile f, -o x),
 * a GNU long option abbreviated to a prefix of a declared one (--kill 5 for --kill-after, where the command allows it), or
 * a cluster of short options. A getopt cluster ends at its first letter that takes a value: the rest of the word is that
 * value (-udeploy, -wpkg) or, when nothing is left, the next word is (-Eu deploy). A shell reads every letter of a cluster
 * and each letter that takes a value takes the next word in turn (bash -euo pipefail, -oO pipefail extglob).
 */
function valuesTaken(flags, w, { shell = false, abbreviate = false } = {}) {
  const has = (f) => (flags || []).includes(f);
  if (w.includes("=")) return 0;
  if (has(w)) return 1;
  if (abbreviate && /^--[^-]/.test(w) && (flags || []).some((f) => f.startsWith("--") && f.startsWith(w))) return 1;
  const m = /^([-+])([A-Za-z0-9]{2,})$/.exec(w);
  if (!m) return 0;
  const letters = [...m[2]];
  if (shell) return letters.filter((c) => has(m[1] + c)).length;
  const at = letters.findIndex((c) => has(m[1] + c));
  return at >= 0 && at === letters.length - 1 ? 1 : 0;
}
const takesValue = (flags, w, o) => valuesTaken(flags, w, o) > 0;

/**
 * argv with every option written out as getopt reads it: a cluster split into its letters up to the first that takes a
 * value, an attached value split off (-yp x → -y -p x, -pplaywright → -p playwright); option values and the words after
 * -- are left as they are.
 */
const expand = (flags, argv) => [argv[0], ...expandItems(flags, argv.slice(1).map((w) => ({ w }))).map((x) => x.w)];
/** The options a word names, for a flag test: each letter of a short cluster (npm exec -yp names -p), else the word. */
const named = (w) => (/^-[A-Za-z]{2,}$/.test(w) ? [...w.slice(1)].map((c) => `-${c}`) : [w]);

/**
 * Match a pattern against argv: its leading words in order, with the options a command declares (shell.value_flags) and
 * their values passed over between them; then its option and operand conditions. Options end at --. Returns
 * { rest, opts } or null.
 */
function matchPattern(p, argv0, sets, shell) {
  const valueFlags = (Object.hasOwn(shell.value_flags, argv0[0]) && shell.value_flags[argv0[0]]) || [];
  const argv = expand(valueFlags, argv0);
  const opts = [];
  let i = 0, ended = false;
  for (let k = 0; k < p.argv.length; k++) {
    if (k > 0) while (!ended && i < argv.length && argv[i].startsWith("-")) {
      if (argv[i] === "--") { ended = true; i++; break; }
      opts.push(argv[i]); i += takesValue(valueFlags, argv[i]) ? 2 : 1;
    }
    if (i >= argv.length || !matcherOk(p.argv[k], argv[i], sets)) return null;
    i++;
  }
  const rest = argv.slice(i);
  let opIndex = -1;
  const before = [];
  for (let j = 0; j < rest.length; j++) {
    if (!ended && rest[j] === "--") { ended = true; continue; }
    if (ended || !rest[j].startsWith("-")) { opIndex = j; break; }
    before.push(rest[j]);
    if (takesValue(valueFlags, rest[j])) j++;
  }
  const options = [...opts, ...before].flatMap(named);
  if (p.flag && !options.some((w) => new RegExp(p.flag, "u").test(w))) return null;
  if (p.operand && !(opIndex >= 0 && (atRuntime(rest[opIndex]) || new RegExp(p.operand, "u").test(rest[opIndex])))) return null;
  if (p.no_operand && opIndex >= 0) return null;
  if (p.unless_flag && [...opts, ...rest].some((w) => w.startsWith("-") && new RegExp(p.unless_flag, "u").test(w))) return null;
  return { rest: p.operand ? rest.slice(opIndex + 1) : rest, opts };
}

/** Each word of a list with the node it came from: options split by expand keep the node of the word they were cut from. */
function expandItems(flags, items) {
  const out = [];
  const has = (f) => (flags || []).includes(f);
  for (let i = 0; i < items.length; i++) {
    const { w, n } = items[i];
    if (w === "--") { out.push(...items.slice(i)); break; }
    if (has(w)) { out.push(items[i]); if (i + 1 < items.length) out.push(items[++i]); continue; }
    const letters = /^-[A-Za-z0-9]/.test(w) && w.length > 2 ? [...w.slice(1)] : [];
    const at = letters.findIndex((c) => has(`-${c}`));
    if (at < 0 || !/^[A-Za-z0-9]+$/.test(letters.slice(0, at + 1).join(""))) { out.push(items[i]); continue; }
    out.push(...letters.slice(0, at + 1).map((c) => ({ w: `-${c}`, n })));
    if (at < letters.length - 1) out.push({ w: letters.slice(at + 1).join(""), n });
    else if (i + 1 < items.length) out.push(items[++i]);
  }
  return out;
}

/** A long option or an abbreviation of it (--c, --comm for --command; read as it, failing towards reading); with =value, that value. */
function longOption(w, name) {
  if (!name || !w.startsWith("--")) return null;
  const [k, ...v] = w.split("=");
  if (k.length < 3 || !name.startsWith(k)) return null;
  return { attached: v.length ? v.join("=") : null };
}

/**
 * Items with the declared wrappers set aside (sudo -u deploy, timeout -s KILL 5, env -u X A=1 …), each command named by
 * its base name (sudo /usr/bin/npm is npm). A wrapper whose option carries a command line (env -S "…") returns it as
 * `line` (with the node it came from), to be read by the shell grammar with the words after it.
 */
function unwrap(items, shell) {
  const byBase = (xs) => (xs.length ? [{ ...xs[0], w: base(xs[0].w) }, ...xs.slice(1)] : xs);
  items = byBase(items);
  while (items.length && Object.hasOwn(shell.wrappers, items[0].w)) {
    const spec = shell.wrappers[items[0].w];
    const o = { abbreviate: !!spec.abbreviate };
    let operands = spec.operands || 0, ended = false;
    let rest = expandItems([...(spec.value_flags || []), ...(spec.split_flags || []).filter((f) => !f.startsWith("--"))], items.slice(1));
    while (rest.length) {
      const { w } = rest[0];
      if (!ended && w === "--") { ended = true; rest = rest.slice(1); continue; }
      if (!ended && w.startsWith("-")) {
        for (const f of spec.split_flags || []) {
          const long = f.startsWith("--") ? (spec.abbreviate ? longOption(w, f) : (w === f ? { attached: null } : w.startsWith(`${f}=`) ? { attached: w.slice(f.length + 1) } : null)) : (w === f ? { attached: null } : null);
          if (!long) continue;
          if (long.attached !== null) return { items: rest.slice(1), line: { w: long.attached, n: rest[0].n } };
          return { items: rest.slice(2), line: rest[1] || { w: "", n: rest[0].n } };
        }
        if ((spec.lookup_flags || []).includes(w)) return { items: [] };   // command -v x looks x up, runs nothing
        rest = rest.slice(takesValue(spec.value_flags, w, o) ? 2 : 1);
        continue;
      }
      if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { rest = rest.slice(1); continue; }
      if (operands > 0) { operands--; rest = rest.slice(1); continue; }
      break;
    }
    items = byBase(rest);
  }
  return { items };
}

// words whose value is known only when the step runs: expansions, substitutions, ANSI-C strings, GitHub expressions
const DYNAMIC = new Set(["simple_expansion", "expansion", "command_substitution", "process_substitution", "arithmetic_expansion", "ansi_c_string", "translated_string", "brace_expression"]);
const base = (w) => w.split("/").pop();   // /bin/bash is bash
const quote = (w) => `'${w.replace(/'/g, `'\\''`)}'`;
const dynamic = (n) => !!n && (DYNAMIC.has(n.type) || [...descendants(n)].some((x) => DYNAMIC.has(x.type)) || n.text.includes("GITHUB_EXPRESSION"));
// a command name the shell completes from the file system (np[m], n?m, /usr/bin/np*) is not known before it runs
const globbed = (n) => !!n && n.type !== "string" && n.type !== "raw_string" && /(^|[^\\])[*?[]/u.test(n.text);

/**
 * Where a shell reads its script on stdin: a here-string or here-document (read like a -c script), a file (< f, run like
 * bash f; < <(…) is built at run time), or a pipe anywhere above it (another command's output: refused).
 */
function stdinOf(node) {
  const parent = node.parent;
  const redirects = [...node.childrenForFieldName("redirect"), ...(parent?.type === "redirected_statement" ? parent.namedChildren.filter((x) => x.id !== node.id) : [])];
  for (const r of redirects) {
    if (r.type === "herestring_redirect") { const v = r.namedChildren[r.namedChildren.length - 1]; return { script: v ? wordOf(v) : "", node: v }; }
    if (r.type === "heredoc_redirect") { const b = r.namedChildren.find((x) => x.type === "heredoc_body"); return { script: b ? b.text : "", node: b }; }
    if (r.type === "file_redirect" && /^</.test(r.text.trim()) && !/^<&|^<>/.test(r.text.trim())) return dynamic(r.childForFieldName("destination") || r) ? { dynamic: true } : { file: true };
  }
  for (let cur = node; cur.parent && cur.parent.type !== "program"; cur = cur.parent) {
    if (cur.parent.type === "pipeline" && cur.parent.namedChildren[0]?.id !== cur.id) return { pipe: true };
  }
  return null;
}

/** A word known only at run time whose last path segment is written out ($HOME/.nvm/nvm.sh, "$X/npm"): that segment. */
const literalTail = (n) => /\/([A-Za-z0-9._+-]+)["']?$/.exec(n.text)?.[1] ?? null;

/**
 * The commands a bash text runs, each { row, col, argv }, and what cannot be read, each { row, col, refused } (dynamic,
 * deep, parse, foreign): one refusal never hides the other commands of the text. A word known only at run time is carried
 * in argv as RUNTIME + its text.
 */
async function commands(text, d, shell, depth = 0) {
  const tree = await parse("bash", text);
  try {
    const err = parseError(tree);
    if (err) return { error: err.startPosition.row };
    const out = [];
    const lang = await grammar("bash");
    const refuse = (row, col, refused = "dynamic") => out.push({ row, col, refused });
    // a script read from inside a command (bash -c "…", env -S "…", a here-document): its commands, placed at this row
    const script = async (text, row, col) => {
      if (depth >= 5) return refuse(row, col, "deep");
      const inner = await commands(text, d, shell, depth + 1);
      if (inner.error !== undefined) return refuse(row, col, "parse");
      for (const c of inner.list) out.push({ ...c, row, col });
    };
    const word = (x) => (dynamic(x.n) ? { ...x, w: RUNTIME + x.n.text } : x);
    // one command, as words with their nodes; levels counts the commands it is nested in (runners, find -exec)
    const one = async (items, node, row, col, levels = 0) => {
      if (levels > 5) return refuse(row, col, "deep");
      if (globbed(items[0].n)) return refuse(row, col);
      if (dynamic(items[0].n)) {
        const tail = literalTail(items[0].n);
        if (!tail) return refuse(row, col);   // a command named at run time ("$@", $SHELL -c …) cannot be read
        items = [{ ...items[0], w: tail }, ...items.slice(1)];
      }
      if (d.wrappers) {
        const u = unwrap(items, shell);
        if (u.line) {
          if (dynamic(u.line.n) || u.items.some((x) => dynamic(x.n))) return refuse(row, col);
          return script([u.line.w, ...u.items.map((x) => quote(x.w))].join(" "), row, col);
        }
        items = u.items;
        if (!items.length) return;
        if (dynamic(items[0].n)) {
          const tail = literalTail(items[0].n);
          if (!tail) return refuse(row, col);
          items = [{ ...items[0], w: tail }, ...items.slice(1)];
        }
      } else items = [{ ...items[0], w: base(items[0].w) }, ...items.slice(1)];
      const argv = items.map((x, k) => (k === 0 ? x.w : word(x).w));   // the command name is resolved above (its literal tail) or refused
      const cmd = items[0].w;
      // a command that runs another named in its arguments (find -exec … ;): that command is read too
      const sub = shell.subcommands && Object.hasOwn(shell.subcommands, cmd) ? shell.subcommands[cmd] : null;
      if (sub) {
        for (let k = 1; k < items.length; k++) {
          if (!sub.flags.includes(items[k].w)) continue;
          let e = k + 1;
          while (e < items.length && !sub.ends.includes(items[e].w)) e++;
          if (e > k + 1) await one(items.slice(k + 1, e), node, row, col, levels + 1);
          k = e;
        }
      }
      let sh = d.shells && Object.hasOwn(shell.shells, cmd) ? shell.shells[cmd] : null;
      const values = (Object.hasOwn(shell.value_flags, cmd) && shell.value_flags[cmd]) || [];
      let start = 1;
      if (sh?.after) {
        // its subcommand: the first operand after the command's own options (npm -w pkg exec …, pnpm -r exec …)
        let k = 1;
        while (k < items.length && items[k].w.startsWith("-") && items[k].w !== "--") k += takesValue(values, items[k].w) ? 2 : 1;
        if (sh.after.includes(items[k]?.w)) start = k + 1; else sh = null;
      }
      if (!sh) return void out.push({ row, col, argv });
      if (sh.foreign) return refuse(row, col, "foreign");   // pwsh -c, cmd /c: a language the gate cannot read
      if (sh.also_command) out.push({ row, col, argv });
      // the command a runner runs (npx -y sh -c …, pnpm exec npm i …, npm exec -- …): read as a command of its own
      const runs = async (rest) => { if (sh.runs_command && rest.length) await one(rest, node, row, col, levels + 1); };
      let found = null;   // { w, n } of an inline script
      if (sh.script_flag && sh.script_value) {
        // getopt: the script option takes the script as its value (su -c "…" root, npx -c "…"); su and script permute, so
        // it may follow an operand (su deploy -c "…")
        const own = `-${sh.script_flag}`;
        const ex = expandItems([...values, own], items.slice(start));
        let first = -1;
        for (let j = 0; j < ex.length; j++) {
          const w = ex[j].w;
          if (w === "--") { if (first < 0) first = j + 1; break; }
          if (!w.startsWith("-") || w === "-") { if (first < 0) first = j; if (sh.permute) continue; break; }
          if (w === own) { found = ex[j + 1] || { w: "", n: ex[j].n }; break; }
          const long = longOption(w, sh.script_long);
          if (long) { found = long.attached !== null ? { w: long.attached, n: ex[j].n } : ex[j + 1] || { w: "", n: ex[j].n }; break; }
          if (takesValue(values, w)) j++;
        }
        if (!found) { if (!sh.also_command) out.push({ row, col, argv }); return runs(first >= 0 ? ex.slice(first) : []); }
      } else if (sh.script_flag) {
        // a shell: its leading options, the script option anywhere in a cluster (bash -ec, -co pipefail), each value-taking
        // letter taking the next word in turn; the script is the first operand after them (bash -euo pipefail -c "…")
        const shellValues = values.filter((f) => f !== `-${sh.script_flag}`);
        let i = start, inline = false, fromStdin = false;
        while (i < items.length && /^[-+]./.test(items[i].w)) {
          const w = items[i++].w;
          if (w === "--") break;
          if (/^-[A-Za-z]+$/.test(w)) { if (w.includes(sh.script_flag)) inline = true; if (sh.stdin_flag && w.includes(sh.stdin_flag)) fromStdin = true; }
          const long = longOption(w, sh.script_long);
          if (long) { if (long.attached !== null) { found = { w: long.attached, n: items[i - 1].n }; break; } inline = true; continue; }
          i += valuesTaken(shellValues, w, { shell: true });
        }
        if (!found && i < items.length && dynamic(items[i].n)) {
          // a word known at run time where options end: a script file ($HOME/x.sh) when its last segment is written out
          // and no script option follows; anything else could be an option and is refused
          const later = items.slice(i + 1).some((x) => (/^-[A-Za-z]+$/.test(x.w) && x.w.includes(sh.script_flag)) || longOption(x.w, sh.script_long));
          // one double-quoted word as the last operand is a single word, never an option and its script ("$f" in a loop)
          const fileWord = literalTail(items[i].n) || (items[i].n.type === "string" && i === items.length - 1);
          if (inline || later || !fileWord) return refuse(row, col);
          return void out.push({ row, col, argv });
        }
        if (!found && inline) found = items[i] || { w: "", n: node };
        else if (!found && sh.stdin && (fromStdin || i >= items.length || ["/dev/stdin", "-"].includes(items[i].w))) {
          const input = stdinOf(node);
          if (input?.pipe || input?.dynamic) return refuse(row, col);   // a script piped in, or from <(…): refused
          if (input && !input.file) found = { w: input.script, n: input.node };
        }
        if (!found) return void out.push({ row, col, argv });   // runs a file, not an inline script
      } else if (sh.file_operand) {
        // source f / . f: runs a file; /dev/stdin reads a here-string or here-document, <(…) is built at run time
        const i = items[start]?.w === "--" ? start + 1 : start;
        if (i < items.length && dynamic(items[i].n) && !literalTail(items[i].n) && items[i].n.type !== "string") return refuse(row, col);
        if (["/dev/stdin", "-"].includes(items[i]?.w)) {
          const input = stdinOf(node);
          if (!input || input.pipe || input.dynamic) return refuse(row, col);
          if (!input.file) found = { w: input.script, n: input.node };
        }
        if (!found) return void out.push({ row, col, argv });
      } else {
        // a runner with no script option (bunx, yarn dlx), or a command whose operands are a script (eval, trap, watch):
        // its own options are passed over first
        let i = start;
        while (i < items.length && items[i].w.startsWith("-") && items[i].w !== "--" && items[i].w !== "-") i += takesValue(values, items[i].w) ? 2 : 1;
        if (items[i]?.w === "--") i++;
        if (sh.runs_command) { if (!sh.also_command) out.push({ row, col, argv }); return runs(items.slice(i)); }
        const ops = items.slice(i, sh.script_operands ? i + sh.script_operands : undefined);
        if (ops.some((x) => dynamic(x.n))) return refuse(row, col);
        found = { w: ops.map((x) => x.w).join(" "), n: null };
      }
      if (found.w === undefined || found.w === "") return refuse(row, col, "parse");
      if (dynamic(found.n)) return refuse(row, col);   // a script built at run time cannot be read: refused
      return script(found.w, row, col);
    };
    for (const m of query(lang, "commands", "(command) @c").matches(tree.rootNode)) {
      const node = m.captures[0].node, row = node.startPosition.row, col = node.startPosition.column + 1;
      const name = node.childForFieldName("name");
      if (!name) continue;
      await one([name.namedChildren[0] || name, ...node.childrenForFieldName("argument")].map((n) => ({ w: wordOf(n), n })), node, row, col);
    }
    return { list: out };
  } finally { tree.delete(); }
}

const REFUSED = {
  dynamic: ["dynamic script", "a command or script built at run time ($VAR, $(…), ${{ … }}) cannot be read before it runs, so it is refused; write the commands out"],
  deep: ["nested too deep", "commands nested deeper than 5 levels cannot be read, so they are refused; flatten the script"],
  parse: ["parse error", "bash cannot parse this script: a gate never skips what it cannot read"],
  foreign: ["foreign shell", "a script in a language the gate does not read (pwsh, cmd) is refused; run it as bash or declare it"],
};

async function commandDetector(cls, d, ctx) {
  const out = [];
  const sets = ctx.registry.sets;
  for (const f of ctx.files.filter((x) => inFiles(d.files, x))) {
    const text = ctx.read(f);
    let list;
    try { list = units(f, text, d); } catch (e) { out.push({ file: f, line: e.line || 0, match: "parse error", context: f, problem: `${d.embedded?.format} cannot parse this file (${e.message}): a gate never skips what it cannot read` }); continue; }
    for (const u of list) {
      const r = await commands(u.text, d, ctx.registry.shell);
      if (r.error !== undefined) { out.push({ file: f, line: u.line + r.error, match: REFUSED.parse[0], context: first(lineOf(u.text, r.error + 1)), problem: REFUSED.parse[1] }); continue; }
      for (const c of r.list) {
        const line = u.line + c.row;
        if (c.refused) { out.push({ file: f, line, col: c.col, match: REFUSED[c.refused][0], context: first(lineOf(u.text, c.row + 1)), problem: REFUSED[c.refused][1] }); continue; }
        const shown = c.argv.map(shownWord).join(" ");
        if ((d.refuse || []).some((p) => matchPattern(p, c.argv, sets, ctx.registry.shell))) { out.push({ file: f, line, col: c.col, match: shown.slice(0, 120), context: shown.slice(0, 160), problem: d.problem }); continue; }
        if (!d.member) continue;
        const hit = d.member.invocations.map((p) => matchPattern(p, c.argv, sets, ctx.registry.shell)).find(Boolean);
        if (!hit) continue;
        const rest = hit.rest;
        if (d.member.unless_flag && [...hit.opts, ...rest].some((w) => w.startsWith("-") && new RegExp(d.member.unless_flag, "u").test(w))) continue;
        const problem = ctx.member(d.member.in, rest, f);
        if (problem) out.push({ file: f, line, col: c.col, match: problem.match, context: shown.slice(0, 160), problem: `${problem.problem}: ${d.problem}` });
      }
    }
  }
  return out;
}

/**
 * A document with its local `$ref`s ("#/...") replaced by what they point at, so a gate judges the schema a reader sees and not the indirection (the
 * declared `deref: "local"` of a schema detector). The node's own sibling keys win over the target's; a reference that cannot be followed (not local, a
 * pointer to nothing, a cycle) stays a `$ref`, never guessed.
 */
export function derefLocal(root) {
  const at = (ref) => { let n = root; for (const k of ref.slice(2).split("/").filter(Boolean).map((x) => decodeURIComponent(x).replace(/~1/g, "/").replace(/~0/g, "~"))) { if (n !== null && typeof n === "object" && Object.hasOwn(n, k)) n = n[k]; else return undefined; } return n; };
  const go = (n, stack) => {
    if (Array.isArray(n)) return n.map((x) => go(x, stack));
    if (n === null || typeof n !== "object") return n;
    if (typeof n.$ref === "string" && n.$ref.startsWith("#/") && !stack.includes(n.$ref)) {
      const target = at(n.$ref);
      if (target !== undefined && target !== null && typeof target === "object" && !Array.isArray(target)) {
        const { $ref, ...siblings } = n;
        return go({ ...target, ...siblings }, [...stack, n.$ref]);
      }
    }
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, go(v, stack)]));
  };
  return go(root, []);
}

/** The YAML front matter of a Markdown file: { value, line } where line is the file line its first YAML line is on; a file without one is an empty object, so a required key is reported, never skipped. */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { yaml: "", line: 1 };
  return { yaml: m[1], line: 2 };
}

function parseConfig(format, text) {
  if (format === "markdown-front-matter") { const { yaml } = frontMatter(text); const v = yaml.trim() ? parseConfig("yaml", yaml) : {}; if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("the front matter is not a mapping"); return v; }
  if (format === "toml") return parseToml(text);
  if (format === "yaml") { const doc = YAML.parseDocument(text); if (doc.errors.length) throw new Error(doc.errors[0].message); return doc.toJS(); }
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: format === "jsonc", disallowComments: format === "json" });
  if (errors.length) throw new Error(`${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  return value;
}

/** The civil date (YYYY-MM-DD) of `now` in UTC, by the one date library of the kit (@saasreport/core/dates, Intl with timeZone UTC): never the machine's own zone. `now` is the clock a test injects. */
const utcToday = (now = new Date()) => iso(localDay("UTC", now));

/** The one repository config a binding reads (docs/CONSTITUTION.md: kit.canon.json declares every project-level decision). */
const CONFIG = "kit.canon.json";

/** The keys of a JSON Pointer (RFC 6901), or null when it does not start with `/`: a malformed pointer is a finding, never read as another one. */
const pointerKeys = (ptr) => (typeof ptr === "string" && ptr.startsWith("/") ? ptr.slice(1).split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~")) : null);

/** Why a repository-relative path a binding names is not one inside the repository (absolute, `..`, a symlink out), or null when it is. */
function escapesRoot(root, path) {
  if (typeof path !== "string" || !path) return "is empty";
  if (posix.isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return "is an absolute path";
  const rel = posix.normalize(path.replace(/\\/g, "/"));
  if (rel === ".." || rel.startsWith("../") || rel === ".") return "leaves the repository";
  try {
    const base = realpathSync(root), real = realpathSync(joinPath(root, rel));
    if (real !== base && !real.startsWith(base + sep)) return "leaves the repository through a link";
  } catch { /* a file that does not exist is reported by the read */ }
  return null;
}

/**
 * The values a schema detector's `bind` declares (finding-class schema), resolved from the repository: a JSON Pointer into
 * kit.canon.json, the builtin `today`, or whether files exist. Returns { values } or { errors: [{ name, text }] }: a value that
 * cannot be resolved is an error, never a default nobody declared.
 */
function resolveBinds(bind, ctx) {
  const values = {}, errors = [];
  let config;   // kit.canon.json, parsed once: { value } or { error }
  const configOf = () => {
    if (!config) { try { config = { value: parseConfig("json", ctx.read(CONFIG)) }; } catch (e) { config = { error: e.code === "ENOENT" ? "the file does not exist" : e.message }; } }
    return config;
  };
  for (const [name, src] of Object.entries(bind)) {
    if (src.builtin === "today") values[name] = ctx.today ?? utcToday(ctx.now);
    else if (src.exists) values[name] = ctx.files.some((f) => inFiles({ include: src.exists }, f));
    else if (src.pointer) {
      let c = configOf(), from = CONFIG;
      if (src.file !== undefined) {
        // a pointer into another file: the path is given in the registry, or is itself a value of kit.canon.json ({ pointer })
        let path = src.file;
        if (typeof path === "object") {
          const cfg = configOf();
          if (cfg.error) { errors.push({ name, text: `${CONFIG} cannot be read (${cfg.error}), so the file ${path.pointer} names cannot be bound` }); continue; }
          const keys = pointerKeys(path.pointer);
          if (!keys) { errors.push({ name, text: `the pointer ${JSON.stringify(path.pointer)} does not start with /: a malformed pointer is a failure, never read as another` }); continue; }
          let n = cfg.value;
          for (const part of keys) n = n !== null && typeof n === "object" && Object.hasOwn(n, part) ? n[part] : undefined;
          if (typeof n !== "string" || !n) { errors.push({ name, text: `${CONFIG} ${path.pointer} is not set to a file path: an unbound value is a failure, never a pass` }); continue; }
          path = n;
        }
        from = path;
        const out = escapesRoot(ctx.root, path);
        if (out) { errors.push({ name, text: `the file ${JSON.stringify(path)} ${out}: a binding reads only files inside the repository` }); continue; }
        try { c = { value: parseConfig(src.format || "json", ctx.read(path)) }; } catch (e) { c = { error: e.code === "ENOENT" ? "the file does not exist" : e.message }; }
      }
      if (c.error) { errors.push({ name, text: `${from} cannot be read (${c.error}), so ${src.pointer} cannot be bound` }); continue; }
      const keys = pointerKeys(src.pointer);
      if (!keys) { errors.push({ name, text: `${from}: the pointer ${JSON.stringify(src.pointer)} does not start with /: a malformed pointer is a failure, never read as another` }); continue; }
      let node = c.value, found = true;
      for (const part of keys) {
        if (node !== null && typeof node === "object" && Object.hasOwn(node, part)) node = node[part]; else { found = false; break; }
      }
      if (found) values[name] = node;
      else if (Object.hasOwn(src, "default")) values[name] = src.default;
      else { errors.push({ name, text: `${from} ${src.pointer} is not set: an unbound value is a failure, never a pass` }); continue; }
      // the declared shape of the value: a value of another type is a finding, never coerced into the schema it is substituted in
      const wrong = src.valid ? ctx.validate(values[name], src.valid) : [];
      if (wrong.length) { delete values[name]; errors.push({ name, text: `${from} ${src.pointer} is not the declared shape: ${wrong.map((e) => `${e.path || "the value"} ${e.message}`).join("; ")}` }); continue; }
      // `pick`: the value is a list of objects (each keeps its reason beside the fact) and the schema reads one property of each
      if (src.pick) {
        if (!Array.isArray(values[name]) || values[name].some((x) => x === null || typeof x !== "object" || !Object.hasOwn(x, src.pick))) { delete values[name]; errors.push({ name, text: `${from} ${src.pointer} is not a list of objects that each carry "${src.pick}"` }); continue; }
        values[name] = values[name].map((x) => x[src.pick]);
      }
    } else errors.push({ name, text: "an unknown kind of binding" });
  }
  return { values, errors };
}

const escapeRegex = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The schema with every {"$bind": name} replaced by the bound value; throws when it names a value the detector did not declare. */
function substitute(node, values, used) {
  if (Array.isArray(node)) return node.map((n) => substitute(n, values, used));
  if (node === null || typeof node !== "object") return node;
  if (Object.hasOwn(node, "$bind")) {
    const name = node.$bind;
    if (!Object.hasOwn(values, name)) throw new Error(`the schema references {"$bind": "${name}"}, which the detector does not declare in bind`);
    used.add(name);
    if (node.as !== "regex") return structuredClone(values[name]);
    if (typeof node.template !== "string" || node.template.split("{}").length !== 2) throw new Error(`{"$bind": "${name}", "as": "regex"} needs a template with exactly one {}`);
    const items = [].concat(values[name]);
    const lit = node.caseInsensitive === true ? (x) => escapeRegex(x).replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`) : escapeRegex;   // JSON Schema patterns carry no flags: a letter becomes its two cases
    return node.template.replace("{}", () => (items.length ? items.map(lit).join("|") : "(?!)"));   // no alternatives: matches nothing
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, values, used)]));
}

/**
 * The value a JavaScript module exports under a name (format "module"), read from the syntax tree as a LITERAL and nothing
 * else: the module is never imported, so no code of it runs and nothing it imports is loaded. The export is `export const
 * NAME = <literal>` (or `export default <literal>`), a literal being an object, array, string, number, true, false or null
 * built from literals: no getter or method, computed or shorthand key, spread, hole, identifier, call, template with a
 * substitution, or any other expression. The rest of the file is not read at all. Anything else is a finding that names
 * the construct and its line; a site whose series use spreads or imports writes the export as data.
 */
async function moduleExport(file, text, name) {
  const tree = await parse("javascript", text);
  try {
    const fail = (node, why) => Object.assign(new Error(`${file}:${node.startPosition.row + 1} ${why}`), { line: node.startPosition.row + 1 });
    if (tree.rootNode.hasError) {
      const bad = [...descendants(tree.rootNode)].find((n) => n.type === "ERROR" || n.isMissing) || tree.rootNode;
      throw fail(bad, "is not valid JavaScript: a file the parser cannot read is refused, never skipped");
    }
    const literal = (n) => {
      switch (n.type) {
        case "object": {
          const o = {};
          for (const c of n.namedChildren) {
            if (c.type === "comment") continue;
            if (c.type !== "pair") throw fail(c, `has ${c.type.replace(/_/g, " ")} in the literal of "${name}": only key: value pairs are data (no getter, method, shorthand or spread)`);
            const k = c.childForFieldName("key");
            if (!k || !["property_identifier", "string", "number"].includes(k.type)) throw fail(c, `has a ${k ? k.type.replace(/_/g, " ") : "missing key"} as a key in "${name}": a key is a name, a string or a number`);
            const key = k.type === "property_identifier" ? k.text : String(literal(k));
            if (key === "__proto__") throw fail(c, `has the key "__proto__" in "${name}"`);
            o[key] = literal(c.childForFieldName("value"));
          }
          return o;
        }
        case "array": {
          const items = [];
          let comma = true;   // a comma right after another, or after [, is a hole
          for (const c of n.children) {
            if (c.type === "[" || c.type === "]") continue;
            if (c.type === ",") { if (comma) throw fail(c, `has a hole in an array of "${name}"`); comma = true; continue; }
            if (c.type === "comment") continue;
            items.push(literal(c)); comma = false;
          }
          return items;
        }
        case "string": {
          let out = "";
          for (const c of n.children) {
            if (c.type === "string_fragment") out += c.text;
            else if (c.type === "escape_sequence") out += unescape(c, fail);
          }
          return out;
        }
        case "template_string":
          if (n.namedChildren.some((c) => c.type === "template_substitution")) throw fail(n, `has a template string with a substitution in "${name}": a literal has no expressions`);
          return n.text.slice(1, -1);
        case "number": {
          const t = n.text.replace(/_/g, "");
          if (/n$/.test(t)) throw fail(n, `has a bigint in "${name}": not JSON data`);
          return Number(t);
        }
        case "true": return true;
        case "false": return false;
        case "null": return null;
        case "unary_expression": {
          const arg = n.childForFieldName("argument");
          if (n.childForFieldName("operator")?.type === "-" && arg?.type === "number") return -literal(arg);
          throw fail(n, `has an expression in "${name}": only literals are data`);
        }
        default: throw fail(n, `has ${/^[aeiou]/.test(n.type) ? "an" : "a"} ${n.type.replace(/_/g, " ")} in "${name}": only literals are data (no identifier, call, spread or other expression)`);
      }
    };
    const unescape = (c, fail2) => {
      const t = c.text, simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\\": "\\", '"': '"', "'": "'", "`": "`", "/": "/" };
      const body = t.slice(1);
      if (Object.hasOwn(simple, body)) return simple[body];
      let m = /^u([0-9a-fA-F]{4})$/.exec(body) || /^x([0-9a-fA-F]{2})$/.exec(body) || /^u\{([0-9a-fA-F]+)\}$/.exec(body);
      if (m) return String.fromCodePoint(parseInt(m[1], 16));
      throw fail2(c, `has the escape ${t} in a string of "${name}"`);
    };
    for (const st of tree.rootNode.namedChildren) {
      if (st.type !== "export_statement") continue;
      const decl = st.childForFieldName("declaration");
      if (name === "default") {
        const v = st.childForFieldName("value");
        if (v && st.children.some((x) => x.type === "default")) return literal(v);
        continue;
      }
      if (decl && (decl.type === "lexical_declaration" || decl.type === "variable_declaration")) {
        for (const d of decl.namedChildren) {
          if (d.type === "variable_declarator" && d.childForFieldName("name")?.text === name) {
            const v = d.childForFieldName("value");
            if (!v) throw fail(d, `declares "${name}" without a value`);
            return literal(v);
          }
        }
      }
    }
    throw new Error(`${file} has no \`${name === "default" ? "export default" : `export const ${name} =`} <literal>\`: the module is read, never run, so the export must be written as data`);
  } finally { tree.delete(); }
}

/** Where a failing instance of a parsed file starts: the line of the key (or item) the path reaches, by the file's own parser; null when the format gives no positions. */
function locator(format, text) {
  if (format === "markdown-front-matter") {
    const { yaml, line } = frontMatter(text), at = locator("yaml", yaml);
    return (keys) => (at ? (at(keys) ?? 1) + line - 1 : null);
  }
  if (format === "yaml") {
    const lc = new YAML.LineCounter();
    const doc = YAML.parseDocument(text, { lineCounter: lc });
    return (keys) => {
      let node = doc.contents, at = null;
      for (const k of keys) {
        if (YAML.isMap(node)) { const pair = node.items.find((p) => String(YAML.isScalar(p.key) ? p.key.value : p.key) === k); if (!pair) break; at = pair.key; node = pair.value; }
        else if (YAML.isSeq(node)) { const item = node.items[Number(k)]; if (item === undefined) break; at = item; node = item; }
        else break;
      }
      const offset = at?.range?.[0] ?? doc.contents?.range?.[0];
      return offset === undefined ? null : lc.linePos(offset).line;
    };
  }
  if (format === "json" || format === "jsonc") {
    const tree = parseTree(text, [], { allowTrailingComma: format === "jsonc" });
    return (keys) => {
      let node = tree, at = tree;
      for (const k of keys) {
        if (node?.type === "array") { const item = node.children?.[Number(k)]; if (!item) break; at = item; node = item; }
        else if (node?.type === "object") { const prop = node.children?.find((c) => c.children?.[0]?.value === k); if (!prop) break; at = prop.children[0]; node = prop.children[1]; }
        else break;
      }
      return at ? text.slice(0, at.offset).split("\n").length : null;
    };
  }
  return null;
}

async function schemaDetector(cls, d, ctx) {
  const out = [];
  const files = ctx.files.filter((x) => inFiles(d.files, x));
  if (!files.length) return out;   // nothing to check: nothing to bind
  let schema = d.schema;
  const resolved = resolveBinds(d.bind || {}, ctx);
  if (resolved.errors.length) return resolved.errors.map((e) => ({ file: CONFIG, line: 0, match: `unbound ${e.name}`, context: e.text, problem: `${d.problem} (${e.text})` }));
  try {
    const used = new Set();
    schema = substitute(d.schema, resolved.values, used);
    for (const name of Object.keys(resolved.values)) if (!used.has(name)) throw new Error(`the detector declares "${name}" in bind but the schema never references it`);
  } catch (e) { return [{ file: CONFIG, line: 0, match: "bad bind", context: e.message, problem: `${d.problem} (${e.message})` }]; }
  for (const f of files) {
    const text = ctx.read(f);
    let value;
    try { value = d.format === "module" ? await moduleExport(f, text, d.export || "default") : parseConfig(d.format, text); if (d.deref === "local") value = derefLocal(value); } catch (e) { out.push({ file: f, line: e.line || 0, match: "parse error", context: f, problem: `${d.format} cannot read this file (${e.message}): a gate never skips what it cannot read` }); continue; }
    const where = d.format === "module" ? null : locator(d.format, text);
    for (const e of ctx.validate(value, schema)) {
      const keys = e.path.split("/").filter(Boolean).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
      const key = keys.at(-1) ?? f;
      // the line of the failing key by the file's own parser; a format that gives no positions (toml) falls back to the key's first mention
      const line = (where && where(keys)) || text.split("\n").findIndex((l) => l.includes(key)) + 1;
      out.push({ file: f, line, match: e.path.replace(/~1/g, "/").replace(/~0/g, "~") || key, context: first(lineOf(text, line) || e.path), problem: `${d.problem} (${e.path})` });
    }
  }
  return out;
}

async function gitDetector(cls, d, ctx) {
  const facts = ctx.git(d.probes || []);
  const unescape = (t) => t.replace(/~1/g, "/").replace(/~0/g, "~");
  return ctx.validate(facts, d.schema).map((e) => {
    // the subject is the failing entry's own path when it has one (a gitlink), else the failing key (an ignore probe)
    const keys = e.path.split("/").filter(Boolean).map(unescape);
    let node = facts, subject = null;
    for (const k of keys) { node = node?.[k]; if (node && typeof node === "object" && typeof node.path === "string") subject = node.path; }
    subject ??= keys.at(-1) ?? e.path;
    return { file: subject, line: 0, match: subject, context: e.path, problem: d.problem };
  });
}

async function textDetector(cls, d, ctx) {
  const out = [];
  const re = new RegExp(d.pattern, "giu");
  for (const f of ctx.files.filter((x) => inFiles(d.files, x))) {
    const text = ctx.read(f).replace(/\r\n?/g, "\n");
    const lineAt = (i) => text.slice(0, i).split("\n").length;
    const pieces = [];   // { text, line }: the text and the file line its first line is on
    if ((d.extract || "whole") === "whole") pieces.push({ text, line: 1 });
    else {
      // top-level tokens' raw text spans the source in order (CommonMark lexer), so their offsets are exact sums; a block
      // nested in a list or quote comes back without its indentation and is placed by its first line inside its parent's span
      const take = (t, at) => {
        const lang = t.lang?.split(/\s/)[0].replace(/^\{(.*)\}$/, "$1");   // ```mermaid and ```{mermaid}
        if (t.type === "code" && (!d.lang || lang === d.lang)) pieces.push({ text: t.raw, line: lineAt(at) });
      };
      const nested = (tokens, from, to) => {
        let cursor = from;
        for (const t of tokens) {
          const head = (t.raw.split("\n").find((l) => l.trim()) ?? "").trim();
          const at = head ? text.indexOf(head, cursor) : cursor;
          if (at < 0 || at > to) { if (t.type === "code") throw new Error(`${f}: a code block the Markdown parser found cannot be placed in the file: refused, never read at a guessed line`); continue; }
          take(t, at);
          if (t.tokens && t.type !== "code") nested(t.tokens, at, to);
          if (t.items) nested(t.items, at, to);
          cursor = at + Math.max(head.length, 1);
        }
      };
      let offset = 0;
      for (const t of marked.lexer(text)) {
        take(t, offset);
        if (t.tokens && t.type !== "code") nested(t.tokens, offset, offset + t.raw.length);
        if (t.items) nested(t.items, offset, offset + t.raw.length);
        offset += t.raw.length;
      }
      if (offset !== text.length) throw new Error(`${f}: the Markdown parser's blocks do not span the file (${offset} of ${text.length} characters): refused, never read at guessed lines`);
    }
    for (const p of pieces) for (const m of p.text.matchAll(re)) {
      const before = p.text.slice(0, m.index).split("\n");
      const line = p.line + before.length - 1;
      out.push({ file: f, line, col: before.pop().length + 1, match: m[0], context: first(lineOf(text, line)), problem: d.problem });
    }
  }
  return out;
}

const KINDS = { query: queryDetector, command: commandDetector, schema: schemaDetector, git: gitDetector, text: textDetector };

/** Every finding of one class's contract over the context. */
export async function runDetectors(cls, ctx) {
  const out = [], seen = new Set();
  for (const d of cls.detect) for (const f of await KINDS[d.kind](cls, d, ctx)) {
    const key = `${f.file}\0${f.line}\0${f.col ?? ""}\0${f.match}`;   // one instance: the same place and text
    if (!seen.has(key)) { seen.add(key); out.push(f); }   // two detectors of one class reporting the same instance report it once
  }
  return out;
}
