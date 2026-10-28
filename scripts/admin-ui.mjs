// The admin interface's scenario: the workbench (sources, panes, commands, layouts) derived from the admin API contract
// (contracts/admin.openapi.json) and the pane declarations (workers/admin/ui/panes.json). Every source is an operation of the
// contract, its row `contract` is that operation's response schema, and a command's arguments take their type, enum and limits from
// the operation's query parameters: nothing is typed twice. `kit widgets build --spec admin.widgets.spec.json` turns the
// scenario into the interface; `kit site build --config workers/admin/ui/site.config.js` into the pages the Worker serves.
//   node scripts/admin-ui.mjs            write workers/admin/ui/generated/scenarios.json
//   node scripts/admin-ui.mjs --check    exit 1 when it differs from what the sources give
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createValidator, formatProblems } from "../vendor/kit/packages/core/src/schema.js";

const root = new URL("../", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const OUT = "workers/admin/ui/generated/scenarios.json";
const contract = read("contracts/admin.openapi.json");
const panes = read("workers/admin/ui/panes.json");
const spec = read("admin.widgets.spec.json");
const asOf = spec.build.asOf;
const snapshot = read("workers/admin/generated/snapshot.json");

const paneSchema = read("workers/admin/ui/panes.schema.json");
const bad = formatProblems(createValidator([paneSchema]).validate(panes, paneSchema.$id));
if (bad.length) { console.error(`workers/admin/ui/panes.json: ${bad.join("; ")}`); process.exit(1); }

const fail = (m) => { console.error(`admin-ui: ${m}`); process.exit(1); };
const KIT_SCHEMAS = read("vendor/kit/packages/core/schemas/build.schema.json").$id.replace(/[^/]*$/, "");   // where the kit publishes its schemas
const external = new Map();
const docOf = (name) => { if (!external.has(name)) external.set(name, read(`vendor/kit/packages/core/schemas/${name}`)); return external.get(name); };
const pointer = (doc, frag) => frag.split("/").slice(1).reduce((n, k) => n?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
/** Inline every $ref: the contract's own (#/components/...), and the kit's schemas it names (read from the vendored copy). */
const deref = (node, doc = null) => {
  if (Array.isArray(node)) return node.map((x) => deref(x, doc));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (ref.startsWith(KIT_SCHEMAS)) { const [file, frag = ""] = ref.slice(KIT_SCHEMAS.length).split("#"); const d = docOf(file); const t = frag ? pointer(d, frag) : d; if (!t) fail(`unresolved ${ref}`); return deref(t, d); }
    if (ref.startsWith("#/components/")) { const [, , kind, name] = ref.split("/"); const t = contract.components[kind]?.[name]; if (!t) fail(`unresolved ${ref}`); return deref(t, null); }
    if (ref === "#" && doc) return { type: "object" };                       // the root of a kit schema refers to itself (a recursive answer): rows are checked one level deep
    if (ref.startsWith("#/") && doc) { const t = pointer(doc, ref); if (!t) fail(`unresolved ${ref}`); return deref(t, doc); }
    fail(`unresolved ${ref}`);
  }
  const entries = Object.entries(node).filter(([k]) => !["description", "$schema", "$id", "title", "$defs"].includes(k));
  // the names under `properties` are data, not annotations: a property called "title" stays
  return Object.fromEntries(entries.map(([k, v]) => [k, k === "properties" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([n, sub]) => [n, deref(sub, doc)])) : deref(v, doc)]));
};
const operation = (id) => { for (const [path, item] of Object.entries(contract.paths)) for (const [method, op] of Object.entries(item)) if (op.operationId === id) return { path, method, op }; return fail(`operation ${id} is not in the contract`); };

const step = (schema, seg) => {
  const s = schema.oneOf ? schema.oneOf.find((b) => b.properties) : schema;
  return s?.properties?.[seg] ?? fail(`pointer segment "${seg}" is not in the response schema`);
};
/** The row schema at a JSON pointer of the 200 answer: the items of an array, or { key, value } for a keyed object. */
function rowSchema(schema, pointer, keyed) {
  let s = schema;
  for (const seg of pointer.split("/").slice(1)) s = step(s, seg);
  if (keyed) {
    const value = s.additionalProperties && typeof s.additionalProperties === "object" ? s.additionalProperties : { type: ["string", "number", "boolean", "null"] };
    return { type: "object", required: ["key", "value"], properties: { key: { type: "string" }, value: s.properties ? { type: ["string", "number", "boolean", "null"] } : value } };
  }
  if (s.type !== "array" || !s.items) fail(`${pointer} is not an array in the response`);
  return s.items;
}
const hasKey = (schema, key) => key.split(".").reduce((s, k) => (s && s.type !== undefined || s?.properties ? (s.properties ? s.properties[k] : undefined) : undefined), schema) !== undefined;

const sources = [], paneDefs = [], commands = [];
const site = snapshot.site;
sources.push({ id: "admin.local", name: "Computed in the browser", kind: "sandbox-mock", origin: "computed", enabled: true, licence: { line: "Computed in your browser from the definition of this page.", redistribution: "not-applicable" }, freshness: { slaSeconds: 0, status: "mock" }, reach: { fromBrowser: "not-applicable", testedOn: asOf }, provenance: { adapter: "local", adapterVersion: "1" }, adapter: { type: "local" } });

for (const p of panes.panes) {
  const { path: tpl, method, op } = operation(p.operation);
  if (method !== "get") fail(`${p.id}: ${p.operation} is not a GET`);
  const url = p.path ?? tpl;
  if (/\{/.test(url)) fail(`${p.id}: ${p.operation} has a path parameter; name the concrete path in "path"`);
  const answer = deref(op.responses["200"].content["application/json"].schema);
  const rows = rowSchema(answer, p.rows, p.keyed === true);
  const check = rows.properties && Object.keys(rows.properties).length > 0;
  if (check) for (const c of p.columns) if (!hasKey(rows, c.key)) fail(`${p.id}: column "${c.key}" is not in the contract's row schema of ${p.operation} ${p.rows}`);
  const params = new Map((op.parameters || []).filter((x) => x.in === "query").map((x) => [x.name, x]));
  const args = p.command.args.map((a) => {
    const prm = params.get(a.param) ?? fail(`${p.id}: ${p.operation} has no query parameter "${a.param}"`);
    const sch = deref(prm.schema);
    const type = sch.enum ? "enum" : sch.type === "integer" ? "integer" : "string";
    return { name: a.param, type, ...(sch.enum ? { enum: sch.enum } : {}), ...(type === "integer" ? { ...(sch.minimum !== undefined ? { min: sch.minimum } : {}), ...(sch.maximum !== undefined ? { max: sch.maximum } : {}) } : {}), ...(a.hint ? { hint: a.hint } : {}) };
  });
  const sid = `admin.${p.id}`;
  sources.push({
    id: sid, name: p.title, kind: "public-feed", homepage: site, enabled: true,
    licence: { line: panes.licence, redistribution: "not-allowed" },
    freshness: { slaSeconds: 0, status: "live" }, reach: { fromBrowser: "ok", testedOn: asOf },
    provenance: { adapter: "http-json", adapterVersion: "1", upstreamUrl: `${url} (${p.operation})` },
    adapter: { type: "http-json", url, ...(args.length ? { query: Object.fromEntries(args.map((a) => [a.name, `$${a.name}`])) } : {}), rows: p.rows, ...(p.keyed ? { keyed: true } : {}) },
    contract: { type: "array", items: rows },
  });
  paneDefs.push({ id: p.id, kind: "table", title: p.title, summary: p.summary, source: sid, empty: p.empty, columns: p.columns });
  commands.push({ id: p.id, verb: p.command.verb, aliases: p.command.aliases, summary: p.command.summary, args, opens: p.id, source: sid, ...(p.command.example ? { example: p.command.example } : {}) });
}
paneDefs.push({ id: "sources", kind: "sources", title: "Sources", source: "admin.local" }, { id: "help", kind: "help", title: "Help", source: "admin.local" });
commands.push({ id: "src", verb: "SRC", aliases: ["sources"], summary: "Where each pane's data comes from", args: [], opens: "sources", source: "admin.local", example: "SRC" }, { id: "help", verb: "HELP", aliases: ["commands"], summary: "Commands and keys", args: [], opens: "help", source: "admin.local", example: "HELP" });
const ids = new Set(paneDefs.map((x) => x.id));
for (const l of panes.layouts) for (const g of l.groups) for (const id of g) if (!ids.has(id)) fail(`layout ${l.id}: unknown pane ${id}`);

const scenario = {
  id: "admin-workbench", useCase: "operate", audiences: ["owner"],
  title: panes.title, summary: "Leads, deliveries, mail, suppressions, registries and operations from one command line.",
  actors: [{ id: "owner", label: "The owner", kind: "person" }],
  steps: [{ id: "open", actor: "owner", action: "Types a command or opens a tab", status: "info" }, { id: "read", actor: "owner", action: "Reads a pane and the contract operation it came from", status: "info" }],
  widgets: [{
    archetype: "workbench", id: "admin-workbench", honesty: "live",
    usage: { surfaces: [{ path: "/examples/", placement: "page", how: "A launcher card with the panes and a link." }, { path: "/workbench/", placement: "app", how: "The admin page itself, served by the admin Worker behind Cloudflare Access." }] },
    application: { surface: "Admin workbench", href: "/workbench/" },
    architecture: { components: ["Admin API contract", "Pane declarations", "Workbench definition", "Admin Worker"], flow: "Contract and pane declarations, workbench definition, pane, admin API.", diagram: "docs/diagrams/admin-architecture.mmd" },
    utility: { learns: "What state the leads, mail and Workers are in.", does: "Run a command and read a pane." },
  }],
  workbench: {
    id: "admin", tz: "UTC", title: panes.title, intro: panes.intro, sources, panes: paneDefs, commands,
    layouts: panes.layouts.map((l) => ({ id: l.id, title: l.title, groups: l.groups.map((g) => g.map((pane) => ({ pane }))) })), defaultLayout: panes.defaultLayout,
    byo: { enabled: false, maxResponseBytes: 1048576, maxDatasetBytes: 1048576, maxRows: 5000, timeoutMs: 8000 }, watchlist: { max: 20 },
  },
};

const text = JSON.stringify({ $comment: "Generated by scripts/admin-ui.mjs from contracts/admin.openapi.json and workers/admin/ui/panes.json. Never edit by hand.", scenarios: [scenario] }, null, 2) + "\n";
const file = new URL(OUT, root);
if (process.argv.includes("--check")) {
  if ((existsSync(file) ? readFileSync(file, "utf8") : "") !== text) { console.error(`${OUT} is stale: run node scripts/admin-ui.mjs`); process.exit(1); }
  console.log(`ok: ${OUT} is fresh`);
} else { mkdirSync(dirname(file.pathname), { recursive: true }); writeFileSync(file, text); console.log(`wrote ${OUT}: ${sources.length - 1} sources, ${paneDefs.length} panes, ${commands.length} commands`); }
