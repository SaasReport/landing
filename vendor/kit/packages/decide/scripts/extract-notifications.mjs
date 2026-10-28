#!/usr/bin/env node
/**
 * node packages/decide/scripts/extract-notifications.mjs <session.jsonl> [--out packages/decide/eval/notification-triage.json]
 *
 * Builds the notification-triage eval set from a Claude Code session transcript. It keeps only each GitHub event's
 * kind and its JSON payload: the harness's own comment text, tool output and everything else are dropped. Owners,
 * repositories, actors, SHAs, run ids and URLs are pseudonymised consistently (owner-1/repo-2#7), so the set carries
 * the shape of real traffic and nothing about the repositories it came from. Identical events are merged with a count.
 * Synthetic cases already in the output file (source "synthetic") are kept. Labels follow the rules in LABELS.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const [, , input, ...rest] = process.argv;
const at = rest.indexOf("--out");
const out = at >= 0 ? rest[at + 1] : new URL("../eval/notification-triage.json", import.meta.url).pathname;
if (!input) { console.error("usage: extract-notifications.mjs <session.jsonl> [--out file]"); process.exit(2); }

/** kind (+ payload) → true labels. The gate's options and these rules are the one definition of the classes. */
export function LABELS(kind, data) {
  const L = (k, act, owner) => ({ kind: k, needs_action: act, owner_attention: owner });
  if (kind === "check_run.completed") return data.conclusion === "failure" ? L("ci_failed", "yes", "no") : L("ci_passed", "no", "no");
  if (kind === "check_suite.completed") return L("ci_passed", "no", "no");
  if (kind === "pull_request.closed") return data.outcome === "merged" ? L("merged", "no", "yes") : L("subscription_noise", "no", "yes");
  if (kind === "subscription.created" || kind === "pull_request.ready_for_review") return L("subscription_noise", "no", "no");
  return null;
}

const maps = new Map();
const pseudo = (ns, v, fmt) => {
  if (!maps.has(ns)) maps.set(ns, new Map());
  const m = maps.get(ns);
  if (!m.has(v)) m.set(v, fmt(m.size + 1, v));
  return m.get(v);
};
const sha = (v) => pseudo("sha", v, (_, x) => createHash("sha256").update(`kit-decide:${x}`).digest("hex").slice(0, 40));
const repo = (full) => `${pseudo("owner", full.split("/")[0], (n) => `owner-${n}`)}/${pseudo("repo", full, (n) => `repo-${n}`)}`;
const pr = (s) => s.replace(/^([\w.-]+\/[\w.-]+)#(\d+)$/, (_, f, n) => `${repo(f)}#${n}`);

function scrub(data) {
  const o = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "pr" && typeof v === "string") o.pr = pr(v);
    else if (k === "head_sha") o.head_sha = sha(v);
    else if (k === "actor" || k === "attributed_actor") o[k] = pseudo("actor", v, (n) => `actor-${n}`);
    else if (k === "check_run_id") o[k] = pseudo("run", v, (n) => 1000 + n);
    else if (k === "details_url" && typeof v === "string") {
      const m = v.match(/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)\/job\/(\d+)/);
      o[k] = m ? `https://github.com/${repo(m[1])}/actions/runs/${pseudo("run", m[2], (n) => 1000 + n)}/job/${pseudo("run", m[3], (n) => 1000 + n)}` : "https://github.com/owner/repo/actions";
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") o[k] = v;
  }
  return o;
}

function* texts(c) {
  if (typeof c === "string") { yield c; return; }
  for (const x of Array.isArray(c) ? c : []) {
    if (x?.type === "text") yield x.text || "";
    if (x?.type === "tool_result") yield* texts(x.content);
  }
}

const EVENT = /<event source="github"([^>]*)>([\s\S]*?)<\/event>/g;
const seen = new Map();
const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const line of rl) {
  let o;
  try { o = JSON.parse(line); } catch { continue; /* a log line that is not JSON is not a notification */ }
  if (o?.type !== "user") continue;
  for (const t of texts(o.message?.content)) {
    for (const m of t.matchAll(EVENT)) {
      const kind = /kind="([^"]+)"/.exec(m[1])?.[1];
      let data;
      try { data = JSON.parse(m[2].replace(/<!--[\s\S]*?-->/g, "").trim()); } catch { continue; /* a notification body that is not JSON is skipped as not ours */ }
      if (!kind || !data || typeof data !== "object") continue;
      const key = `${kind} ${JSON.stringify(data)}`;
      const prev = seen.get(key);
      if (prev) { prev.count++; continue; }
      const labels = LABELS(kind, data);
      if (labels) seen.set(key, { kind, raw: data, labels, count: 1 });
    }
  }
}

const cases = [...seen.values()].map((e, i) => ({ id: `t${String(i + 1).padStart(3, "0")}`, source: "transcript", count: e.count, state: { event: e.kind, data: scrub(e.raw) }, labels: e.labels }));
const prior = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
const synthetic = (prior?.cases || []).filter((c) => c.source === "synthetic");
const doc = {
  $schema: "https://github.com/SaasReport/kit/blob/main/packages/decide/schemas/decide-eval.schema.json",
  gate: "notification-triage",
  provenance: "Every distinct GitHub event delivered to one long agent session (kind and JSON payload only; identifiers pseudonymised; harness text dropped), plus synthetic cases for classes that session never received (merge conflicts, review comments). Built by scripts/extract-notifications.mjs.",
  cases: [...cases, ...synthetic],
};
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
const by = {};
for (const c of doc.cases) by[`${c.source}:${c.labels.kind}`] = (by[`${c.source}:${c.labels.kind}`] || 0) + (c.count || 1);
console.log(`wrote ${out}: ${cases.length} distinct transcript events (${cases.reduce((s, c) => s + c.count, 0)} deliveries), ${synthetic.length} synthetic`);
console.log(by);
