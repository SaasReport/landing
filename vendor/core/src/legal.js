// Legal documents as data: templates with {{fact}} placeholders and <!-- commitment: id --> markers.
// Pure. A document is publishable only when every fact it needs is supplied, every commitment it cites is
// implemented with evidence, and counsel has approved it. Nothing here decides whether the text is good law.

const PLACEHOLDER = /\{\{\s*([a-z_]+(?:\.[a-z_]+)+)\s*\}\}/g;
const COMMITMENT = /<!--\s*commitment:\s*([a-z][a-z0-9_]*)\s*-->/g;
const DRAFT_NOTE = /<!--\s*draft-note:[\s\S]*?-->\n?/g;
const META = new Set(["$schema", "registry", "version", "note"]);

export const placeholders = (md) => [...new Set([...md.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
export const commitmentsIn = (md) => [...new Set([...md.matchAll(COMMITMENT)].map((m) => m[1]))].sort();

/** Facts supplied when a document is rendered, not by the company registry. */
export const RENDER_FACTS = ["render.year", "render.effective_date"];

/** Every fact path the company registry offers, plus the generated subprocessor table and the render-time facts. */
export function factPaths(company) {
  const out = [...RENDER_FACTS];
  for (const [section, value] of Object.entries(company)) {
    if (META.has(section)) continue;
    if (section === "subprocessors") { out.push("subprocessors.table"); continue; }
    for (const key of Object.keys(value)) out.push(`${section}.${key}`);
  }
  return out.sort();
}

/** The supplied value of a fact as text, or null when it is not configured. */
export function factValue(company, path, context = {}) {
  if (path.startsWith("render.")) { const v = context[path.slice(7)]; return v === undefined || v === null ? null : String(v); }
  if (path === "subprocessors.table") {
    const rows = company.subprocessors.map((s) => `| ${s.name} | ${s.purpose} | ${s.location} |`);
    return rows.length ? rows.join("\n") : null;
  }
  const [section, key] = path.split(".");
  const v = company[section]?.[key];
  return v === null || v === undefined ? null : String(v);
}

/** Structural problems that must never exist, published or not. */
export function legalProblems({ legal, company, commitments, read }) {
  const problems = [];
  const known = new Set(factPaths(company));
  const ids = new Set(commitments.commitments.map((c) => c.id));
  const cited = new Set();
  for (const doc of legal.documents) {
    let md;
    try { md = read(doc.file); } catch { problems.push(`${doc.id}: file ${doc.file} is missing`); continue; }
    for (const p of placeholders(md)) if (!known.has(p)) problems.push(`${doc.id}: placeholder {{${p}}} is not a fact in the company registry`);
    if (/draft for counsel/i.test(md.replace(DRAFT_NOTE, ""))) problems.push(`${doc.id}: a draft notice is written as text; put it in <!-- draft-note: ... --> so it is never published`);
    for (const c of commitmentsIn(md)) { if (!ids.has(c)) problems.push(`${doc.id}: cites unknown commitment ${c}`); cited.add(c); }
  }
  for (const c of commitments.commitments) if (!cited.has(c.id)) problems.push(`commitment ${c.id} is not cited by any document (a promise nobody makes, or a document missing a clause)`);
  return problems;
}

/** What stands between each document and publication. Empty list for a document means publishable. */
export function publishBlockers({ legal, company, commitments, read }) {
  const byId = new Map(commitments.commitments.map((c) => [c.id, c]));
  const out = {};
  for (const doc of legal.documents) {
    const md = read(doc.file), list = [];
    for (const p of placeholders(md)) if (!RENDER_FACTS.includes(p) && factValue(company, p) === null) list.push(`fact not configured: ${p}`);
    for (const c of commitmentsIn(md)) { const x = byId.get(c); if (!x || x.status !== "implemented") list.push(`commitment not implemented: ${c}`); }
    if (doc.status !== "approved") list.push("not approved by counsel");
    if (!doc.effective_date) list.push("effective date not set");
    out[doc.id] = list;
  }
  return out;
}

/** Render a document with its facts. Refuses while any fact is missing; commitment markers are removed.
 *  context.year is the year of the generation date (an integer the caller derives from the period, never from a clock here);
 *  context.effective_date is the document's effective date from the registry. Draft notes are removed. */
export function renderDocument({ company, md, context = {} }) {
  const missing = placeholders(md).filter((p) => factValue(company, p, context) === null);
  if (missing.length) throw new Error(`cannot render: not configured: ${missing.join(", ")}`);
  return md.replace(DRAFT_NOTE, "").replace(COMMITMENT, "").replace(PLACEHOLDER, (_, p) => factValue(company, p, context)).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
