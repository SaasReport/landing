/**
 * kit release (docs/RELEASE.md): the steps of the ONE production workflow (templates/ci/production.yml) and of the drift workflow
 * (templates/ci/drift.yml). Project facts come from release.json (kit.release.v1); nothing here is per-project code.
 *
 * kit release check [--json]                  the canon check `release` alone
 * kit release build                           run release.json build.run once and seal the artefact (.release/seal.json); before npm test
 * kit release ship                            CI only, in this repository's production workflow, or in release.json deployer.repository
 *                                             (central mode: KIT_RELEASE_SOURCE_REPOSITORY, KIT_RELEASE_SOURCE_SHA = the tested tree's HEAD): guard, seal, bootstrap or READY, create-or-find D1/R2,
 *                                             migrate each D1 before its Workers, deploy each Worker with its commit, write the owner
 *                                             address, verify every Worker serves the commit
 * kit release verify --commit <sha> [--wait]  every Worker's GET /api/build against <sha>, no credential. Exit 0 ok, 1 drift (a commit was
 *                                             read and it is another one), 2 unreadable, 3 bootstrap claimed while a Worker serves a build
 * kit release drills --requested none|restore|alert|publish|all
 *                                             the drills asked for (every one in bootstrap), recorded; bootstrap → ready
 * kit release workers [--json]               the project and the Workers release.json deploys, in order: { project, workers: [{ name, wrangler }] } (kit.release-workers.v1)
 * kit release records branch|paths|workflow|check [--artifact]
 *                                             the records pull request's constants (kit.canon.json workflows.ci.records): the branch of this run, the git pathspecs
 *                                             (--artifact: the upload-artifact path input as a step output) of the files it commits, the workflow it dispatches, the check it reports
 * kit release head-check                     central mode, the deployer's re-read: git ls-remote over SSH (host key pinned) of the source's main must equal KIT_RELEASE_SOURCE_SHA and this tree's HEAD; exit 1 otherwise
 * kit release review-marker --pr <n> [--head <sha>] [--post-status]   the required check independent-review: the owner's verdict=clean marker for the PR's current head, posted as the commit status independent-review on it
 *                                             (exit: the verdict, 0 clean / 1 not; with --post-status the status carries the verdict, so exit 0 once it is posted, 1 only when it could not be)
 * kit release deployer-check <workflow.yml>   the central deployer's workflow: ship is immediately preceded by the git ls-remote re-read of main with the deploy key
 * kit release status-url --monitor <id>       the monitor's own status URL, derived from release.json workers_dev and its Worker name
 */
import { execFileSync, spawn } from "node:child_process";
import { gitEnv } from "../git.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "../args.js";
import { loadCanon, bundled } from "../canon/index.js";
import { checkRelease } from "../release/check.js";
import { recordsConstants, recordsBranch, recordsPathspecs, recordsArtifactPaths } from "../release/records.js";
import { loadRelease, releaseWorkers, releaseIdentity, monitorStatusUrl, IDENTITY_ENV } from "../release/config.js";
import { formatProblems } from "@saasreport/core/schema";
import { deployerWorkflowProblems } from "../release/deployer-check.js";
import { headCheck, HeadCheckError } from "../release/head-check.js";
import { reviewMarker } from "../release/review-marker.js";
import { requiredSecrets, monitorConfig } from "../resilience/check.js";
import { writeSeal } from "../release/seal.js";
import { ship, verify, drills, bootstrapLie, cfClient, ghClient, ReleaseError } from "../release/run.js";
import { RESILIENCE_FILE } from "../resilience/check.js";
import { readJsonIf } from "../release/config.js";
import { fileURLToPath } from "node:url";

/** This CLI's own entry (the vendored snapshot's or the kit's), for the purge step. */
const KIT_BIN = fileURLToPath(new URL("../../bin/kit.js", import.meta.url));

/** Run a command line from release.json (build.run, drills[].run) in the repository; resolves to its exit code. */
const shell = (cwd, env) => (line, extra = {}) => new Promise((res) => {
  const p = spawn("bash", ["-euo", "pipefail", "-c", line], { cwd, env: { ...env, ...extra }, stdio: "inherit" });
  p.on("close", (code) => res(code ?? 1));
});

/** wrangler from the repository's own install; stdin carries a secret value (never argv). Rejects on a non-zero exit. */
const wranglerRunner = (cwd, env) => (args, { input } = {}) => new Promise((res, rej) => {
  const p = spawn("npx", ["--no-install", "wrangler", ...args], { cwd, env, stdio: [input == null ? "inherit" : "pipe", "inherit", "inherit"] });
  if (input != null) { p.stdin.write(input); p.stdin.end(); }
  p.on("close", (code) => (code === 0 ? res() : rej(new ReleaseError(`wrangler ${args.slice(0, 2).join(" ")} exited ${code}`))));
});

function loaded(io) {
  const kit = bundled();
  const { doc, problems } = loadRelease(io.cwd, kit);
  if (!doc) throw new CliError(problems.map((p) => `${p.file}: ${p.problem}`).join("; "), 1);
  return { kit, doc };
}

export async function release(io, { _: [sub, arg] = [], flags }) {
  const env = io.env || process.env;
  try {
    if (sub === "check") {
      const kit = bundled();
      const { canon, problems } = loadCanon(io.cwd, kit);
      if (!canon) { for (const p of problems) io.err(`  - ${p.file}: ${p.problem}`); return 1; }
      const r = await checkRelease(io.cwd, canon, kit);
      if (flags.json) { io.out(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
      io[r.ok ? "out" : "err"](`${r.ok ? "ok" : "FAIL"} release: ${r.summary}`);
      for (const p of r.problems) io.err(`  - ${p.file}: ${p.problem}`);
      return r.ok ? 0 : 1;
    }
    if (sub === "build") {
      const { kit, doc } = loaded(io);
      // the seal names the commit that is deployed: the identity's (central mode: KIT_RELEASE_SOURCE_SHA, never the deployer's GITHUB_SHA), refused when unset
      let id;
      try { id = releaseIdentity(doc, env, kit); } catch (e) { throw new CliError(`kit release build: ${e.message} (the workflow step must pass ${(doc.deployer ? IDENTITY_ENV.central : IDENTITY_ENV.local).join(", ")})`, 1); }
      io.out(`the one build: ${doc.build.run}`);
      const code = await shell(io.cwd, env)(doc.build.run);
      if (code !== 0) { io.err(`the build failed (exit ${code})`); return code; }
      const seal = writeSeal(io.cwd, doc.build.artifact, { commit: id.commit, build: doc.build.run });
      // the digest is a step output: ship compares the seal on disk with it (SEAL_SHA256), so nothing between the two steps can reseal
      if (env.GITHUB_OUTPUT) (await import("node:fs")).appendFileSync(env.GITHUB_OUTPUT, `sha256=${seal.sha256}\n`);
      io.out(`sealed ${Object.keys(seal.files).length} file(s) of ${doc.build.artifact.join(", ")}: ${seal.sha256.slice(0, 16)}`);
      return 0;
    }
    if (sub === "ship") {
      if (env.GITHUB_ACTIONS !== "true") throw new CliError("kit release ship runs only in the production workflow (GitHub Actions, environment production): production is never changed from a machine", 2);
      const { kit } = loaded(io);
      const tmp = mkdtempSync(join(tmpdir(), "kit-release-"));
      try {
        const r = await ship(io.cwd, {
          kit, env, tmp, log: (m) => io.out(m),
          cf: cfClient({ token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, fetch: io.fetch }),
          gh: ghClient({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY, fetch: io.fetch }),
          checkoutHead: async () => execFileSync("git", ["-C", io.cwd, "rev-parse", "HEAD"], { encoding: "utf8", env: gitEnv() }).trim(),
          wrangler: wranglerRunner(io.cwd, env),
          run: async (what) => { if (what === "purge") { const c = await shell(io.cwd, env)(`node ${KIT_BIN} purge`); if (c !== 0) throw new ReleaseError(`kit purge exited ${c}`); } },
          fetch: io.fetch,
        });
        if (env.GITHUB_OUTPUT) (await import("node:fs")).appendFileSync(env.GITHUB_OUTPUT, `records=${r.records ? "true" : "false"}\n`);
        io.out(`ok release: ${r.state}, ${r.workers.length} Worker(s) serve ${r.commit}`);
        return 0;
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
    if (sub === "verify") {
      const { doc } = loaded(io);
      const workers = releaseWorkers(io.cwd, doc);
      const lie = await bootstrapLie(doc, workers, io.fetch);
      if (lie) { io.err(lie); return 3; }   // fails and alerts, never dispatches a deploy
      const v = await verify(io.cwd, { doc, workers, commit: String(flags.commit || ""), fetch: io.fetch, attempts: flags.wait ? 12 : 1 });
      if (!v.problems.length) { io.out(`ok every Worker serves ${flags.commit}`); return 0; }
      io.err(`${v.unreadable && !v.drift ? "unreadable" : "drift"}:\n${v.problems.map((p) => `- ${p}`).join("\n")}`);
      return v.drift ? 1 : 2;
    }
    if (sub === "drills") {
      const { kit } = loaded(io);
      const r = await drills(io.cwd, { kit, requested: String(flags.requested || "none"), run: shell(io.cwd, env), env, log: (m) => io.out(m) });
      if (env.GITHUB_OUTPUT) (await import("node:fs")).appendFileSync(env.GITHUB_OUTPUT, `records=${r.records ? "true" : "false"}\n`);
      io.out(r.drills.length ? `ok ${r.drills.length} drill(s): ${r.drills.join(", ")}` : "no drill asked for");
      return 0;
    }
    if (sub === "head-check") {
      // central mode, in the deployer's job after the deploy key is loaded: ls-remote over SSH (host key pinned by GIT_SSH_COMMAND) against KIT_RELEASE_SOURCE_SHA and this tree's HEAD
      const { kit, doc } = loaded(io);
      try {
        const r = await headCheck({
          doc, kit, env,
          lsRemote: async (repository) => (io.lsRemote ? io.lsRemote(repository) : execFileSync("git", ["ls-remote", "--", `git@github.com:${repository}.git`, "refs/heads/main"], { encoding: "utf8", timeout: 30000, env: gitEnv(env) })),
          checkoutHead: async () => (io.checkoutHead ? io.checkoutHead() : execFileSync("git", ["-C", io.cwd, "rev-parse", "HEAD"], { encoding: "utf8", env: gitEnv() }).trim()),
        });
        io.out(`ok head-check: ${r.repository} main is ${r.sha}, the shipped commit and the tested tree`);
        return 0;
      } catch (e) {
        if (e instanceof HeadCheckError) { io.err(`kit release head-check: ${e.message}`); return 1; }
        throw e;
      }
    }
    if (sub === "review-marker") {
      // the required check independent-review (governance.json independent_review_marker): the project's owner recorded verdict=clean for this PR's current head
      const kit = bundled();
      const { canon, problems } = loadCanon(io.cwd, kit);
      if (!canon) { for (const p of problems) io.err(`  - ${p.file}: ${p.problem}`); return 1; }
      const owner = kit.registry.projects.find((p) => p.key === canon.project)?.owner?.github;
      const r = await reviewMarker({ owner, repository: env.GITHUB_REPOSITORY, pr: flags.pr, head: flags.head ? String(flags.head) : undefined, token: env.GH_TOKEN, fetch: io.fetch, post: Boolean(flags["post-status"]) });
      // with --post-status the VERDICT is the status on the head (the required check), so a status that was posted is a job that did its work: it exits 0
      // whether the verdict is success or failure (a red job for every "not reviewed yet" is a notification, not a gate). Without --post-status, and when
      // nothing could be posted, the exit code is the verdict, as before.
      if (r.posted) { io.out(`ok independent-review: posted ${r.ok ? "success" : "failure"} on the head: ${r.reason}`); return 0; }
      io[r.ok ? "out" : "err"](`${r.ok ? "ok" : "FAIL"} independent-review: ${r.reason}`);
      return r.ok ? 0 : 1;
    }
    if (sub === "deployer-check") {
      if (!arg) throw new CliError("kit release deployer-check <workflow.yml>: name the deployer's workflow file", 2);
      // the names the project declares are Worker secrets, never source credentials (resilience.json, the one source), when this repository has them
      const res = readJsonIf(io.cwd, RESILIENCE_FILE);
      const declared = [];
      for (const m of (res?.monitors || []).filter((x) => x.kind === "worker")) declared.push(...requiredSecrets(res, m, await monitorConfig(io.cwd, m)));
      const problems = deployerWorkflowProblems(readFileSync(resolve(io.cwd, arg), "utf8"), { declared });
      for (const x of problems) io.err(`  - ${x.job}${x.step ? ` / ${x.step}` : ""}: ${x.problem}`);
      io[problems.length ? "err" : "out"](`${problems.length ? "FAIL" : "ok"} deployer-check ${arg}${problems.length ? `: ${problems.length} problem(s)` : ": ship is immediately preceded by the ls-remote re-read of main with the deploy key"}`);
      return problems.length ? 1 : 0;
    }
    if (sub === "workers") {
      const { kit, doc } = loaded(io);
      const out = { project: doc.project, workers: releaseWorkers(io.cwd, doc).map((w) => ({ name: w.name, wrangler: w.wrangler })) };
      const bad = formatProblems(kit.validator.validate(out, kit.byName("release-workers")));
      if (bad.length) throw new CliError(`kit.release-workers.v1: ${bad.join("; ")}`, 1);
      io.out(flags.json ? JSON.stringify(out, null, 2) : out.workers.map((w) => `${w.name}  ${w.wrangler}`).join("\n"));
      return 0;
    }
    if (sub === "records") {
      const what = arg;
      const c = recordsConstants(io.cwd);
      if (what === "branch") { io.out(recordsBranch(c, env)); return 0; }
      if (what === "workflow" || what === "check") { io.out(c[what]); return 0; }
      if (what === "paths") { io.out((flags.artifact ? [`paths<<KIT_RECORDS_EOF`, ...recordsArtifactPaths(c), "KIT_RECORDS_EOF"] : recordsPathspecs(c)).join("\n")); return 0; }
      throw new CliError("kit release records branch|paths|workflow|check [--artifact]", 2);
    }
    if (sub === "status-url") {
      const { doc } = loaded(io);
      const res = readJsonIf(io.cwd, RESILIENCE_FILE);
      const m = res?.monitors?.find((x) => x.id === flags.monitor);
      if (!m?.worker) throw new CliError(`no worker monitor "${flags.monitor}" in ${RESILIENCE_FILE}`, 1);
      const url = monitorStatusUrl(io.cwd, doc, m.worker.wrangler, m.worker.env || "");
      if (!url) throw new CliError("release.json declares no workers_dev subdomain: the monitor's status URL cannot be derived", 1);
      io.out(url);
      return 0;
    }
  } catch (e) {
    if (e instanceof ReleaseError) { io.err(`kit release ${sub}: ${e.message}`); return 1; }
    throw e;
  }
  throw new CliError(`unknown release command "${sub ?? ""}" (check, build, ship, verify, drills, workers, head-check, deployer-check, review-marker, status-url)`, 2);
}
