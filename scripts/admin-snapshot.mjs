// The admin's build snapshot: what the Worker needs from the repository and cannot read at run time (a Worker has no file system).
// Derived from the core registries (vendor/core), the lead forms (src/forms.js), the admin config and, when the repository holds
// them, the kit's provisioning registry and release record. Nothing here is typed twice.
//   node scripts/admin-snapshot.mjs            write workers/admin/generated/snapshot.json
//   node scripts/admin-snapshot.mjs --check    exit 1 when the file differs from what the sources give
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FORMS } from "../src/forms.js";
import { publishBlockers } from "../vendor/core/src/legal.js";
import { nameProblems } from "../vendor/core/src/naming.js";

const root = new URL("../", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const optional = (p) => (existsSync(new URL(p, root)) ? read(p) : { available: false });
const OUT = "workers/admin/generated/snapshot.json";

const config = read("workers/admin/admin.config.json");
const naming = read("vendor/core/registry/naming.json");
const source = read("vendor/core/SOURCE.json");
const reg = (n) => read(`vendor/core/registry/${n}.json`);
const R = { stakeholders: reg("stakeholders"), metrics: reg("metrics"), "report-types": reg("report-types"), findings: reg("findings"), commitments: reg("commitments"), legal: reg("legal"), company: reg("company") };

const metricName = new Map(R.metrics.metrics.map((m) => [m.id, m.name]));
const findings = R.findings.rules.map((r) => ({ ...r, evidence_metrics: (r.evidence || []).map((id) => ({ id, name: metricName.get(id) ?? null })) }));

// legal: core's publishBlockers reads each document's Markdown. The vendored copy of core holds the registries only, so a document's text is
// not there: its placeholders and the commitments it cites cannot be checked, and the view says so (text_checked false) instead of reporting a clean list.
const have = (doc) => existsSync(new URL(`vendor/core/${doc.file}`, root));
const blockers = publishBlockers({ legal: R.legal, company: R.company, commitments: R.commitments, read: (file) => (existsSync(new URL(`vendor/core/${file}`, root)) ? readFileSync(new URL(`vendor/core/${file}`, root), "utf8") : "") });
const legal = R.legal.documents.map((d) => ({ ...d, text_checked: have(d), blockers: blockers[d.id] ?? [] }));
const legalNotes = R.legal.documents.some((d) => !have(d)) ? [`The vendored copy of ${source.repo} holds the registries only, not legal/*.md: the facts a document needs and the commitments it cites are not checked here. The blockers listed are the ones the registry alone proves (counsel approval, effective date).`] : [];

const pattern = (kind) => naming.kinds.find((k) => k.id === kind).pattern;
const fill = (kind, values) => pattern(kind).replace(/\{(\w+)\}/g, (_, k) => values[k]);
const planned = [
  { kind: "worker", name: fill("worker", { component: config.component, env: "production" }) },
  { kind: "d1", name: fill("d1", { component: config.component, env: "production" }) },
  { kind: "hostname_production", name: fill("hostname_production", { sub: config.component }) },
].map((p) => { const problem = nameProblems(naming, p.kind, p.name)[0]; return { ...p, registry_valid: !problem, ...(problem ? { problem: `${problem} (the component and the sub "${config.component}" wait for ${naming.github_org}/core claude/naming-admin)` } : {}) }; });

const hosts = Object.fromEntries(naming.values.sub.map((s) => [s, fill("hostname_production", { sub: s })]));

const snapshot = {
  schema: "saasreport.admin-snapshot.v1",
  project: naming.project, domain: naming.domain, repository: `${naming.github_org}/${naming.values.repo.find((r) => r === "landing")}`, site: `https://${naming.domain}`,
  hosts,
  forms: Object.fromEntries(Object.entries(FORMS).map(([id, f]) => [id, { label: f.label, fields: f.fields.map((x) => ({ key: x.key, label: x.label })) }])),
  registries: {
    stakeholders: { registry: R.stakeholders.registry, version: R.stakeholders.version, items: R.stakeholders.stakeholders },
    metrics: { registry: R.metrics.registry, version: R.metrics.version, items: R.metrics.metrics },
    "report-types": { registry: R["report-types"].registry, version: R["report-types"].version, items: R["report-types"].report_types },
    findings: { registry: R.findings.registry, version: R.findings.version, items: findings },
    commitments: { registry: R.commitments.registry, version: R.commitments.version, items: R.commitments.commitments },
    legal: { registry: R.legal.registry, version: R.legal.version, items: legal, notes: legalNotes },
  },
  planned,
  naming: { registry: naming.registry, commit: source.commit, note: "The planned names are checked against the naming registry vendored from the core repository at this commit." },
  provisioning: optional("provisioning.json"),
  release: optional("release.json"),
  source: { repo: source.repo, commit: source.commit },
};

const text = JSON.stringify(snapshot, null, 2) + "\n";
const file = new URL(OUT, root);
if (process.argv.includes("--check")) {
  const now = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (now !== text) { console.error(`${OUT} is stale: run node scripts/admin-snapshot.mjs`); process.exit(1); }
  console.log(`ok: ${OUT} is fresh`);
} else {
  mkdirSync(dirname(file.pathname), { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote ${OUT}`);
}
