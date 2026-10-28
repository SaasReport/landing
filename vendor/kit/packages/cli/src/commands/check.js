/**
 * kit check — validates kit.config.js (defineConfig) and the content pack (checkContent). Exit 1 on any problem.
 * A multi-locale site is checked locale by locale (every locale's config, speech and pack; problems prefixed "[ar]").
 *
 * kit check canon [--only schemas,contracts,…] [--json]   the constitution's checks against kit.canon.json
 * kit check lockfile                              package-lock.json satisfies package.json and every workspace (what npm ci needs)
 * kit check fa-review                              the native-review gate: Persian copy changed since its last approval (deploy)
 * kit check concepts [--history] [--runway]        a concept series: config, catalogue, schedule, sizes, sources, accuracy (docs/CONCEPTS.md)
 * kit check shariah-review                          the deploy gate of Shariah content: the signed ledger, its git history, every scheduled concept approved
 * kit check podcast                                 podcast.config.json, covers, the cron, the provenance trigger (t=0 rule)
 * kit check staleness [--json] [--alert] [--report f] [--local [--registry f]]
 *                                                 nothing stale (docs/FRESHNESS.md): branches behind main, a vendored kit behind the kit's head, registry facts
 *                                                 past their max age, toolchain drift, a deploy behind main; kit.staleness-report.v1; --alert sends a
 *                                                 finding through the monitor's alert routes. (`kit check freshness` is the older, different check: every generated artefact's command exits 0.)
 * kit check migrations                            every migrations/*.sql run in order on a fresh local D1 per binding, under D1's limits (docs/PODCASTS.md)
 * kit check schemas | contracts | sdk | hardcoding | freshness | diagrams | digits     one of them
 *   (docs/CONSTITUTION.md: contract first, schema first, canonical, no hardcoding). Exit 1 on any problem.
 */
import { checkContent, eachLocale, isMultiLocale } from "@saasreport/core";
import { loadProject } from "../project.js";
import { CHECKS, runCanon } from "../canon/index.js";
import { podcastCheck } from "../podcast-check.js";
import { loadCanon } from "../canon/index.js";
import { kitFor } from "../bundled.js";
import { checkReview } from "../canon/persian.js";
import { checkConceptsRepo, checkShariahReview } from "../concepts.js";
import { TEST } from "../test-seam.js";
import { witnessOf, verifierOf } from "./ledger.js";
import { lockfileProblems } from "../canon/lockfile.js";
import { stalenessReport, stalenessLocal, stalenessAlert, crashAlert, loadReport, RUNNER_ROUTES } from "../staleness.js";

async function canon(io, which, flags) {
  const only = which === "canon" ? (flags.only ? String(flags.only).split(",").map((s) => s.trim()).filter(Boolean) : CHECKS) : [which];
  const { ok, results } = await runCanon(io.cwd, { kit: kitFor(io), only, govern: which === "canon" && !flags.only, spawn: (cmd, args, opts) => io.spawn(cmd, args, { ...opts, env: io.env, ...(flags.json ? { stdio: ["ignore", 2, 2] } : {}) }) });   // --json: generators' output goes to stderr, stdout stays JSON
  if (flags.json) {
    io.out(JSON.stringify({ ok, results }, null, 2));
    return ok ? 0 : 1;
  }
  let total = 0;
  for (const [name, r] of Object.entries(results)) {
    io[r.ok ? "out" : "err"](`${r.ok ? "ok" : "FAIL"} ${name}: ${r.summary}${r.problems.length ? ` — ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}` : ""}`);
    for (const p of r.problems.slice(0, 200)) io.err(`  - ${p.file}: ${p.problem}`);
    if (r.problems.length > 200) io.err(`  … and ${r.problems.length - 200} more (--json for all)`);
    if (r.report && r.findings?.length) io.out(`  (report only: ${r.findings.length} findings; --json lists them)`);
    total += r.problems.length;
  }
  if (!ok) io.err(`kit check ${which}: ${total} problem${total === 1 ? "" : "s"} (docs/CONSTITUTION.md in SaasReport/kit)`);
  return ok ? 0 : 1;
}

const countsOf = (config, content) => config.series.map((s) => {
  const c = content?.[s.id];
  const n = Array.isArray(c) ? c.length : (c?.terms || c?.items || []).length;
  return `${s.id} ${n}`;
});

export async function check(io, { _: [which] = [], flags }) {
  if (which === "podcast") {
    // The t=0 gate for the podcast pipeline (docs/PODCASTS.md): podcast.config.json, its covers, the cron, the provenance trigger.
    let config = null, project = null;
    try { project = await loadProject(io.cwd, flags); config = project.config; } catch (e) { io.err(`kit check podcast: ${e.message}`); return 1; }
    const r = podcastCheck(io.cwd, { config, content: project?.content });
    for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
    if (r.problems.length) { io.err(`kit check podcast: ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}`); return 1; }
    io.out(`ok podcast: ${r.summary}`);
    return 0;
  }
  if (which === "concepts" || which === "shariah-review") {
    const kit = kitFor(io), file = flags.concepts ? String(flags.concepts) : undefined;
    const witness = witnessOf(flags, io);
    const r = which === "concepts" ? await checkConceptsRepo(io.cwd, kit, { ...(file ? { file } : {}), history: Boolean(flags.history), runway: Boolean(flags.runway), today: flags.today ? String(flags.today) : null, witness, verifier: verifierOf(flags, io) }) : await checkShariahReview(io.cwd, kit, { ...(file ? { file } : {}), witness, verifier: verifierOf(flags, io) });
    for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
    if (!r.ok) { io.err(`kit check ${which}: ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}; ${r.summary} (docs/CONCEPTS.md in SaasReport/kit)`); return 1; }
    io.out(`ok ${which}: ${r.summary}`);
    return 0;
  }
  if (which === "staleness") {
    // The continuous verifier of docs/FRESHNESS.md. A finding is reported, never thrown: the scheduled workflow turns it into an alert and an obligation.
    // --report <file> alerts from a saved report and reads nothing else: an alert never rests on a second read of the world.
    const seam = io[TEST]?.staleness || {};
    const kit = kitFor(io);
    const deps = { ...(io.fetch ? { fetch: io.fetch } : {}), ...(seam.deps || {}) };
    const sendThrough = async (alert) => {
      const { sendAlert } = await import("@saasreport/channels");
      return sendAlert(io.env, {}, alert, { alerts: Object.fromEntries(RUNNER_ROUTES.map((r) => [r, true])), fetch: io.fetch });
    };
    const repoName = io.env.GITHUB_REPOSITORY || "repository";
    let report;
    try {
      report = flags.report ? loadReport(String(flags.report), kit)
        : flags.local ? await stalenessLocal(io.cwd, { registryFile: typeof flags.registry === "string" ? flags.registry : undefined, env: io.env, now: seam.now ?? new Date(), deps, kit })
          : await stalenessReport(io.cwd, { now: seam.now ?? new Date(), deps, kit });
    } catch (e) {
      // the verifier could not produce or read a report: with --alert that is itself told, through the same route, then the run fails; never silent
      if (!flags.alert) throw e;
      const r = await sendThrough(crashAlert(e, { repo: repoName, day: (seam.now ?? new Date()).toISOString().slice(0, 10) }));
      io.err(`kit check staleness: ${e.message}`);
      io.err(r.configured ? `  crash alert sent through ${Object.keys(r.refs || {}).join(", ") || "no route"}${Object.keys(r.errors || {}).length ? `; failed: ${Object.keys(r.errors).join(", ")}` : ""}` : "  crash alert: no route configured on this runner; the failed run itself is the alert");
      return 1;
    }
    if (flags.json) io.out(JSON.stringify(report, null, 2));
    else {
      const head = report.derived_from.main_head;
      io[report.ok ? "out" : "err"](`${report.ok ? "ok" : "FAIL"} staleness (${report.mode}): ${report.checked.length} class${report.checked.length === 1 ? "" : "es"} checked${report.mode === "repo" ? ` against main ${head ? head.slice(0, 12) : "(unreadable)"}` : ""}${report.findings.length ? `; ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}` : ""}`);
      for (const n of report.not_applicable) io.out(`  n/a ${n.class}: ${n.reason}`);
      for (const f of report.findings) io.err(`  - ${f.class}: ${f.problem}`);
    }
    if (flags.alert && !report.ok) {
      const r = await sendThrough(stalenessAlert(report, { repo: repoName }));
      io.err(r.configured ? `  alert sent through ${Object.keys(r.refs || {}).join(", ") || "no route"}${Object.keys(r.errors || {}).length ? `; failed: ${Object.keys(r.errors).join(", ")}` : ""}` : "  alert: no route configured on this runner (telegram, bale or webhook secrets); the failed run itself is the alert");
    }
    return report.ok ? 0 : 1;
  }
  if (which === "lockfile") {
    // package-lock.json satisfies package.json and every workspace (what `npm ci` needs): found locally, not on the runners.
    const { canon: lc } = loadCanon(io.cwd);
    const ps = lockfileProblems(io.cwd, { vendor: lc?.vendor });
    for (const p of ps) io.err(`  - ${p.file}: ${p.problem}`);
    if (ps.length) { io.err(`kit check lockfile: ${ps.length} problem${ps.length === 1 ? "" : "s"}`); return 1; }
    io.out("ok lockfile: package-lock.json satisfies package.json and every workspace");
    return 0;
  }
  if (which === "fa-review") {
    // The deploy gate (docs/PERSIAN.md): Persian copy whose content hash changed since a native reader approved it.
    const kit = kitFor(io);
    const { canon: c, problems: cp } = loadCanon(io.cwd, kit);
    const r = c ? await checkReview(io.cwd, c, kit, { witness: witnessOf(flags, io), verifier: verifierOf(flags, io) }) : { ok: false, summary: "kit.canon.json", problems: cp };
    for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
    if (!r.ok) { io.err(`kit check fa-review: ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}; ${r.summary}. Persian copy does not publish before a native review (docs/PERSIAN.md in SaasReport/kit)`); return 1; }
    io.out(`ok fa-review: ${r.summary}`);
    return 0;
  }
  if (which === "canon" || CHECKS.includes(which)) return canon(io, which, flags);
  if (which) { io.err(`kit check: unknown check "${which}" (canon, ${CHECKS.join(", ")}, or none for the content pack)`); return 1; }
  const project = await loadProject(io.cwd, flags);
  const problems = checkContent(project.config, project.content);
  const multi = isMultiLocale(project.config);
  const locales = multi ? eachLocale(project.config, project.content) : null;
  const counts = multi ? locales.map((x) => `[${x.locale}] ${countsOf(x.config, x.content).join(", ")}`) : countsOf(project.config, project.content);
  if (problems.length) {
    io.err(`${problems.length} problem${problems.length === 1 ? "" : "s"} in the content pack:`);
    for (const p of problems) io.err(`  - ${p}`);
    return 1;
  }
  const langs = multi ? locales.map((x) => x.config.site.locale).join(", ") : project.config.site.locale;
  io.out(`ok: ${project.config.site.name} (${langs}, ${project.config.calendar.system}); config valid; content: ${counts.join(multi ? "; " : ", ")}; no problems.`);
  return 0;
}
