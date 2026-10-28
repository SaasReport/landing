// The overview: every Worker's /api/build against main's head, delivery and lead counts, and the provisioning readiness.
import { buildBehind, commitOf, UNREACHABLE } from "@saasreport/cloudflare/build";
import { deliverySummary } from "@saasreport/core/form-deliveries";
import { config, snapshot, text } from "../config.js";
import { json, isoNow, isMissingTable } from "../http.js";
import { auditDb, engineDb } from "../db.js";
import { readiness } from "./provisioning.js";

const HEAD = /^[0-9a-f]{40}$/;

async function mainHead(env, fetchFn) {
  const token = text(env, config.secrets.githubRead);
  if (!token) return { available: false, reason: "not_configured" };
  try {
    const res = await fetchFn(`https://${config.github.host}/repos/${snapshot.repository}/commits/main`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": `${snapshot.project}-admin`, "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(config.limits.fetchTimeoutMs) });
    if (!res.ok) return { available: false, reason: `github_${res.status}` };
    const sha = (await res.json())?.sha;
    return HEAD.test(sha ?? "") ? { available: true, commit: sha } : { available: false, reason: "unreadable" };
  } catch (e) { console.error("[admin] main's head could not be read", String(e?.message || e).slice(0, 120)); return { available: false, reason: "unreachable" }; }
}

async function probe(target, env, fetchFn) {
  const row = { id: target.id, via: target.via, reachable: false, commit: UNREACHABLE, matches_main: null };
  if (target.via === "binding") {
    const b = await buildBehind(env[target.binding], { timeoutMs: config.limits.fetchTimeoutMs });
    return { ...row, reachable: b.commit !== UNREACHABLE, commit: b.commit, services: b.services };
  }
  const host = snapshot.hosts[target.sub];
  if (!host) return { ...row, error: "host_not_in_registry" };
  try {
    const res = await fetchFn(`https://${host}/api/build`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(config.limits.fetchTimeoutMs) });
    const b = res.ok ? await res.json() : null;
    if (b && "commit" in b) return { ...row, reachable: true, commit: b.commit, services: b.services && typeof b.services === "object" ? b.services : {} };
    return { ...row, error: `status_${res.status}` };
  } catch (e) { console.error("[admin] a Worker did not answer /api/build", target.id, String(e?.message || e).slice(0, 120)); return { ...row, error: "unreachable" }; }
}

/** The overview as an object (the areas reuse it). */
export async function buildOverview(ctx) {
  const fetchFn = ctx.fetch ?? ((...a) => fetch(...a));
  const [head, probed] = await Promise.all([mainHead(ctx.env, fetchFn), Promise.all(config.targets.map((t) => probe(t, ctx.env, fetchFn)))]);
  const self = { id: config.component, via: "self", reachable: true, commit: commitOf(ctx.env), matches_main: null };
  const workers = [self, ...probed].map((w) => ({ ...w, matches_main: head.available && w.reachable && HEAD.test(w.commit ?? "") ? w.commit === head.commit : null }));
  const edb = engineDb(ctx.env), adb = auditDb(ctx.env);
  const deliveries = edb ? await deliverySummary(edb, {}).catch((e) => { console.error("[admin] the deliveries summary could not be read", String(e?.message || e).slice(0, 120)); return { available: false }; }) : { available: false };
  let leads = { available: false, total: 0, by_status: {} };
  if (edb && adb) {
    try {
      const total = Number((await edb.prepare(`SELECT COUNT(*) AS n FROM ${config.tables.leads}`).first())?.n ?? 0);
      const { results = [] } = await adb.prepare("SELECT status, COUNT(*) AS n FROM admin_lead_state GROUP BY status").all();
      const by = Object.fromEntries(["new", "contacted", "qualified", "won", "lost"].map((k) => [k, 0]));
      let other = 0;
      for (const r of results) if (r.status !== "new") { by[r.status] = Number(r.n); other += Number(r.n); }
      by.new = Math.max(0, total - other);
      leads = { available: true, total, by_status: by };
    } catch (e) { if (!isMissingTable(e)) throw e; }
  }
  const r = readiness(ctx.env);
  return { generated_at: isoNow(), workers, main_head: head, deliveries, leads, provisioning: { ready: r.ready, missing: r.missing } };
}

export const getOverview = async (ctx) => json(await buildOverview(ctx));
