/**
 * The TOML wrangler configs use, parsed into values; anything else is an ERROR, never silently skipped (review M8): tables `[a.b]`,
 * arrays of tables `[[a.b]]`, dotted keys `a.b = 1`, basic and literal strings (and their multi-line forms), integers, floats, booleans,
 * dates kept as strings, arrays (multi-line, trailing comma) and inline tables. A line it cannot read throws with its line number.
 */
export class TomlError extends Error { constructor(m, line) { super(`TOML line ${line}: ${m}`); this.name = "TomlError"; this.line = line; } }

const ESC = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

export function parseToml(text) {
  const src = String(text).replace(/\r\n/g, "\n");
  let i = 0, line = 1;
  const root = {};
  let cur = root;
  const err = (m) => { throw new TomlError(m, line); };
  const peek = (n = 0) => src[i + n];
  const ws = () => { while (i < src.length && (src[i] === " " || src[i] === "\t")) i++; };
  const comment = () => { if (src[i] === "#") while (i < src.length && src[i] !== "\n") i++; };
  const wsnl = () => { for (;;) { ws(); comment(); if (src[i] === "\n") { i++; line++; continue; } break; } };
  const eol = () => { ws(); comment(); if (i < src.length && src[i] !== "\n") err(`unexpected "${src.slice(i, i + 20)}"`); if (src[i] === "\n") { i++; line++; } };

  function bareKey() {
    ws();
    if (src[i] === '"' || src[i] === "'") return string();
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 200));
    if (!m) err("a key is expected");
    i += m[0].length;
    return m[0];
  }
  function keyPath() { const ks = [bareKey()]; ws(); while (src[i] === ".") { i++; ks.push(bareKey()); ws(); } return ks; }

  function string() {
    const q = src[i];
    const multi = src.startsWith(q.repeat(3), i);
    i += multi ? 3 : 1;
    if (multi && src[i] === "\n") { i++; line++; }
    let out = "";
    for (;;) {
      if (i >= src.length) err("unterminated string");
      if (multi ? src.startsWith(q.repeat(3), i) : src[i] === q) { i += multi ? 3 : 1; return out; }
      const c = src[i];
      if (c === "\n") { if (!multi) err("newline in a string"); line++; out += c; i++; continue; }
      if (q === '"' && c === "\\") {
        const e = src[i + 1];
        if (multi && e === "\n") { i += 2; line++; while (/[ \t\n]/.test(src[i] || "")) { if (src[i] === "\n") line++; i++; } continue; }
        if (e in ESC) { out += ESC[e]; i += 2; continue; }
        if (e === "u" || e === "U") { const n = e === "u" ? 4 : 8; out += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + n), 16)); i += 2 + n; continue; }
        err(`bad escape \\${e}`);
      }
      out += c; i++;
    }
  }
  function value() {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") return string();
    if (c === "[") {
      i++; const arr = [];
      for (;;) { wsnl(); if (src[i] === "]") { i++; return arr; } arr.push(value()); wsnl(); if (src[i] === ",") { i++; continue; } if (src[i] === "]") { i++; return arr; } err("',' or ']' expected in an array"); }
    }
    if (c === "{") {
      i++; const obj = {};
      ws(); if (src[i] === "}") { i++; return obj; }
      for (;;) { const ks = keyPath(); ws(); if (src[i] !== "=") err("'=' expected in an inline table"); i++; set(obj, ks, value()); ws(); if (src[i] === ",") { i++; continue; } if (src[i] === "}") { i++; return obj; } err("',' or '}' expected in an inline table"); }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 100));
    if (!m) err("a value is expected");
    i += m[0].length;
    const v = m[0];
    if (v === "true" || v === "false") return v === "true";
    if (/^[+-]?(\d[\d_]*)$/.test(v)) return Number(v.replace(/_/g, ""));
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(v)) return Number(v.replace(/_/g, ""));
    if (/^0x[0-9a-fA-F_]+$/.test(v)) return parseInt(v.replace(/_/g, ""), 16);
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(v)) return v;
    err(`"${v}" is not a TOML value`);
  }
  function set(obj, ks, v) {
    let o = obj;
    for (const k of ks.slice(0, -1)) { if (o[k] == null) o[k] = {}; else if (typeof o[k] !== "object") err(`"${k}" is already a value`); o = Array.isArray(o[k]) ? o[k].at(-1) : o[k]; }
    const last = ks.at(-1);
    if (last in o) err(`duplicate key "${ks.join(".")}"`);
    o[last] = v;
  }
  function table(ks, array) {
    let o = root;
    for (const k of ks.slice(0, -1)) { if (o[k] == null) o[k] = {}; o = Array.isArray(o[k]) ? o[k].at(-1) : o[k]; if (typeof o !== "object") err(`"${k}" is not a table`); }
    const last = ks.at(-1);
    if (array) { if (o[last] == null) o[last] = []; if (!Array.isArray(o[last])) err(`"${ks.join(".")}" is not an array of tables`); o[last].push({}); return o[last].at(-1); }
    if (o[last] == null) o[last] = {}; else if (typeof o[last] !== "object" || Array.isArray(o[last])) err(`"${ks.join(".")}" is already defined`);
    return o[last];
  }
  for (;;) {
    wsnl();
    if (i >= src.length) return root;
    if (src[i] === "[") {
      const array = src[i + 1] === "[";
      i += array ? 2 : 1;
      const ks = keyPath(); ws();
      if (!src.startsWith(array ? "]]" : "]", i)) err("unclosed table header");
      i += array ? 2 : 1;
      cur = table(ks, array);
      eol();
      continue;
    }
    const ks = keyPath(); ws();
    if (src[i] !== "=") err("'=' expected after a key");
    i++;
    set(cur, ks, value());
    eol();
  }
}
