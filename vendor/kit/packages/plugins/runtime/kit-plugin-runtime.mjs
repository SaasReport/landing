// kit-plugin-runtime.mjs: the run folder, the compile report and the MCP/API client every agent-plugin skill uses.
// Canonical copy: SaasReport/kit packages/plugins/runtime/kit-plugin-runtime.mjs. `kit plugin new` copies it
// into <plugin>/scripts/lib/; do not edit the copy (the plugin tests compare it byte for byte). Node >= 20, no deps.
//
//   const run = createRun({ prefix: "saasreport", skill: "saasreport-settlement", inputs, engine: { name, version, via }, critic: true });
//   run.item({ id, label, value, status, sources, note, risk });  // status: confirmed | not_confirmed | flagged; risk 1-10 (flagged only)
//   await run.criticPass(async (item) => ({ verdict, note }));    // optional second pass: try to falsify every confirmed item
//   run.learn({ kind: "pattern", text, item_id });               // appended to ./<prefix>-out/learnings.jsonl at finish
//   run.file("settlement.json", data);                          // written into the run folder
//   const report = run.finish();                                // writes compile-report.json, returns it
//
// Output folder: ./<prefix>-out/<skill>/<run-id>/ under the working directory (or --out <dir>).
// Critic: a verdict can only lower a status, never raise it. refuted → flagged; inconclusive → not_confirmed at best;
// upheld → unchanged. With the critic on, a confirmed item the critic never checked ends as not_confirmed.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const REPORT_SCHEMA = "kit.compile-report.v1";
export const LEARNING_SCHEMA = "kit.plugin-learning.v1";
export const STATUSES = ["confirmed", "not_confirmed", "flagged"];
export const VERDICTS = ["upheld", "refuted", "inconclusive"];
export const LEARNING_KINDS = ["false_positive", "pattern", "trajectory", "gap", "correction"];
/** Risk of a flagged item, 1-10: what happens if someone acts on it unchecked. */
export const RISK_RUBRIC = { 1: "cosmetic", 3: "low: unlikely to change an answer", 5: "medium: may change an answer; check before use", 7: "high: likely wrong; do not use before review", 9: "critical: acting on it could cost money or break a legal duty" };
const RANK = { confirmed: 0, not_confirmed: 1, flagged: 2 };

/** --flag value / --flag=value / --bool → { _: [], flags: {} }. */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) { out.flags[a.slice(2)] = next; i++; } else out.flags[a.slice(2)] = true;
  }
  return out;
}

const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Run id: UTC timestamp + the first 8 hex of the inputs' hash, e.g. 20261001T120000Z-1a2b3c4d. */
export function runId(inputs = {}, now = new Date()) {
  const t = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${t}-${sha256(stable(inputs)).slice(0, 8)}`;
}

/** The worst status of a list (flagged > not_confirmed > confirmed); confirmed for an empty list. */
export const worst = (statuses) => statuses.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), "confirmed");

/**
 * Status of an engine answer: not_confirmed when a predicted holiday decides it (uncertain) or the market's holiday
 * pack is unverified; flagged when the pack is partial (known gaps may change the answer); else confirmed.
 */
export function engineStatus({ uncertain = false, packStatus = "verified" } = {}) {
  if (packStatus === "partial") return "flagged";
  if (uncertain || packStatus !== "verified") return "not_confirmed";
  return "confirmed";
}

const validRisk = (r) => Number.isInteger(r) && r >= 1 && r <= 10;

export function createRun({ prefix, skill, inputs = {}, engine = {}, cwd = process.cwd(), out, now = new Date(), id, critic = false, learningsFile } = {}) {
  if (!prefix || !skill || !skill.startsWith(`${prefix}-`)) throw new Error(`skill "${skill}" must start with the plugin prefix "${prefix}-"`);
  const run = id || runId(inputs, now);
  const dir = resolve(cwd, out || join(`${prefix}-out`, skill, run));
  mkdirSync(dir, { recursive: true });
  const items = [], outputs = [], learnings = [];
  const criticBy = critic ? (typeof critic === "object" && critic.by) || `${skill} critic` : null;
  const byId = (itemId) => { const x = items.find((i) => i.id === String(itemId)); if (!x) throw new Error(`no item "${itemId}"`); return x; };
  return {
    id: run, dir,
    item(x) {
      if (!STATUSES.includes(x.status)) throw new Error(`item ${x.id}: status must be one of ${STATUSES.join(", ")}`);
      if (x.status === "confirmed" && !(x.sources || []).length) throw new Error(`item ${x.id}: confirmed needs at least one source`);
      if (x.status !== "confirmed" && !x.note) throw new Error(`item ${x.id}: ${x.status} needs a note saying why`);
      if (x.risk != null && (x.status !== "flagged" || !validRisk(x.risk))) throw new Error(`item ${x.id}: risk is an integer 1-10, on flagged items only`);
      items.push({ id: String(x.id), label: x.label || String(x.id), value: x.value ?? null, status: x.status, sources: x.sources || [], ...(x.note ? { note: x.note } : {}), ...(x.risk != null ? { risk: x.risk } : {}) });
      return x.status;
    },
    /** The critic's verdict on one item: it can only lower the status (refuted → flagged, inconclusive → not_confirmed). */
    critique(itemId, { verdict, note, sources = [], risk } = {}) {
      if (!criticBy) throw new Error("the critic stage is off: createRun({ critic: true })");
      if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
      if (verdict !== "upheld" && !note) throw new Error(`item ${itemId}: a ${verdict} verdict needs a note saying what the critic found`);
      const x = byId(itemId);
      const before = x.status;
      const after = verdict === "refuted" ? "flagged" : verdict === "inconclusive" && before === "confirmed" ? "not_confirmed" : before;
      x.critic = { verdict, by: criticBy, ...(note ? { note } : {}), ...(sources.length ? { sources } : {}), ...(after !== before ? { previous_status: before } : {}) };
      if (after !== before) {
        x.status = after;
        x.note = [x.note, `Critic (${verdict}): ${note}`].filter(Boolean).join(" ");
      }
      if (after === "flagged" && risk != null) { if (!validRisk(risk)) throw new Error(`item ${itemId}: risk is an integer 1-10`); x.risk = risk; }
      return x.status;
    },
    /** Run falsify(item) → { verdict, note, sources, risk } on every confirmed item (the second pass). */
    async criticPass(falsify) {
      for (const x of items.filter((i) => i.status === "confirmed" && !i.critic)) this.critique(x.id, await falsify({ ...x }));
    },
    /** One structured learning for ./<prefix>-out/learnings.jsonl (kit.plugin-learning.v1), written at finish. */
    learn({ kind, text, item_id, tags, evidence } = {}) {
      if (!LEARNING_KINDS.includes(kind)) throw new Error(`learning kind must be one of ${LEARNING_KINDS.join(", ")}`);
      if (!text || typeof text !== "string") throw new Error("a learning needs text");
      learnings.push({ schema: LEARNING_SCHEMA, at: now.toISOString(), plugin: prefix, skill, run_id: run, kind, text, ...(item_id != null ? { item_id: String(item_id) } : {}), ...(tags?.length ? { tags } : {}), ...(evidence?.length ? { evidence } : {}) });
    },
    file(name, data) {
      const text = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
      writeFileSync(join(dir, name), text);
      outputs.push({ path: name, bytes: Buffer.byteLength(text), sha256: sha256(text) });
      return join(dir, name);
    },
    finish(extra = {}) {
      let criticBlock;
      if (criticBy) {
        // honest: a confirmed item the critic never checked is not confirmed
        for (const x of items.filter((i) => i.status === "confirmed" && !i.critic)) {
          x.status = "not_confirmed";
          x.note = [x.note, "Critic stage on, but this item was not checked."].filter(Boolean).join(" ");
          x.critic = { verdict: "unchecked", by: criticBy, previous_status: "confirmed" };
        }
        const n = (v) => items.filter((i) => i.critic?.verdict === v).length;
        criticBlock = { enabled: true, by: criticBy, checked: n("upheld") + n("refuted") + n("inconclusive"), upheld: n("upheld"), refuted: n("refuted"), inconclusive: n("inconclusive"), unchecked: n("unchecked") };
      }
      const summary = Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
      const risks = items.filter((i) => i.risk != null).map((i) => i.risk);
      if (risks.length) summary.max_risk = Math.max(...risks);
      let learningsBlock;
      if (learnings.length) {
        const file = resolve(cwd, learningsFile || join(`${prefix}-out`, "learnings.jsonl"));
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, learnings.map((l) => `${JSON.stringify(l)}\n`).join(""));
        learningsBlock = { file: relative(cwd, file) || file, added: learnings.length };
      }
      const report = { schema: REPORT_SCHEMA, plugin: prefix, skill, run_id: run, generated_at: now.toISOString(), inputs, engine,
        outputs, items, summary, status: worst(items.map((i) => i.status)), ...(criticBlock ? { critic: criticBlock } : {}), ...(learningsBlock ? { learnings: learningsBlock } : {}), ...extra };
      writeFileSync(join(dir, "compile-report.json"), `${JSON.stringify(report, null, 2)}\n`);
      return Object.defineProperty(report, "dir", { value: dir, enumerable: false });
    },
  };
}

/** One MCP tools/call over stateless Streamable HTTP (JSON-RPC 2.0) → the tool's structured result. */
export async function mcpCall(url, name, args = {}, { fetch = globalThis.fetch, headers = {} } = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await res.json();
  if (body.error) throw new Error(`MCP ${name}: ${body.error.message}`);
  const r = body.result || {};
  if (r.isError) throw new Error(`MCP ${name}: ${r.content?.[0]?.text || "tool error"}`);
  if (r.structuredContent) return r.structuredContent.items ?? r.structuredContent;
  return JSON.parse(r.content?.[0]?.text ?? "null");
}

/** GET a JSON API ({ ok, data } envelopes are unwrapped). */
export async function apiGet(url, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json();
  if (body && body.ok === false) throw new Error(`${url}: ${body.error?.code || res.status} ${body.error?.message || ""}`.trim());
  return body && "data" in body && "ok" in body ? body.data : body;
}

/** CLI helper: run main(), print the report path and status, exit 0 (1 on error). */
export async function cli(main) {
  try {
    const report = await main(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ run_dir: report.dir, status: report.status, summary: report.summary })}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}
