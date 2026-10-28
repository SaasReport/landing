/**
 * The scheduled watcher (docs/RESILIENCE.md), run by a GitHub workflow: another failure domain than the Cloudflare account that hosts the
 * monitor and its D1. GitHub notifies a failed scheduled run to the user who last changed the workflow's cron, so the owner must be the
 * one who commits that line; `kit resilience keepalive` keeps GitHub from disabling the schedule.
 *
 *   watchStatus(url, { staleAfterMin, routes, now, fetch })   a worker monitor's status document (contract kit.monitor-status.v1)
 *   watchHealth(url, { fetch })                               a watcher monitor's health URL (2xx within the timeout)
 *   keepalive({ token, repository, workflow, fetch })          PUT .../actions/workflows/<file>/enable (no commit needed)
 * Every limit is a positive integer from resilience.json; anything else is a failure, never NaN.
 */
import { readFileSync } from "node:fs";
import { createValidator, formatProblems } from "@saasreport/core/schema";

// the sibling package by path (present wherever the CLI is: the kit, a vendored snapshot): the ONE contract of the status document
const STATUS = JSON.parse(readFileSync(new URL("../../../monitor/contracts/status.schema.json", import.meta.url), "utf8"));
const validator = createValidator([STATUS]);
export const statusProblems = (doc) => formatProblems(validator.validate(doc, STATUS.$id));
const SKEW_MS = 5 * 60 * 1000;

async function getJson(url, f, timeoutMs) {
  const res = await f(url, { headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { error: `answered ${res.status}` };
  if (!/application\/json/.test(res.headers.get("content-type") || "")) return { error: `answered ${res.headers.get("content-type") || "no content type"}, not JSON` };
  try { return { doc: await res.json() }; } catch (e) { return { error: `is not JSON (${e.message})` }; }
}

export async function watchStatus(url, { staleAfterMin, routes = [], now = Date.now(), fetch: f = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!Number.isInteger(staleAfterMin) || staleAfterMin <= 0) return { ok: false, problems: [`the stale limit ${staleAfterMin} is not a positive whole number of minutes`], status: null };
  const problems = [];
  let doc = null;
  try {
    const r = await getJson(url, f, timeoutMs);
    if (r.error) problems.push(`the status endpoint ${r.error}`); else doc = r.doc;
  } catch (e) { problems.push(`the status endpoint is unreachable: ${String(e?.message || e).slice(0, 200)}`); }
  if (doc) {
    const bad = statusProblems(doc);
    if (bad.length) return { ok: false, problems: [`the status document breaks its contract (kit.monitor-status.v1): ${bad.slice(0, 3).join("; ")}`], status: null };
    const age = (iso) => now - Date.parse(iso);
    if (!doc.last) problems.push("the monitor has never run (status unknown)");
    else {
      const a = age(doc.last.started_at);
      if (a < -SKEW_MS) problems.push(`the last run is dated ${doc.last.started_at}, in the future: a clock or a forged row`);
      else if (a > staleAfterMin * 60000) problems.push(`the last monitor run is ${Math.floor(a / 60000)} min old (limit ${staleAfterMin}): the monitor stopped`);
    }
    if (doc.status === "stale") problems.push("the status document itself says stale");
    if (doc.reason === "not-configured") problems.push("the monitor's stale limit is not configured (the status document says not-configured)");
    for (const r of doc.routes) if (r.last_attempt_at === null) problems.push(`route ${r.route}: never attempted (a declared route nobody has tried is not proven)`);
    const failedRuns = doc.recent.filter((r) => r.alert_status === "failed");
    if (failedRuns.length) problems.push(`${failedRuns.length} recent run(s) could not deliver an alert, e.g. ${failedRuns[0].alert_reason || "no reason recorded"}`);
    for (const ch of routes) {
      const r = doc.routes.find((x) => x.route === ch);
      if (!r) { problems.push(`route ${ch}: no delivery recorded (the canary never went out)`); continue; }
      if (r.last_attempt_at === null) continue;   // reported above
      if (r.last_ok_at && age(r.last_ok_at) < -SKEW_MS) problems.push(`route ${ch}: last delivered ${r.last_ok_at}, in the future: a clock or a forged row`);
      else if (!r.last_ok_at || age(r.last_ok_at) > staleAfterMin * 60000) problems.push(`route ${ch}: last delivered ${r.last_ok_at || "never"} (limit ${staleAfterMin} min)`);
      if (r.failed > 0) problems.push(`route ${ch}: ${r.failed} failed deliver${r.failed === 1 ? "y" : "ies"} in the window (${r.last_reason})`);
    }
  }
  return { ok: !problems.length, problems, status: doc?.status ?? null };
}

export async function watchHealth(url, { fetch: f = globalThis.fetch, timeoutMs = 20000 } = {}) {
  try {
    const res = await f(url, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { ok: true, problems: [] } : { ok: false, problems: [`the health URL answered ${res.status}`] };
  } catch (e) { return { ok: false, problems: [`the health URL is unreachable: ${String(e?.message || e).slice(0, 200)}`] }; }
}

export async function keepalive({ token, repository, workflow, fetch: f = globalThis.fetch, api = "https://api.github.com" }) {
  if (!token || !repository || !workflow) return { ok: false, error: "GITHUB_TOKEN, GITHUB_REPOSITORY and the workflow file are required" };
  const file = workflow.split("/").pop();
  const res = await f(`${api}/repos/${repository}/actions/workflows/${encodeURIComponent(file)}/enable`, { method: "PUT", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  return res.status === 204 ? { ok: true } : { ok: false, error: `GitHub answered ${res.status}` };
}
