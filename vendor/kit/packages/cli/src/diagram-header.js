/**
 * The `%% kit:diagram {…}` header of a diagram source (docs/DIAGRAMS.md, the lineage rule): reading, writing, placing it.
 * Pure text functions; the schema (kit.diagram.v1) and the checks live in diagram-lineage.js.
 */
export const HEADER_RE = /^\s*%%\s*kit:diagram\s+(\{.*\})\s*$/;
const KEY_ORDER = ["id", "title", "project", "kind", "summary", "lineage", "relates_to", "depicts", "reviewed", "generated"];

/** The first duplicated key of a JSON text (JSON.parse keeps the last silently), as `"key" (path)`, or null. A small tokenizer: strings, objects, arrays. */
export function duplicateKey(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => { const s = i; i++; while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; i++; return JSON.parse(text.slice(s, i)); };
  const value = (path) => {
    ws();
    if (text[i] === "{") {
      i++; const seen = new Set();
      for (;;) {
        ws(); if (text[i] === "}") { i++; return null; }
        const k = str();
        if (seen.has(k)) return `"${k}" (${path || "top level"})`;
        seen.add(k); ws(); i++;   // :
        const d = value(`${path}/${k}`); if (d) return d;
        ws(); if (text[i] === ",") i++;
      }
    }
    if (text[i] === "[") {
      i++; let n = 0;
      for (;;) { ws(); if (text[i] === "]") { i++; return null; } const d = value(`${path}[${n++}]`); if (d) return d; ws(); if (text[i] === ",") i++; }
    }
    if (text[i] === '"') { str(); return null; }
    while (i < text.length && !/[,\]}\s]/.test(text[i])) i++;
    return null;
  };
  try { return value(""); } catch { return null; /* a header value that does not parse is reported as missing by the caller */ }
}

/**
 * { header, error } of a diagram source. The `%% kit:diagram {…}` header is the line IMMEDIATELY after the theme's init line (the first
 * line when there is no init line); one line of JSON without duplicate keys. header null with no error when absent.
 */
export function readHeader(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const found = [];
  lines.forEach((l, i) => { if (/^\s*%%\s*kit:diagram\b/.test(l)) found.push(i); });
  if (!found.length) return { header: null };
  if (found.length > 1) return { header: null, error: "more than one kit:diagram header" };
  const first = lines.findIndex((l) => l.trim());
  const want = first >= 0 && lines[first].trim().startsWith("%%{init") ? first + 1 : Math.max(first, 0);
  if (found[0] !== want) return { header: null, error: "the kit:diagram header must be the line immediately after the init line (kit diagrams migrate places it)" };
  const m = lines[found[0]].match(HEADER_RE);
  if (!m) return { header: null, error: "the kit:diagram header must be one line `%% kit:diagram {…}` of JSON" };
  const dup = duplicateKey(m[1]);
  if (dup) return { header: null, error: `the kit:diagram header repeats the key ${dup}` };
  try { return { header: JSON.parse(m[1]), line: found[0] }; }
  catch (e) { return { header: null, error: `the kit:diagram header is not valid JSON (${e.message})` }; }
}

/** The one-line comment for a header object (keys in the canonical order). */
export function headerLine(h) {
  const o = {};
  for (const k of KEY_ORDER) if (h[k] !== undefined) o[k] = h[k];
  for (const k of Object.keys(h)) if (o[k] === undefined) o[k] = h[k];
  return `%% kit:diagram ${JSON.stringify(o)}`;
}

/** The source with its header set (replaced in place, or inserted after the init line / at the top). */
export function withHeader(source, h) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const cur = readHeader(source);
  const line = headerLine(h);
  if (cur.line !== undefined) { lines[cur.line] = lines[cur.line].match(/^\s*/)[0] + line; return lines.join("\n"); }
  const first = lines.findIndex((l) => l.trim());
  const at = first >= 0 && lines[first].trim().startsWith("%%{init") ? first + 1 : Math.max(first, 0);
  const indent = first >= 0 ? lines[first].match(/^\s*/)[0] : "";
  lines.splice(at, 0, indent + line);
  return lines.join("\n");
}

