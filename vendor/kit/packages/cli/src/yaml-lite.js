/**
 * The YAML subset GitHub workflows use, parsed into values (not matched as text): block mappings, block sequences, flow lists,
 * block scalars (| and >), quoted and plain scalars, comments. Anchors, aliases and multi-document files are refused.
 * Used where a check must know what a workflow DOES (a schedule trigger, a job that is not disabled, a run step), never what its
 * comments say.
 */
const stripComment = (s) => {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
};
const scalar = (v) => {
  v = v.trim();
  if (/^[&*]/.test(v)) throw new Error("anchors and aliases are not supported");
  if (/^".*"$/.test(v)) return JSON.parse(v);
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (v === "{}") return {};
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).map(scalar);
  if (v === "true" || v === "false") return v === "true";
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
};

export function parseYaml(text) {
  if (/^---\s*$/m.test(text.replace(/^---\s*\n/, ""))) throw new Error("multi-document YAML is not supported");
  const lines = text.replace(/\t/g, "  ").split("\n").map((raw) => ({ raw, ind: raw.match(/^ */)[0].length }));
  let i = 0;
  const blank = (l) => !l.raw.trim() || /^\s*#/.test(l.raw);
  const skip = () => { while (i < lines.length && blank(lines[i])) i++; };
  function blockScalar(parentInd, folded) {
    const out = [];
    let ind = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.raw.trim() && l.ind <= parentInd) break;
      if (l.raw.trim() && ind === null) ind = l.ind;
      out.push(l.raw.trim() ? l.raw.slice(ind) : "");
      i++;
    }
    while (out.length && out.at(-1) === "") out.pop();
    return folded ? out.join(" ") : `${out.join("\n")}\n`;
  }
  function value(rest, ind) {
    const v = stripComment(rest).trim();
    if (v === "|" || v === "|-" || v === ">" || v === ">-") return blockScalar(ind, v[0] === ">");
    if (v === "") { skip(); return i < lines.length && lines[i].ind > ind ? node(lines[i].ind) : (i < lines.length && lines[i].ind === ind && /^\s*- /.test(lines[i].raw) ? node(ind) : null); }
    return scalar(v);
  }
  function node(ind) {
    skip();
    if (i >= lines.length) return null;
    if (/^\s*-( |$)/.test(lines[i].raw)) {
      const list = [];
      while (i < lines.length) {
        skip(); if (i >= lines.length) break;
        const l = lines[i];
        if (l.ind !== ind || !/^\s*-( |$)/.test(l.raw)) break;
        const rest = l.raw.slice(ind + 1).replace(/^ /, "");
        if (/^[^"'\s][^:]*:( |$)/.test(stripComment(rest))) {   // "- key: value" starts a mapping item
          lines[i] = { raw: " ".repeat(ind + 2) + rest, ind: ind + 2 };
          list.push(node(ind + 2));
        } else { i++; list.push(value(rest, ind)); }
      }
      return list;
    }
    const map = {};
    while (i < lines.length) {
      skip(); if (i >= lines.length) break;
      const l = lines[i];
      if (l.ind < ind) break;
      if (l.ind > ind) throw new Error(`line ${i + 1}: unexpected indentation`);
      const m = /^\s*("[^"]*"|'[^']*'|[^:#]+?)\s*:(?:\s+(.*)|\s*)$/.exec(l.raw);
      if (!m) throw new Error(`line ${i + 1}: not a mapping entry`);
      i++;
      map[String(scalar(m[1]))] = value(m[2] ?? "", ind);
    }
    return map;
  }
  return node(0);
}
