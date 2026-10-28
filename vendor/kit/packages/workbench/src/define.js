/**
 * The workbench definition: validation against the three schemas (kit.workbench.v1, kit.workbench-commands.v1,
 * kit.source-envelope.v1) and the cross-checks no schema can state: every reference resolves, no two commands share a
 * word once folded, every pane's source matches what the pane needs, every source says honestly what it is (a seeded
 * series is synthetic, a lab engine is sandbox-api, a public feed is a public-feed) and a disabled source carries its
 * contract and a fixture that satisfies it.
 */
import { createValidator } from "../../core/src/schema.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRuntime } from "./runtime.js";

const load = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`../schemas/${n}.schema.json`, import.meta.url)), "utf8"));
export const ENVELOPE_SCHEMA = load("source-envelope");
export const COMMANDS_SCHEMA = load("command-registry");
export const WORKBENCH_SCHEMA = load("workbench");
export const SCHEMAS = [ENVELOPE_SCHEMA, COMMANDS_SCHEMA, WORKBENCH_SCHEMA];
export const validator = () => createValidator(SCHEMAS);

const NEEDS = {
  series: (a) => a.type === "seeded-series" || "a seeded-series source",
  calendar: (a) => a.type === "http-json" || "an http-json source",
  sandbox: (a) => a.type === "lab-engine" || "a lab-engine source",
  calculator: (a) => a.type === "local" || "a local source",
  sources: (a) => a.type === "local" || "a local source",
  help: (a) => a.type === "local" || "a local source",
  watchlist: (a) => a.type === "local" || "a local source",
  table: (a) => ["http-json", "local"].includes(a.type) || "an http-json source (or byo)",
};

/** Problems with a resolved workbench definition ([] when it is sound). */
export function workbenchProblems(def) {
  const v = validator(), p = [];
  for (const q of v.validate(def, "urn:kit:schema:workbench:v1")) p.push(`workbench${q.path}: ${q.message}`);
  if (p.length) return p;
  const WB = loadRuntime(), fold = WB.fold;
  const dup = (xs, what) => { const seen = new Set(); for (const x of xs) { if (seen.has(x)) p.push(`${what} "${x}" is used twice`); seen.add(x); } };
  dup(def.sources.map((s) => s.id), "source id"); dup(def.panes.map((x) => x.id), "pane id"); dup(def.layouts.map((x) => x.id), "layout id"); dup(def.commands.map((c) => c.id), "command id");
  const src = new Map(def.sources.map((s) => [s.id, s])), pane = new Map(def.panes.map((x) => [x.id, x]));
  // grammar: no two commands answer to the same folded word
  const words = new Map();
  for (const c of def.commands) for (const w of [c.verb, ...c.aliases]) { const k = fold(w); if (words.has(k) && words.get(k) !== c.id) p.push(`commands.${c.id}: "${w}" is also a word of ${words.get(k)} (folded: ${k})`); words.set(k, c.id); }
  for (const c of def.commands) {
    const pn = pane.get(c.opens);
    if (!pn) { p.push(`commands.${c.id}: opens unknown pane "${c.opens}"`); continue; }
    if (c.source !== pn.source && !(pn.alternates || []).includes(c.source)) p.push(`commands.${c.id}: source "${c.source}" is not a source of pane ${pn.id}`);
    if (!src.has(c.source) && c.source !== "byo") p.push(`commands.${c.id}: unknown source "${c.source}"`);
    const names = c.args.map((a) => a.name); dup(names, `commands.${c.id} argument`);
    for (const a of c.args) { if (a.type === "enum" && !a.enum) p.push(`commands.${c.id}.${a.name}: an enum argument needs enum`); if (a.default !== undefined && a.enum && !a.enum.includes(a.default)) p.push(`commands.${c.id}.${a.name}: default is not in enum`); }
    if (c.example) { const r = WB.parseLine(def.commands, c.example); if (r.command?.id !== c.id || r.errors.length) p.push(`commands.${c.id}: example "${c.example}" does not run this command (${r.errors.map((e) => e.message).join("; ") || "another command"})`); }
  }
  for (const s of def.sources) {
    const a = s.adapter, at = `sources.${s.id}`;
    if (a.type === "seeded-series" && !(s.kind === "sandbox-mock" && (s.origin || "generated") === "generated")) p.push(`${at}: a seeded series is sandbox-mock with origin generated (badge SYNTHETIC)`);
    if (a.type === "lab-engine" && !(s.kind === "sandbox-mock" && s.origin === "sandbox-api")) p.push(`${at}: a lab engine is sandbox-mock with origin sandbox-api (badge SANDBOX)`);
    if (a.type === "local" && !(s.kind === "sandbox-mock" && s.origin === "computed")) p.push(`${at}: a local source is sandbox-mock with origin computed (badge COMPUTED)`);
    if (a.type === "http-json" && s.kind !== "public-feed") p.push(`${at}: an http-json source is a public-feed`);
    if (s.kind === "sandbox-mock" && s.freshness.status !== "mock") p.push(`${at}: a sandbox-mock source has freshness.status mock`);
    if (s.kind === "public-feed" && !s.homepage) p.push(`${at}: a public-feed names its homepage`);
    if (a.type === "http-json" && !s.enabled && !a.url.startsWith("https://")) p.push(`${at}: a disabled feed names the upstream https URL it would call`);
    if (!s.enabled) {
      if (!s.contract) p.push(`${at}: a disabled source ships its contract (JSON Schema of its rows)`);
      if (s.fixture === undefined) p.push(`${at}: a disabled source ships a fixture (the mock that satisfies the contract)`);
      else if (s.contract) { const bad = WB.checkRows(v, Array.isArray(s.fixture) ? s.fixture : [s.fixture], s.contract, 3); if (bad.length) p.push(`${at}: the fixture does not satisfy the contract: ${bad.join(" | ")}`); }
    }
    if (a.type === "http-json" && a.url.startsWith("https://") && s.enabled && s.licence.redistribution === "unverified" && !s.compliance?.ownerDecisionRef) p.push(`${at}: an enabled external feed with an unverified licence needs compliance.ownerDecisionRef`);
  }
  for (const x of def.panes) {
    const at = `panes.${x.id}`, ids = [x.source, ...(x.alternates || [])];
    for (const id of ids) if (id !== "byo" && !src.has(id)) p.push(`${at}: unknown source "${id}"`);
    const main = src.get(x.source);
    if (x.source !== "byo" && main && !main.enabled) p.push(`${at}: the default source ${x.source} is disabled; a pane opens on an enabled source`);
    if (x.source === "byo" && x.kind !== "table") p.push(`${at}: only a table pane can show the visitor's own data (source byo)`);
    for (const id of ids) { const s = src.get(id); const need = NEEDS[x.kind]?.(s?.adapter || {}); if (s && need !== true) p.push(`${at} (${x.kind}): source ${id} must be ${need}`); }
    if (x.kind === "calculator" && !x.calcs?.length) p.push(`${at}: a calculator pane needs calcs`);
    if (x.kind === "sandbox" && !x.ops?.length) p.push(`${at}: a sandbox pane needs ops`);
    if (x.kind === "calendar" && !x.params?.fields?.date) p.push(`${at}: a calendar pane needs params.fields.date and params.fields.jalali`);
    if (x.kind === "calendar" && main?.adapter.type === "http-json" && !main.adapter.rows) p.push(`${at}: the calendar's source needs adapter.rows (the pointer of the days)`);
  }
  for (const l of def.layouts) for (const g of l.groups) for (const t of g) if (!pane.has(t.pane)) p.push(`layouts.${l.id}: unknown pane "${t.pane}"`);
  if (!def.layouts.some((l) => l.id === def.defaultLayout)) p.push(`defaultLayout "${def.defaultLayout}" is not a layout`);
  return p;
}
