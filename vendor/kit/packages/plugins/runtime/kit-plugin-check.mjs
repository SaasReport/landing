// kit-plugin-check.mjs: the agent-plugin validator, standalone (Node >= 20, no deps), so a plugin checks itself anywhere.
// Canonical copy: SaasReport/kit packages/plugins/runtime/kit-plugin-check.mjs. `kit plugin new` copies it into
// <plugin>/scripts/lib/; do not edit the copy (tests compare it byte for byte with the kit's).
//   node scripts/lib/kit-plugin-check.mjs <plugin dir> [--prefix p] [--server name=url]
//   node scripts/lib/kit-plugin-check.mjs <compile-report.json | learnings.jsonl>
//   validatePlugin(dir, { prefix, servers, runtimeSource?, checkSource? }) → problems[];  validateReport(report) → problems[]
//   validateLearnings(jsonlText) → problems[]
// A plugin is a Claude Code plugin (.claude-plugin/plugin.json, skills/<name>/SKILL.md, optional commands/ and
// .mcp.json) whose skills are also plain Agent Skills files, so other agent runtimes can read them as they are.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_FILE = "kit-plugin-runtime.mjs";
export const CHECK_FILE = "kit-plugin-check.mjs";

// ---------- frontmatter: key: value lines, quoted strings, one level of map or list ----------
const unquote = (v) => {
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "true" || s === "false") return s === "true";
  return s;
};

export function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return { ok: false, data: {}, body: src, error: "the file must start with a --- line" };
  const end = src.indexOf("\n---", 4);
  if (end < 0) return { ok: false, data: {}, body: src, error: "no closing --- line" };
  const lines = src.slice(4, end).split("\n"), body = src.slice(src.indexOf("\n", end + 1) + 1);
  const data = {};
  let parent = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indented = /^\s+/.test(raw);
    if (indented && parent) {
      const t = raw.trim();
      if (t.startsWith("- ")) { if (!Array.isArray(data[parent])) data[parent] = []; data[parent].push(unquote(t.slice(2))); continue; }
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(t);
      if (!m) return { ok: false, data, body, error: `cannot read line "${raw}"` };
      if (Array.isArray(data[parent])) return { ok: false, data, body, error: `"${parent}" mixes a list and a map` };
      if (typeof data[parent] !== "object" || data[parent] === null) data[parent] = {};
      data[parent][m[1]] = unquote(m[2]);
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!m) return { ok: false, data, body, error: `cannot read line "${raw}"` };
    if (m[2].trim() === "") { data[m[1]] = null; parent = m[1]; } else { data[m[1]] = unquote(m[2]); parent = null; }
  }
  return { ok: true, data, body };
}

// ---------- plugins and reports ----------
// generated:plugin-prefixes (packages/core/registry/projects.json; node packages/core/scripts/naming-families.mjs)
/** Each project's code (its short prefix without the dash, or its key when it has none), in registry order. */
export const PREFIXES = ["saasreport"];
/** Each code's full project prefix, without the dash: either may name a resource such as an MCP server. */
export const FULL_PREFIXES = { saasreport: "saasreport" };
// /generated:plugin-prefixes
export const REPORT_SCHEMA = "kit.compile-report.v1";
export const LEARNING_SCHEMA = "kit.plugin-learning.v1";
export const STATUSES = ["confirmed", "not_confirmed", "flagged"];
export const VERDICTS = ["upheld", "refuted", "inconclusive", "unchecked"];
export const LEARNING_KINDS = ["false_positive", "pattern", "trajectory", "gap", "correction"];
const STATUS_RANK = { confirmed: 0, not_confirmed: 1, flagged: 2 };
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SECRETISH = /^(?:Bearer\s+)?\$\{[A-Z][A-Z0-9_]*\}$/;

const readJson = (file, p, label) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { p.push(`${label}: not valid JSON (${e.message})`); return null; }
};
const isDir = (f) => existsSync(f) && statSync(f).isDirectory();

export function validatePlugin(dir, { prefix, servers, prefixes = PREFIXES, runtimeSource, checkSource } = {}) {
  const p = [];
  const mf = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(mf)) return [`.claude-plugin/plugin.json: missing`];
  const m = readJson(mf, p, "plugin.json");
  if (!m) return p;
  const pre = prefix || m.name;

  // manifest
  if (typeof m.name !== "string" || !KEBAB.test(m.name)) p.push(`plugin.json name: "${m.name}" must be kebab-case`);
  if (!prefixes.includes(pre)) p.push(`plugin.json name: prefix "${pre}" is not in the naming constitution (${prefixes.join(", ")})`);
  if (prefix && m.name !== prefix) p.push(`plugin.json name: "${m.name}" must be the project prefix "${prefix}"`);
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) p.push(`plugin.json version: missing or not x.y.z`);
  if (typeof m.description !== "string" || m.description.length < 20) p.push(`plugin.json description: missing or too short`);
  if (!m.author || typeof m.author.name !== "string" || !m.author.name) p.push(`plugin.json author.name: missing`);
  if (typeof m.license !== "string" || !m.license) p.push(`plugin.json license: missing (SPDX id)`);
  for (const k of ["skills", "commands", "agents", "mcpServers"]) if (typeof m[k] === "string" && !m[k].startsWith("./")) p.push(`plugin.json ${k}: paths must start with ./`);
  const kit = m.metadata?.kit;
  if (!kit) p.push(`plugin.json metadata.kit: missing ({ prefix, outputDir, backend })`);
  else {
    if (kit.prefix !== pre) p.push(`plugin.json metadata.kit.prefix: must be "${pre}"`);
    if (kit.outputDir !== `${pre}-out`) p.push(`plugin.json metadata.kit.outputDir: must be "${pre}-out"`);
    if (!kit.backend || !["mcp", "api", "engine"].includes(kit.backend.kind)) p.push(`plugin.json metadata.kit.backend.kind: one of mcp, api, engine`);
    else if (kit.backend.kind !== "mcp" && !kit.backend.note) p.push(`plugin.json metadata.kit.backend.note: say why there is no MCP server`);
  }
  if (existsSync(join(dir, "CLAUDE.md"))) p.push(`CLAUDE.md at the plugin root is not loaded by Claude Code; put instructions in a skill`);

  // MCP servers
  const mcpFile = join(dir, ".mcp.json");
  if (existsSync(mcpFile)) {
    const mcp = readJson(mcpFile, p, ".mcp.json");
    const map = mcp?.mcpServers;
    if (mcp && (!map || typeof map !== "object" || !Object.keys(map).length)) p.push(`.mcp.json: needs a non-empty "mcpServers" map`);
    for (const [name, s] of Object.entries(map || {})) {
      const full = FULL_PREFIXES[pre];
      if (name !== pre && !name.startsWith(`${pre}-`) && !(full && name.startsWith(`${full}-`))) p.push(`.mcp.json ${name}: server names carry the prefix ("${pre}", "${pre}-…"${full && full !== pre ? ` or "${full}-…"` : ""})`);
      const type = s.type || (s.command ? "stdio" : "http");
      if (type === "stdio") { if (!s.command) p.push(`.mcp.json ${name}: stdio needs "command"`); }
      else {
        let u = null; try { u = new URL(s.url); } catch { /* not a URL: u stays null and the check below reports it */ }
        if (!u) p.push(`.mcp.json ${name}: "url" must be an absolute URL`);
        else if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) p.push(`.mcp.json ${name}: use https`);
      }
      for (const [h, v] of Object.entries(s.headers || {})) if (/authorization|token|key|secret/i.test(h) && !SECRETISH.test(String(v))) p.push(`.mcp.json ${name}: header ${h} must reference an environment variable (\${NAME}), never a literal credential`);
      if (servers) {
        const known = servers[name];
        if (!known) p.push(`.mcp.json ${name}: not a server the project runs (known: ${Object.keys(servers).join(", ") || "none"})`);
        else if (known !== s.url) p.push(`.mcp.json ${name}: url ${s.url} is not the project's server ${known}`);
      }
    }
    if (kit && kit.backend?.kind !== "mcp") p.push(`plugin.json metadata.kit.backend.kind: "mcp" when .mcp.json is present`);
  } else if (kit?.backend?.kind === "mcp") p.push(`.mcp.json: missing, but metadata.kit.backend.kind is "mcp"`);

  // skills
  const sd = join(dir, "skills");
  const skills = isDir(sd) ? readdirSync(sd).filter((d) => isDir(join(sd, d))).sort() : [];
  if (!skills.length) p.push(`skills/: no skills`);
  for (const s of skills) {
    const f = join(sd, s, "SKILL.md"), at = `skills/${s}/SKILL.md`;
    if (!existsSync(f)) { p.push(`${at}: missing`); continue; }
    const fm = parseFrontmatter(readFileSync(f, "utf8"));
    if (!fm.ok) { p.push(`${at}: frontmatter: ${fm.error}`); continue; }
    const { name, description } = fm.data;
    if (name !== s) p.push(`${at}: name "${name}" must equal the folder name "${s}"`);
    if (!KEBAB.test(String(name)) || String(name).length > 64) p.push(`${at}: name must be lowercase letters, digits and hyphens, at most 64 characters`);
    if (!String(name).startsWith(`${pre}-`)) p.push(`${at}: name "${name}" must start with "${pre}-"`);
    if (typeof description !== "string" || description.length < 20) p.push(`${at}: description missing or too short`);
    else if (description.length > 1024) p.push(`${at}: description longer than 1024 characters`);
    const rawDesc = /^description:[ \t]*(.*)$/m.exec(readFileSync(f, "utf8"))?.[1] || "";
    if (!/^["']/.test(rawDesc) && /: | #/.test(rawDesc)) p.push(`${at}: quote the description (": " or " #" breaks YAML)`);
    const body = fm.body;
    if (!/^##\s+Inputs\b/m.test(body)) p.push(`${at}: needs an "## Inputs" section`);
    if (!body.includes(`${pre}-out/${s}/`)) p.push(`${at}: must say it writes to ./${pre}-out/${s}/<run-id>/`);
    if (!body.includes("compile-report.json")) p.push(`${at}: must say it writes compile-report.json`);
    if (!/not_confirmed/.test(body) || !/flagged/.test(body)) p.push(`${at}: must state when results are not_confirmed or flagged`);
    for (const ref of new Set([...body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)].map((x) => x[1]))) if (!existsSync(join(dir, ref))) p.push(`${at}: references ${ref}, which does not exist`);
  }

  // commands
  const cd = join(dir, "commands");
  if (isDir(cd)) for (const f of readdirSync(cd).filter((x) => x.endsWith(".md")).sort()) {
    const name = f.slice(0, -3);
    if (!name.startsWith(`${pre}-`)) p.push(`commands/${f}: command names start with "${pre}-"`);
    const fm = parseFrontmatter(readFileSync(join(cd, f), "utf8"));
    if (!fm.ok || !fm.data.description) p.push(`commands/${f}: needs frontmatter with a description`);
  }

  // the shared runtime and this checker, byte for byte with the kit's copies when those are given
  for (const [file, canon] of [[RUNTIME_FILE, runtimeSource], [CHECK_FILE, checkSource]]) {
    const rf = join(dir, "scripts", "lib", file);
    if (!existsSync(rf)) p.push(`scripts/lib/${file}: missing (kit plugin new copies it)`);
    else if (canon != null && readFileSync(rf, "utf8") !== canon) p.push(`scripts/lib/${file}: differs from the kit's copy; copy it again from @saasreport/plugins`);
    else if (file === RUNTIME_FILE && !readFileSync(rf, "utf8").includes(`"${REPORT_SCHEMA}"`)) p.push(`scripts/lib/${file}: does not write ${REPORT_SCHEMA}`);
  }
  return p;
}

/** Problems with a compile-report.json object (the checks of schema/compile-report.schema.json, without a validator dependency). */
export function validateReport(r) {
  const p = [];
  if (!r || typeof r !== "object") return ["report: not an object"];
  if (r.schema !== REPORT_SCHEMA) p.push(`schema: must be "${REPORT_SCHEMA}"`);
  for (const k of ["plugin", "skill", "run_id", "generated_at"]) if (typeof r[k] !== "string" || !r[k]) p.push(`${k}: missing`);
  if (r.plugin && r.skill && !r.skill.startsWith(`${r.plugin}-`)) p.push(`skill: must start with "${r.plugin}-"`);
  if (r.run_id && !/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(r.run_id)) p.push(`run_id: must look like 20261001T120000Z-1a2b3c4d`);
  if (r.generated_at && Number.isNaN(Date.parse(r.generated_at))) p.push(`generated_at: not a date-time`);
  if (!r.inputs || typeof r.inputs !== "object") p.push(`inputs: missing`);
  if (!r.engine || typeof r.engine.name !== "string" || !["engine", "mcp", "api", "content"].includes(r.engine.via)) p.push(`engine: needs name and via (engine, mcp, api, content)`);
  if (!Array.isArray(r.outputs)) p.push(`outputs: missing`);
  else r.outputs.forEach((o, i) => { if (typeof o.path !== "string" || !Number.isInteger(o.bytes) || !/^[0-9a-f]{64}$/.test(o.sha256 || "")) p.push(`outputs[${i}]: needs path, bytes, sha256`); });
  if (!Array.isArray(r.items)) return [...p, `items: missing`];
  r.items.forEach((x, i) => {
    const at = `items[${i}]${x?.id ? ` (${x.id})` : ""}`;
    if (typeof x?.id !== "string" || typeof x.label !== "string" || !("value" in x)) p.push(`${at}: needs id, label, value`);
    if (!STATUSES.includes(x?.status)) p.push(`${at}: status must be one of ${STATUSES.join(", ")}`);
    if (!Array.isArray(x?.sources)) p.push(`${at}: sources must be an array`);
    else {
      x.sources.forEach((s, j) => { if (typeof s?.title !== "string" || !s.title) p.push(`${at}.sources[${j}]: needs a title`); });
      if (x.status === "confirmed" && !x.sources.length) p.push(`${at}: confirmed needs at least one source`);
    }
    if (x?.status && x.status !== "confirmed" && !x.note) p.push(`${at}: ${x.status} needs a note`);
    // risk: 1-10, flagged items only
    if (x && "risk" in x) {
      if (!Number.isInteger(x.risk) || x.risk < 1 || x.risk > 10) p.push(`${at}: risk must be an integer from 1 to 10`);
      if (x.status !== "flagged") p.push(`${at}: risk belongs on flagged items only`);
    }
    // critic: a verdict can only lower a status, never raise it
    if (x?.critic != null) {
      const c = x.critic;
      if (!VERDICTS.includes(c.verdict)) p.push(`${at}: critic.verdict must be one of ${VERDICTS.join(", ")}`);
      if (typeof c.by !== "string" || !c.by) p.push(`${at}: critic.by: who or what ran the critic`);
      if (["refuted", "inconclusive"].includes(c.verdict) && !c.note) p.push(`${at}: a ${c.verdict} critic verdict needs a note`);
      if (c.verdict === "refuted" && x.status !== "flagged") p.push(`${at}: refuted by the critic, so the status must be flagged`);
      if (["inconclusive", "unchecked"].includes(c.verdict) && x.status === "confirmed") p.push(`${at}: critic verdict ${c.verdict}, so the status cannot be confirmed`);
      if (c.previous_status != null && !(STATUS_RANK[c.previous_status] < STATUS_RANK[x.status])) p.push(`${at}: critic.previous_status must be a better status than the current one (the critic only lowers)`);
    }
  });
  const want = Object.fromEntries(STATUSES.map((s) => [s, r.items.filter((x) => x?.status === s).length]));
  if (!r.summary || STATUSES.some((s) => r.summary[s] !== want[s])) p.push(`summary: must count the items (${JSON.stringify(want)})`);
  const risks = r.items.filter((x) => Number.isInteger(x?.risk)).map((x) => x.risk);
  if (r.summary && (risks.length ? r.summary.max_risk !== Math.max(...risks) : "max_risk" in r.summary)) p.push(`summary.max_risk: must be the highest item risk${risks.length ? ` (${Math.max(...risks)})` : " (absent when no item has one)"}`);
  const worst = want.flagged ? "flagged" : want.not_confirmed ? "not_confirmed" : "confirmed";
  if (r.status !== worst) p.push(`status: must be the worst item status, "${worst}"`);
  if (r.critic != null) {
    const c = r.critic;
    if (c.enabled !== true) p.push(`critic.enabled: true when the critic block is present`);
    const n = (v) => r.items.filter((x) => x?.critic?.verdict === v).length;
    for (const v of ["upheld", "refuted", "inconclusive", "unchecked"]) if (c[v] !== n(v)) p.push(`critic.${v}: must count the items (${n(v)})`);
    if (c.checked !== n("upheld") + n("refuted") + n("inconclusive")) p.push(`critic.checked: upheld + refuted + inconclusive`);
    r.items.forEach((x, i) => { if (x?.status === "confirmed" && x.critic?.verdict !== "upheld") p.push(`items[${i}]${x.id ? ` (${x.id})` : ""}: the critic is on, so a confirmed item needs an upheld verdict`); });
  }
  if (r.learnings != null && (typeof r.learnings.file !== "string" || !Number.isInteger(r.learnings.added) || r.learnings.added < 1)) p.push(`learnings: needs file and added (≥ 1)`);
  return p;
}

/** Problems with a learnings.jsonl text: one kit.plugin-learning.v1 object per line (blank lines ignored). */
export function validateLearnings(text) {
  const p = [];
  String(text).split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const at = `line ${i + 1}`;
    let l;
    try { l = JSON.parse(line); } catch { p.push(`${at}: not JSON`); return; }
    if (l?.schema !== LEARNING_SCHEMA) p.push(`${at}: schema must be "${LEARNING_SCHEMA}"`);
    if (typeof l?.at !== "string" || Number.isNaN(Date.parse(l.at))) p.push(`${at}: at must be a date-time`);
    for (const k of ["plugin", "skill", "run_id", "text"]) if (typeof l?.[k] !== "string" || !l[k]) p.push(`${at}: ${k} missing`);
    if (l?.plugin && l?.skill && !l.skill.startsWith(`${l.plugin}-`)) p.push(`${at}: skill must start with "${l.plugin}-"`);
    if (l?.run_id && !/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(l.run_id)) p.push(`${at}: run_id must look like 20261001T120000Z-1a2b3c4d`);
    if (!LEARNING_KINDS.includes(l?.kind)) p.push(`${at}: kind must be one of ${LEARNING_KINDS.join(", ")}`);
    if (l?.tags != null && (!Array.isArray(l.tags) || l.tags.some((t) => typeof t !== "string"))) p.push(`${at}: tags must be strings`);
    if (l?.evidence != null && (!Array.isArray(l.evidence) || l.evidence.some((e) => typeof e?.title !== "string"))) p.push(`${at}: evidence items need a title`);
  });
  return p;
}

// CLI: node kit-plugin-check.mjs <dir> [--prefix p] [--server name=url]
if ((() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -, -e): not run directly */ } })()) {
  const a = process.argv.slice(2), dir = a.find((x, i) => !x.startsWith("--") && !a[i - 1]?.startsWith("--")) || ".";
  if (/\.jsonl?$/.test(dir)) {
    const text = readFileSync(resolve(dir), "utf8");
    let problems;
    if (dir.endsWith(".jsonl")) problems = validateLearnings(text);
    else { try { problems = validateReport(JSON.parse(text)); } catch (e) { problems = [`not JSON: ${e.message}`]; } }
    for (const x of problems) process.stderr.write(`  - ${x}\n`);
    process.stdout.write(problems.length ? `${problems.length} problem(s)\n` : "ok\n");
    process.exit(problems.length ? 1 : 0);
  }
  const val = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  const srv = val("server");
  const problems = validatePlugin(resolve(dir), { prefix: val("prefix"), ...(srv ? { servers: { [srv.split("=")[0]]: srv.slice(srv.indexOf("=") + 1) } } : {}) });
  for (const x of problems) process.stderr.write(`  - ${x}\n`);
  process.stdout.write(problems.length ? `${problems.length} problem(s)\n` : "ok\n");
  process.exitCode = problems.length ? 1 : 0;
}
