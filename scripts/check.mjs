// Contracts first: content against its schema, the vendored core against its recorded hashes, tokens for contrast, and the
// rule that nothing in the page source is a hardcoded registry id or a colour literal. Exits 1 with one line per problem.
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { fileHashes, readJson, walk, contrastHundredths } from "./lib.mjs";

export function problems() {
  const out = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(readJson("schemas/site.schema.json"));
  if (!validate(readJson("content/site.json"))) for (const e of validate.errors) out.push(`content/site.json${e.instancePath}: ${e.message}`);
  const src = readJson("vendor/core/SOURCE.json");
  const have = fileHashes("vendor/core");
  for (const k of new Set([...Object.keys(src.files), ...Object.keys(have)])) if (src.files[k] !== have[k]) out.push(`vendor/core/${k}: differs from SOURCE.json (vendored files are generated; run npm run sync)`);
  if (!/^[0-9a-f]{40}$/.test(src.commit)) out.push("vendor/core/SOURCE.json: commit must be a 40-character sha");
  const tokens = readJson("site/tokens.json");
  for (const [a, b] of tokens.pairs) { const r = contrastHundredths(tokens.colors[a], tokens.colors[b]); if (r < 450) out.push(`tokens: ${a} on ${b} is ${r / 100}:1, below AA 4.5:1`); }
  const ids = new Set(["stakeholders", "report-types", "roles"].flatMap((n) => { const j = readJson(`vendor/core/registry/${n}.json`); return j[Object.keys(j).find((k) => Array.isArray(j[k]))].map((x) => x.id); }));
  for (const f of [...walk("site"), ...walk("scripts")].filter((f) => /\.(js|mjs|css|html)$/.test(f) && !f.endsWith("tokens.json"))) {
    const t = readFileSync(f, "utf8");
    if (/#[0-9a-fA-F]{3,8}\b/.test(t.replace(/&#\d+;/g, ""))) out.push(`${f}: colour literal (paint with var(--c-role); colours live in site/tokens.json)`);
    for (const m of t.matchAll(/["'`]([a-z][a-z0-9_-]*)["'`]/g)) if (ids.has(m[1]) && f.startsWith("site/") ) out.push(`${f}: hardcoded registry id "${m[1]}"`);
  }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = problems();
  for (const x of p) console.error(`  - ${x}`);
  if (p.length) { console.error(`check: ${p.length} problem${p.length === 1 ? "" : "s"}`); process.exit(1); }
  console.log("ok check: content valid, vendored core intact, tokens pass AA, no hardcoded ids or colours");
}
