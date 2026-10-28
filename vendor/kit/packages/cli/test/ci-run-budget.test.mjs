// ci-run-budget (docs/CONSTITUTION.md, the CI run budget): full CI runs once per commit that matters. The written forms of the
// class are findings/ci-run-budget/forms.json (proven in findings.test.mjs); these tests prove what a form file cannot: the repository's
// own workflows and the CI templates obey the policy, the declared exceptions are bound with their reasons, and a draft pull request
// really is the only thing the draft guard lets through unrun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate } from "../src/canon/findings.js";
import { walk } from "../src/canon/files.js";
import { loadCanon } from "../src/canon/index.js";
import { tempDir } from "../../core/test/support/temp.mjs";
import { parse as parseYaml } from "yaml";
import { conditionRuns } from "../src/agent-guard/job-condition.js";

const KIT = fileURLToPath(new URL("../../../", import.meta.url));
const CI_CLASSES = ["ci-run-budget", "workflow-runs-on-archive", "ci-run-concurrency", "ci-runner-pinned", "ci-action-pinned", "ci-canary-expired"];
const SCHEMA = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json";
const canon = (exc = []) => JSON.stringify({ workflows: { runner: "ubuntu-24.04", canary: { runner: "ubuntu-26.04", review_by: "2099-12-31" }, ci: { branches: ["main"], schedule_exceptions: exc } } });

function repo(t, files) {
  const root = tempDir(t, "kit-budget-");
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); }
  return root;
}
const budget = (root) => runGate("ci-run-budget", root, walk(root));

test("the kit's own workflows obey every CI class (the policy it enforces on its sites)", async (t) => {
  const files = { "kit.canon.json": readFileSync(join(KIT, "kit.canon.json"), "utf8") };
  for (const f of readdirSync(join(KIT, ".github/workflows"))) files[`.github/workflows/${f}`] = readFileSync(join(KIT, ".github/workflows", f), "utf8");
  const root = repo(t, files);
  for (const id of CI_CLASSES) assert.deepEqual(await runGate(id, root, walk(root), undefined, { today: "2026-10-08" }), [], id);
});

test("the CI template a site copies obeys every CI class, and keeps the check names branch protection requires", async (t) => {
  const text = readFileSync(join(KIT, "templates/ci/test.yml"), "utf8");
  const root = repo(t, { "kit.canon.json": canon(), ".github/workflows/test.yml": text });
  for (const id of CI_CLASSES) assert.deepEqual(await runGate(id, root, walk(root), undefined, { today: "2026-10-08" }), [], id);
  const wf = parseYaml(text);
  assert.equal(wf.jobs.test.name, "test (ubuntu-24.04)", "the required check name is unchanged");
  assert.equal(wf.jobs.visual.name, "visual (ubuntu-24.04)");
  assert.deepEqual(wf.on.pull_request.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
  assert.deepEqual(wf.on.push.branches, ["main", "resilience-records/**"]);
});

test("the resilience watcher template passes only with its frequent schedule declared as a reviewed exception", async (t) => {
  const text = readFileSync(join(KIT, "templates/resilience/watch.yml"), "utf8");
  const crons = parseYaml(text).on.schedule.map((s) => s.cron);
  const bare = await budget(repo(t, { "kit.canon.json": canon(), ".github/workflows/watch.yml": text }));
  // each undeclared frequent cron is refused, and with more than one the list as a whole is too (each fires on its own)
  const expected = [...(crons.length > 1 ? ["/on/schedule"] : []), ...crons.map((_, i) => `/on/schedule/${i}/cron`)];
  assert.deepEqual(bare.map((f) => f.match).sort(), expected.sort(), "an undeclared frequent schedule is refused");
  const declared = crons.map((cron) => ({ cron, reason: "the independent watcher of the monitor runs outside Cloudflare on this cadence" }));
  assert.deepEqual(await budget(repo(t, { "kit.canon.json": canon(declared), ".github/workflows/watch.yml": text })), []);
});

test("schedule_exceptions is bound with its reasons: a list that is not [{ cron, reason }] is a finding, never a pass", async (t) => {
  const wf = ".github/workflows/w.yml";
  const w = "name: w\non:\n  schedule:\n    - cron: '7 */2 * * *'\njobs:\n  w:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n";
  const withExc = (exc) => repo(t, { "kit.canon.json": JSON.stringify({ workflows: { runner: "ubuntu-24.04", ci: { schedule_exceptions: exc } } }), [wf]: w });
  for (const exc of ["7 */2 * * *", ["7 */2 * * *"], [{ cron: "7 */2 * * *" }], [null], { cron: "7 */2 * * *" }]) {
    const found = await budget(withExc(exc));
    assert.ok(found.some((f) => /^(bad bind|unbound)/.test(f.match)), JSON.stringify([exc, found]));
  }
  assert.deepEqual(await budget(withExc([{ cron: "7 */2 * * *", reason: "the watcher of the monitor, outside Cloudflare, every two hours" }])), []);
  assert.equal((await budget(withExc([{ cron: "8 */2 * * *", reason: "another cron, so this one is still undeclared" }]))).length, 1);
  assert.equal((await budget(repo(t, { "kit.canon.json": JSON.stringify({ workflows: { runner: "ubuntu-24.04" } }), [wf]: w }))).length, 1, "no ci block: the defaults (main only, no exception) stand");
});

test("the declared branches are the only push branches; a branch the repository did not declare is refused", async (t) => {
  const w = (b) => `name: w\non:\n  push:\n    branches: [${b}]\njobs:\n  w:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n`;
  const files = (b, branches) => ({ "kit.canon.json": JSON.stringify({ workflows: { runner: "ubuntu-24.04", ci: { branches } } }), ".github/workflows/w.yml": w(b) });
  assert.deepEqual(await budget(repo(t, files("main", ["main"]))), []);
  assert.deepEqual(await budget(repo(t, files("trunk", ["trunk"]))), [], "the declaration, not a built-in name");
  assert.equal((await budget(repo(t, files("main, release", ["main"])))).length, 1);
  assert.deepEqual(await budget(repo(t, files("main, release", ["main", "release"]))), []);
});

test("kit.canon.json workflows.ci is the declared shape: literal branches, and every exception carries its cron and a real reason", (t) => {
  const check = (ci) => loadCanon(repo(t, { "kit.canon.json": JSON.stringify({ $schema: SCHEMA, project: "kit", workflows: { runner: "ubuntu-24.04", ci } }) })).problems.map((p) => p.problem);
  assert.deepEqual(check({ branches: ["main"], schedule_exceptions: [] }), []);
  assert.deepEqual(check({ branches: ["main"], schedule_exceptions: [{ cron: "7 */2 * * *", reason: "the watcher of the monitor, outside Cloudflare" }] }), []);
  for (const ci of [{ branches: ["claude/**"] }, { branches: ["*"] }, { branches: [] }, { branches: ["main", "main"] }, { schedule_exceptions: [{ cron: "7 */2 * * *" }] }, { schedule_exceptions: [{ cron: "7 */2 * * *", reason: "because" }] }, { schedule_exceptions: ["7 */2 * * *"] }, { extra: 1 }]) {
    assert.ok(check(ci).length > 0, `lets through ${JSON.stringify(ci)}`);
  }
});

test("the draft guard: kit test.yml's real job condition runs on push, dispatch and a non-draft pull request, and skips a draft and the schedule (evaluated, not mirrored)", () => {
  const cond = parseYaml(readFileSync(join(KIT, ".github/workflows/test.yml"), "utf8")).jobs.test.if;
  const ctx = (event, draft = null) => ({ "github.event_name": event, "github.event.pull_request.draft": draft });
  for (const [c, runs] of [[ctx("push"), true], [ctx("workflow_dispatch"), true], [ctx("schedule"), false], [ctx("pull_request", false), true], [ctx("pull_request", true), false]]) {
    assert.equal(conditionRuns(cond, c), runs, JSON.stringify(c));
  }
});

test("a pull request that is ready or reopened is tested once: opened, synchronize, reopened and ready_for_review are the whole trigger, with no push on its branch", () => {
  const on = parseYaml(readFileSync(join(KIT, ".github/workflows/test.yml"), "utf8")).on;
  assert.deepEqual(on.pull_request.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
  assert.deepEqual(on.push, { branches: ["main", "resilience-records/**"] });   // main, and the records branch whose push produces the records pull request's required check
});

test("the weekly budget holds for the whole schedule list: two weekly crons fire twice a week (Codex on kit #135)", async (t) => {
  const wf = (crons) => `name: w\non:\n  schedule:\n${crons.map((c) => `    - cron: '${c}'\n`).join("")}jobs:\n  w:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: echo\n`;
  const run = (crons, exc = []) => budget(repo(t, { "kit.canon.json": canon(exc), ".github/workflows/w.yml": wf(crons) }));
  // must fail: Monday and Tuesday, each weekly alone
  const two = await run(["17 3 * * 1", "17 3 * * 2"]);
  assert.ok(two.some((f) => f.match === "/on/schedule"), `two undeclared weekly crons are refused, got ${JSON.stringify(two)}`);
  // must pass: one weekly cron; one weekly cron and a declared exception
  assert.deepEqual(await run(["17 3 * * 1"]), []);
  assert.deepEqual(await run(["17 3 * * 1", "7 */2 * * *"], [{ cron: "7 */2 * * *", reason: "the watcher of the monitor, outside Cloudflare, every two hours" }]), []);
});

// Federated-Banking/core #19 (2026-10-13) and Codex on kit #149 (2026-10-14): the records pull request (github-actions[bot], GITHUB_TOKEN)
// got a pull_request run that GitHub held (action_required). That is harmless: a held run creates no job check, and the required check on
// the records head comes from the push run of the records branch. What is NOT harmless is a path filter on the required check: a
// pull_request run skipped by `paths-ignore` leaves the check pending, so an ordinary pull request that changes only release.json or a
// wrangler config could never merge. The class refuses any path filter on the tested workflow's pull_request trigger.
test("a path filter on a pull_request trigger is refused (a skipped required check stays pending); the template, the kit's own workflow and the independent-review template carry none", async (t) => {
  const template = readFileSync(join(KIT, "templates/ci/test.yml"), "utf8");
  const own = readFileSync(join(KIT, ".github/workflows/test.yml"), "utf8");
  for (const [file, text] of [["templates/ci/test.yml", template], [".github/workflows/test.yml", own], ["templates/ci/independent-review.yml", readFileSync(join(KIT, "templates/ci/independent-review.yml"), "utf8")]]) {
    const pr = parseYaml(text).on.pull_request;
    assert.equal(pr["paths-ignore"], undefined, `${file}: paths-ignore`);
    assert.equal(pr.paths, undefined, `${file}: paths`);
  }
  // must fail: paths-ignore (the records list, another list), paths
  const list = "[release.json, 'wrangler*.toml']";
  for (const [why, text] of [
    ["paths-ignore of the records files", template.replace("    types: [opened,", `    paths-ignore: ${list}\n    types: [opened,`)],
    ["paths-ignore of other files", template.replace("    types: [opened,", "    paths-ignore: [docs/**]\n    types: [opened,")],
    ["paths", template.replace("    types: [opened,", "    paths: ['src/**']\n    types: [opened,")],
  ]) {
    assert.notEqual(text, template, why);
    const found = await budget(repo(t, { "kit.canon.json": canon(), ".github/workflows/test.yml": text }));
    assert.ok(found.some((f) => f.match === "/on/pull_request" || f.match.startsWith("/on/pull_request/")), `${why}: not refused, got ${JSON.stringify(found)}`);
  }
  // must pass: the template as it is
  assert.deepEqual(await budget(repo(t, { "kit.canon.json": canon(), ".github/workflows/test.yml": template })), []);
});

test("the records pull request's constants are one source: the step asks `kit release records`, and the template, the tested workflow and the step agree", async (t) => {
  const { recordsConstants, recordsBranch, recordsPathspecs, recordsArtifactPaths } = await import("../src/release/records.js");
  const c = recordsConstants(KIT);
  assert.equal(c.branch_prefix, "resilience-records/");
  assert.equal(recordsBranch(c, { GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "2" }), "resilience-records/9-2");
  assert.throws(() => recordsBranch(c, {}), /GITHUB_RUN_ID/);
  assert.deepEqual(recordsPathspecs(c), c.paths.map((p) => `:(glob)${p}`));
  assert.deepEqual(recordsArtifactPaths(c).slice(0, c.paths.length), c.paths);
  // kit.canon.json overrides each constant; a site with its own set gets it from the one command
  const site = repo(t, { "kit.canon.json": JSON.stringify({ workflows: { ci: { records: { branch_prefix: "ops/", paths: ["ops/**"], workflow: "ci", check: "ci (x)" } } } }) });
  assert.deepEqual(recordsConstants(site), { branch_prefix: "ops/", paths: ["ops/**"], workflow: "ci", check: "ci (x)" });
  // the production template writes none of them: what the step commits = the artifact it uploads, both from `kit release records paths`
  const production = readFileSync(join(KIT, "templates/ci/production.yml"), "utf8");
  const records = parseYaml(production).jobs.records.steps.map((s) => s.run || "").join("\n");
  for (const need of ["release records branch", "release records paths"]) assert.ok(records.includes(need), need);
  assert.ok(!records.includes("gh workflow run"), "no dispatched run: it does not satisfy a ruleset's required status check");
  assert.match(production, /ssh-key: \$\{\{ secrets\.RECORDS_DEPLOY_KEY \}\}/, "the records branch is pushed with the write deploy key");
  for (const lit of [c.branch_prefix, "release.json", "wrangler", "test.yml"]) assert.ok(!records.includes(lit), `the records step writes ${lit} itself`);
  assert.ok(production.includes("release records paths --artifact"), "the artifact paths come from the one list");
  assert.ok(!/path: \|/.test(production), "no literal artifact path list");
  const template = parseYaml(readFileSync(join(KIT, "templates/ci/test.yml"), "utf8"));
  assert.equal(template.name, c.workflow, "the workflow that runs on the records branch is the tested one");
  assert.ok(template.on.push.branches.includes(`${c.branch_prefix}**`), "the push of the records branch runs it");
  assert.ok(Object.values(template.jobs).some((j) => j.name === c.check), "a job reports the required check");
  // the class reads the templates too: the template as written passes, a template that disagrees is refused
  for (const [why, text, what] of [
    ["a literal records list in the step", production.replace('git ls-files -m -o -d --exclude-standard -z -- "${paths[@]}" | xargs -0 -r git add -A --', "git add -A -- release.json release"), "/jobs/records/steps/"],
    ["a dispatched run replaces the push", production.replace('git push origin', 'gh workflow run test --ref "${branch}"\n          git push origin'), "/jobs/records/steps/"],
    ["the old prefix written again", production.replace('branch="$(node scripts/kit.mjs release records branch)"', 'branch="release-records/${GITHUB_RUN_ID}-1"'), "/jobs/records/steps/"],
  ]) {
    const found = await budget(repo(t, { "kit.canon.json": canon(), "templates/ci/production.yml": text }));
    assert.ok(found.some((f) => f.match.startsWith(what)), `${why}: not refused ${JSON.stringify(found)}`);
  }
  assert.deepEqual(await budget(repo(t, { "kit.canon.json": canon(), "templates/ci/production.yml": production, "templates/ci/test.yml": readFileSync(join(KIT, "templates/ci/test.yml"), "utf8") })), []);
});
