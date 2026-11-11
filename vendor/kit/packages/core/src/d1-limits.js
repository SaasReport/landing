/**
 * Cloudflare D1's SQLite limits that a stock SQLite (node:sqlite, the local tests) does not have, so SQL that passes every local test can
 * still fail in production. Measured on D1 (2026-10-07, read-only SELECTs): a LIKE or GLOB pattern of 50 bytes runs, 51 bytes fails with
 * "LIKE or GLOB pattern too complex: SQLITE_ERROR" (SQLITE_LIMIT_LIKE_PATTERN_LENGTH; stock SQLite allows 50000).
 *
 *   D1_LIMITS                   the limits: pattern bytes (measured), statement bytes, bound parameters and value bytes (Cloudflare's
 *                               published D1 limits, developers.cloudflare.com/d1/platform/limits)
 *   patternProblems(sql)        every GLOB / LIKE literal in `sql` (single-quoted, joined by ||) that D1 refuses → [{ op, pattern, bytes }];
 *                               patternOperands(sql) lists every pattern with literal: false for one whose length the text cannot show
 *   sqlStatements, commentProblems, placeholderCount, unsupportedProblems   one tokenizer (tokenize) behind all of them
 *   withD1Limits(db)            a node:sqlite DatabaseSync that refuses what D1 refuses (glob() and like() replaced): tests use it, so a
 *                               trigger, query or migration that D1 cannot run fails locally too
 *
 * Runtime-neutral (no I/O); withD1Limits needs a node:sqlite DatabaseSync (`function(name, options, fn)`, and its constructor for the
 * second connection that evaluates the native operators).
 */

import REGISTRY_JSON from "../registry/d1-unsupported.json" with { type: "json" };

const freeze = (v) => (v && typeof v === "object" ? Object.freeze(Array.isArray(v) ? v.map(freeze) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, freeze(x)]))) : v);
const REGISTRY = freeze(REGISTRY_JSON);

/**
 * What remote D1 refuses that a stock SQLite runs. The numeric limits are here (measured, or Cloudflare's published ones); every refused statement,
 * function, virtual table module and PRAGMA is DATA in packages/core/registry/d1-unsupported.json (schema d1-unsupported, a Cloudflare source per entry),
 * exposed as D1_LIMITS.unsupported and enforced wherever statements run (withD1Limits: exec and prepare) and by `kit check migrations`.
 */
export const D1_LIMITS = Object.freeze({
  likePatternBytes: 50, statementBytes: 100_000, boundParameters: 100, valueBytes: 2_000_000,
  unsupported: REGISTRY,
});

/** D1's own error text, so a test can match what production says. */
export const PATTERN_TOO_COMPLEX = "LIKE or GLOB pattern too complex";

const bytes = (s) => new TextEncoder().encode(String(s)).length;

/**
 * THE tokenizer of this module (sqlStatements, placeholderCount, commentProblems and patternOperands all read it, never the raw text): a list of
 * { t, v, start, end } where t is "str" (a '...', "..." or `...` literal or a [...] name, v = its text without the quotes and with doubled quotes
 * undone, q = the quote), "line" (-- to the end of the line), "block" (a block comment, to its close or the end), "ws", "param" (?, ?NNN, :name,
 * @name, $name), "word" and "punct" (a single character; || is one token). Nothing else reads quotes or comments.
 */
export function tokenize(sql) {
  const src = String(sql), out = [];
  let i = 0;
  const push = (t, start, end, extra = {}) => out.push({ t, v: src.slice(start, end), start, end, ...extra });
  while (i < src.length) {
    const c = src[i], s = i;
    if (/\s/.test(c)) { while (i < src.length && /\s/.test(src[i])) i++; push("ws", s, i); continue; }
    if (c === "-" && src[i + 1] === "-") { while (i < src.length && src[i] !== "\n") i++; push("line", s, i); continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; push("block", s, i); continue; }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let value = "";
      for (i++; i < src.length; i++) {
        if (src[i] === close) { if (close !== "]" && src[i + 1] === close) { value += close; i++; continue; } break; }
        value += src[i];
      }
      i = Math.min(i + 1, src.length);
      push("str", s, i, { v: value, q: c });
      continue;
    }
    if (c === "?") { i++; while (/\d/.test(src[i] || "")) i++; push("param", s, i); continue; }
    if ((c === ":" || c === "@" || c === "$") && /[A-Za-z_]/.test(src[i + 1] || "")) { i++; while (/[\w$]/.test(src[i] || "")) i++; push("param", s, i); continue; }
    if (/[A-Za-z_]/.test(c)) { while (/[\w$]/.test(src[i] || "")) i++; push("word", s, i); continue; }
    if (c === "|" && src[i + 1] === "|") { i += 2; push("punct", s, i); continue; }
    i++; push("punct", s, i);
  }
  return out;
}

/** The meaningful tokens (no whitespace, no comment). */
const sig = (tokens) => tokens.filter((x) => x.t !== "ws" && x.t !== "line" && x.t !== "block");

/**
 * Every GLOB / LIKE (the operators, and the glob() / like() function forms) of a script with its pattern operand → [{ op, bytes, literal, text }].
 * The operand is a literal when it is one or more '...' literals joined by || and the next token does not extend the expression (an operator or a parenthesis: COLLATE and the keywords do not) (the bytes are the joined length: the pattern D1 measures);
 * anything else (a "..." identifier, a column, a parameter, a call, a sub-select, a tail after ||) is literal: false with bytes null, because D1's limit on it cannot be
 * shown from the text.
 */
const EXTENDS = new Set(["||", "+", "-", "*", "/", "%", "(", ".", "|", "&", "<", ">"]);   // what makes the chain longer or another expression; COLLATE, ESCAPE and every keyword leave the pattern as it is

export function patternOperands(sql) {
  const toks = sig(tokenize(sql)), out = [];
  const NON = (at) => ({ literal: false, bytes: null, text: "", next: at });
  const operand = (at) => {
    let text = "", j = at;
    for (;;) {
      const t = toks[j];
      if (!t || t.t !== "str" || t.q !== "'") return NON(at);   // "..." is an identifier first in SQLite; a column, call, parameter or sub-select is not a literal either
      text += t.v; j++;
      if (toks[j]?.v === "||") { j++; continue; }   // after || the next token must again be a '...' literal, else the tail is not one
      break;
    }
    const next = toks[j];
    return next && EXTENDS.has(next.v) ? NON(at) : { literal: true, bytes: bytes(text), text, next: j };   // the literal is the pattern unless the next token extends the expression
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== "word" || !/^(GLOB|LIKE)$/i.test(t.v)) continue;
    const op = t.v.toUpperCase();
    if (toks[i + 1]?.v === "(") {
      // glob('p', x) / like('p', x): the first argument, a literal followed by a comma; otherwise `x LIKE (expr)`: an operand that is not a literal
      const o = operand(i + 2);
      out.push({ op, ...(o.literal && toks[o.next]?.v === "," ? o : { literal: false, bytes: null, text: "", next: i + 1 }) });
    } else if (toks[i - 1]) out.push({ op, ...operand(i + 1) });   // an operator needs a left operand; a column that happens to be named like is not one
  }
  return out;
}

/** Every GLOB / LIKE pattern of `sql` that D1 refuses → [{ op, pattern, bytes }]: literals (single-quoted, concatenated with ||) over the limit. */
export function patternProblems(sql, { max = D1_LIMITS.likePatternBytes } = {}) {
  return patternOperands(sql).filter((p) => p.literal && p.bytes > max).map((p) => ({ op: p.op, pattern: p.text, bytes: p.bytes }));
}

/** The first words of a PRAGMA after its optional schema prefix: { name, rest } where rest are the tokens after the name; null when it is not one. */
function pragmaOf(w) {
  if (w[0] !== "PRAGMA") return null;
  const at = w[2] === "." ? 3 : 1;
  return w[at] === undefined ? null : { name: w[at].toLowerCase(), rest: w.slice(at + 1) };
}

/** Why D1 does not run this ONE statement (the registry d1-unsupported.json) → [{ id, why, source }]; [] when it does. Reads the statement's own tokens. */
export function unsupportedProblems(statement) {
  const toks = sig(tokenize(statement)), w = toks.map((x) => (x.t === "str" ? x.v.toUpperCase() : x.v.toUpperCase())), out = [];
  const R = D1_LIMITS.unsupported, add = (e) => out.push({ id: e.id, why: e.why, source: e.source });
  for (const u of R.statements) if (u.starts.includes(w[0])) add(u);
  for (const f of R.functions) if (toks.some((x, i) => x.t === "word" && x.v.toLowerCase() === f.name && toks[i + 1]?.v === "(")) add(f);
  if (w[0] === "CREATE" && w[1] === "VIRTUAL") {
    const using = w.indexOf("USING"), mod = using < 0 ? null : toks[using + 1]?.v.toLowerCase();
    if (!R.virtualTables.allowedModules.includes(mod)) out.push({ id: "virtual-table-module", why: `${R.virtualTables.why} (this one uses ${mod ?? "no module"})`, source: R.virtualTables.source });
  }
  const p = pragmaOf(w);
  if (p) {
    if (!R.pragmas.supported.includes(p.name)) out.push({ id: "pragma-unsupported", why: `${R.pragmas.why} (PRAGMA ${p.name})`, source: R.pragmas.source });
    for (const r of R.pragmas.valueRefusals) {
      if (r.pragma !== p.name || (p.rest[0] !== "=" && p.rest[0] !== "(")) continue;
      const v = p.rest[1] === "(" ? p.rest[2] : p.rest[1];
      if (r.values.includes(v)) add(r);
    }
  }
  return out;
}

/** A statement of nothing but comments and semicolons: nothing for D1 to run. The one reader of that fact (the tokenizer decides what a comment is). */
export const isEmptyStatement = (statement) => sig(tokenize(statement)).every((t) => t.v === ";");

/** PRAGMA case_sensitive_like (the statement itself, decided on its tokens, never on text a comment or a string holds). */
const isCaseLike = (statement) => pragmaOf(sig(tokenize(statement)).map((x) => x.v.toUpperCase()))?.name === "case_sensitive_like";

function guard(pattern) {
  if (bytes(pattern) > D1_LIMITS.likePatternBytes) throw new Error(`${PATTERN_TOO_COMPLEX}: SQLITE_ERROR (D1 allows ${D1_LIMITS.likePatternBytes} bytes, got ${bytes(pattern)})`);
}

/**
 * A script as its statements, the way SQLite reads it: `;` ends a statement outside strings, quoted names and comments (block comments too), and
 * inside CREATE TRIGGER … BEGIN … END only the `;` after the closing END does (CASE … END nests within it). Reads tokenize().
 */
export function sqlStatements(sql) {
  const src = String(sql), out = [];
  let start = 0, depth = 0, trigger = null, seen = [];
  for (const t of tokenize(src)) {
    if (t.t === "ws" || t.t === "line" || t.t === "block") continue;
    if (trigger === null && t.t === "word") { seen.push(t.v.toUpperCase()); }
    if (trigger === null && t.t !== "ws") {
      // a trigger is a statement whose first words are CREATE [TEMP|TEMPORARY] TRIGGER (comments before it are not tokens here)
      const w = seen.length ? seen : [t.v.toUpperCase()];
      if (w[0] === "CREATE") { const k = w[1] === "TEMP" || w[1] === "TEMPORARY" ? 2 : 1; if (w.length > k) trigger = w[k] === "TRIGGER"; } else trigger = false;
    }
    if (trigger && t.t === "word") { const u = t.v.toUpperCase(); if (u === "BEGIN" || u === "CASE") depth++; else if (u === "END") depth--; }
    if (t.t === "punct" && t.v === ";" && depth <= 0) {
      const st = src.slice(start, t.end);
      if (st.replace(/;$/, "").trim()) out.push(st);
      start = t.end; depth = 0; trigger = null; seen = [];
    }
  }
  if (src.slice(start).trim()) out.push(src.slice(start));
  return out;
}

/**
 * Every `--` comment of a script that holds a `;` or a `'` → [{ line, comment, chars }]. Remote D1 splits a migration file at `;` without reading
 * comments and chokes on a quote inside one (SaasReport, 2026-10-14: migrations 75a0360 and 90746ce), so a comment says its words without either.
 * A `;` or `'` inside a string literal or a block comment is not a finding, and a `--` inside either is not a comment: the tokenizer decides.
 * (Block comments are not judged: D1's splitter is not shown to choke on them; a `--` inside one is text.)
 */
export function commentProblems(sql) {
  const out = [];
  for (const t of tokenize(sql)) {
    if (t.t !== "line") continue;
    const chars = [...new Set(t.v.slice(2).match(/[;']/g) || [])];
    if (chars.length) out.push({ line: String(sql).slice(0, t.start).split("\n").length, comment: t.v.trim(), chars });
  }
  return out;
}

/** The parameters a statement binds, counted from its SQL as SQLite numbers them (?, ?NNN, :name, @name, $name). */
export function placeholderCount(sql) {
  let n = 0;
  const named = new Set();
  for (const t of tokenize(sql)) {
    if (t.t !== "param") continue;
    if (t.v[0] === "?") { const d = t.v.slice(1); n = d ? Math.max(n, Number(d)) : n + 1; }
    else if (!named.has(t.v)) { named.add(t.v); n++; }
  }
  return n;
}

/**
 * Make a node:sqlite database refuse what D1 refuses. `X GLOB P` calls glob(P, X) and `X LIKE P [ESCAPE E]` calls like(P, X[, E]); both are
 * replaced (SQLite lets an application override them), also inside triggers, and replaced again after PRAGMA case_sensitive_like (which
 * re-registers SQLite's own like). Each statement longer than D1 accepts (exec measures every statement of a script), more bound
 * parameters than it accepts (counted from the SQL at prepare, and from every argument at bind: a named object and positional values
 * together) and values larger than it stores are refused. Only D1's limit is emulated: the match itself is SQLite's own operator,
 * evaluated on a second, untouched connection of the same build with the same case_sensitive_like, so the semantics (GLOB
 * case-sensitive, LIKE folding ASCII only, ESCAPE) cannot drift from SQLite. Returns the same database.
 */
export function withD1Limits(db) {
  const native = new db.constructor(":memory:");
  let q;
  const opts = { deterministic: true };
  const install = () => {
    q = { glob: native.prepare("SELECT ?1 GLOB ?2 AS m"), like: native.prepare("SELECT ?1 LIKE ?2 AS m"), likeEsc: native.prepare("SELECT ?1 LIKE ?2 ESCAPE ?3 AS m") };
    db.function("glob", opts, (pattern, value) => { guard(pattern ?? ""); return q.glob.get(value, pattern).m; });
    db.function("like", opts, (pattern, value) => { guard(pattern ?? ""); return q.like.get(value, pattern).m; });
    db.function("like", opts, (pattern, value, esc) => { guard(pattern ?? ""); return q.likeEsc.get(value, pattern, esc).m; });
  };
  const pragma = (sql) => { let hit = false; for (const st of sqlStatements(sql)) if (isCaseLike(st)) { native.exec(st); hit = true; } if (hit) install(); }   // only the pragma statement reaches the second connection
  install();
  const limit = (what, n, max) => { if (n > max) throw new Error(`D1 limit: ${what} ${n} > ${max}`); };
  const size = (v) => (typeof v === "string" ? bytes(v) : v instanceof Uint8Array ? v.byteLength : 0);
  const plain = (v) => v !== null && typeof v === "object" && !(v instanceof Uint8Array) && !ArrayBuffer.isView(v);
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
  const refuse = (sql) => { for (const st of sqlStatements(sql)) { const no = unsupportedProblems(st)[0]; if (no) throw new Error(`D1 does not run this statement (${no.id}): ${no.why}`); } };
  db.exec = (sql) => {
    for (const st of sqlStatements(sql)) limit("statement bytes", bytes(st), D1_LIMITS.statementBytes);
    refuse(sql);
    const r = exec(sql);
    pragma(sql);
    return r;
  };
  db.prepare = (sql, ...rest) => {
    limit("statement bytes", bytes(sql), D1_LIMITS.statementBytes);
    limit("bound parameters", placeholderCount(sql), D1_LIMITS.boundParameters);
    refuse(sql);
    const st = prepare(sql, ...rest);
    for (const m of ["run", "get", "all", "iterate"]) {
      const call = st[m].bind(st);
      st[m] = (...args) => {
        const values = args.flatMap((a) => (plain(a) ? Object.values(a) : [a]));
        limit("bound parameters", values.length, D1_LIMITS.boundParameters);
        for (const v of values) limit("value bytes", size(v), D1_LIMITS.valueBytes);
        const r = call(...args);
        pragma(sql);
        return r;
      };
    }
    return st;
  };
  return db;
}
