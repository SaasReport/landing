// kit ci unstarted (kit.ci-rerun-verdict.v1): a run whose failed jobs never started is re-run once; anything else stays red.
// The must-fail fixture is the real record: kit run 37655486482 attempt 1 (#123 at 2509241), both jobs with no step, during
// GitHub's outage of 2026-10-07 16:52-17:01 UTC; attempt 2 ran all nine steps green.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unstartedVerdict } from "../src/ci.js";
import { bundled } from "../src/bundled.js";
import { main } from "../src/index.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const real = JSON.parse(readFileSync(new URL("./fixtures/ci-jobs-unstarted-2026-10-07.json", import.meta.url), "utf8"));
const kit = bundled();
const valid = (v) => assert.deepEqual(kit.validator.validate(v, kit.byName("ci-rerun-verdict")), []);
const job = (name, conclusion, steps) => ({ name, conclusion, steps });
const step = (status, conclusion) => ({ name: "s", status, conclusion });

test("the real unstarted run is re-run once, and never twice", () => {
  const v = unstartedVerdict(real, 1);
  valid(v);
  assert.equal(v.rerun, true); assert.equal(v.reason, "unstarted");
  assert.deepEqual(v.failed_jobs.map((j) => j.steps_started), [0, 0]);
  const again = unstartedVerdict(real, 2);
  valid(again);
  assert.equal(again.rerun, false); assert.equal(again.reason, "already_rerun");
});

test("a failed job that ran a step is the repository's failure: never re-run, even beside an unstarted one", () => {
  const ran = { jobs: [job("test (a)", "failure", [step("completed", "success"), step("completed", "failure")])] };
  assert.equal(unstartedVerdict(ran, 1).reason, "a_failed_job_ran_steps");
  const mixed = { jobs: [job("a", "failure", []), job("b", "failure", [step("completed", "failure")])] };
  assert.equal(unstartedVerdict(mixed, 1).rerun, false);
  const skippedOnly = { jobs: [job("a", "failure", [step("completed", "skipped")])] };
  assert.equal(unstartedVerdict(skippedOnly, 1).rerun, true, "a skipped step did not run");
  assert.equal(unstartedVerdict({ jobs: [job("a", "success", [step("completed", "success")])] }, 1).reason, "no_failed_job");
});

test("missing evidence is an error, never 'never started': a job without steps, or fewer jobs than the run has (#122 delta review)", () => {
  assert.throws(() => unstartedVerdict({ jobs: [{ name: "x", conclusion: "failure" }] }, 1), /steps/);
  assert.throws(() => unstartedVerdict({ jobs: [{ name: "x", conclusion: "failure", steps: null }] }, 1), /steps/);
  assert.throws(() => unstartedVerdict({ total_count: 31, jobs: real.jobs }, 1), /31 jobs/);
});

test("the workflow fetches every job of the attempt and re-runs only on the verdict", () => {
  const wf = readFileSync(new URL("../../../.github/workflows/rerun-unstarted.yml", import.meta.url), "utf8");
  assert.match(wf, /attempts\/\$ATTEMPT\/jobs\?per_page=100/);
  assert.match(wf, /permissions:\n  actions: write\n  contents: read\n/);
});

test("a document that is not a jobs document, or a bad attempt, is an error: never a re-run, never a pass", async (t) => {
  assert.throws(() => unstartedVerdict({ message: "Not Found" }, 1), /not a jobs document/);
  assert.throws(() => unstartedVerdict(real, 0), /positive integer/);
  const dir = tempDir(t, "kit-ci-");
  writeFileSync(join(dir, "jobs.json"), "{ not json");
  const err = [];
  const code = await main(["ci", "unstarted", "--jobs", "jobs.json", "--attempt", "1"], { cwd: dir, out: () => {}, err: (l) => err.push(l) });
  assert.notEqual(code, 0, "an unreadable jobs document must fail");
});

test("kit ci unstarted writes the verdict and says why", async (t) => {
  const dir = tempDir(t, "kit-ci-");
  writeFileSync(join(dir, "jobs.json"), JSON.stringify(real));
  const out = [];
  const code = await main(["ci", "unstarted", "--jobs", "jobs.json", "--attempt", "1", "--out", "v.json"], { cwd: dir, out: (l) => out.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /Re-running attempt 1 once: no failed job ever started/);
  assert.equal(JSON.parse(readFileSync(join(dir, "v.json"), "utf8")).rerun, true);
});

// kit ci hold (kit.ci-hold-verdict.v1): a scheduled run whose cause is unchanged is held. 2026-10-27: one deployer re-ran and re-alerted a
// failing commit 32 times in a day, a watcher failed eight ticks with no new cause, four scheduled workflows of one site failed every tick
// for months, and three repositories wrote three holds. The fixture is the shape the runs API returns, newest first.
import { holdVerdict } from "../src/ci.js";
import { parse as parseYaml } from "yaml";

const HEAD = "a".repeat(40), OLD = "b".repeat(40);
const run = (id, head_sha, conclusion, extra = {}) => ({ id, head_sha, status: "completed", conclusion, run_attempt: 1, html_url: `https://example.test/runs/${id}`, event: "schedule", ...extra });
const hold = (runs, o = {}) => holdVerdict({ workflow_runs: runs }, { sha: HEAD, event: "schedule", runId: 100, ...o });
const validHold = (v) => assert.deepEqual(kit.validator.validate(v, kit.byName("ci-hold-verdict")), []);

test("MUST FAIL: the newest decided run at the same head failed: held, with that run on record; a success releases; main moved releases", () => {
  const held = hold([run(100, HEAD, null, { status: "in_progress", conclusion: null }), run(99, HEAD, "failure"), run(98, HEAD, "success")]);
  validHold(held);
  assert.equal(held.held, true); assert.equal(held.reason, "prior_failed"); assert.equal(held.record.id, 99);
  const released = hold([run(99, HEAD, "success"), run(98, HEAD, "failure")]);
  validHold(released);
  assert.equal(released.held, false); assert.equal(released.reason, "prior_succeeded"); assert.equal(released.record.id, 99);
  const moved = hold([run(99, OLD, "failure"), run(98, OLD, "failure")]);
  validHold(moved);
  assert.equal(moved.held, false); assert.equal(moved.reason, "no_prior_run_at_head"); assert.equal(moved.record, null);
  for (const c of ["timed_out", "startup_failure"]) assert.equal(hold([run(99, HEAD, c)]).held, true, c);
});

test("a held run is cancelled and never decides: the hold reads through it to the failure it repeated, and never launders it", () => {
  const v = hold([run(99, HEAD, "cancelled"), run(98, HEAD, "cancelled"), run(97, HEAD, "failure")]);
  assert.equal(v.held, true); assert.equal(v.record.id, 97);
  const only = hold([run(99, HEAD, "cancelled"), run(98, HEAD, "skipped")]);
  assert.equal(only.held, false); assert.equal(only.reason, "no_decided_run_at_head", "a cancelled run alone is no record: the work runs");
  const inconclusive = hold([run(99, HEAD, "neutral")]);
  assert.equal(inconclusive.held, false); assert.equal(inconclusive.reason, "prior_inconclusive");
});

test("only a scheduled run is held: a push, a dispatch or a workflow_run always runs the work; this run never reads itself; the window is bounded", () => {
  for (const event of ["push", "workflow_dispatch", "workflow_run", "pull_request"]) {
    const v = hold([run(99, HEAD, "failure")], { event });
    validHold(v);
    assert.equal(v.held, false); assert.equal(v.reason, "not_scheduled");
  }
  assert.equal(hold([run(100, HEAD, "failure")]).reason, "no_prior_run_at_head", "the current run id is never its own record");
  const far = [run(100, HEAD, null, { status: "in_progress", conclusion: null }), ...Array.from({ length: 30 }, (_, i) => run(90 - i, OLD, "success")), run(50, HEAD, "failure")];
  assert.equal(hold(far).reason, "no_prior_run_at_head", "a failure beyond the window is not read");
  assert.equal(hold(far, { max: 40 }).held, true);
});

test("a document that is not a runs document, a bad sha, event or run id is an error: never a hold, never a pass", async (t) => {
  assert.throws(() => holdVerdict({ message: "Not Found" }, { sha: HEAD, event: "schedule", runId: 1 }), /not a runs document/);
  assert.throws(() => hold([], { sha: "main" }), /40-hex/);
  assert.throws(() => hold([], { event: "" }), /event name/);
  assert.throws(() => hold([], { runId: 0 }), /positive integer/);
  const dir = tempDir(t, "kit-ci-");
  writeFileSync(join(dir, "runs.json"), "{ not json");
  const err = [];
  const code = await main(["ci", "hold", "--runs", "runs.json", "--sha", HEAD, "--event", "schedule", "--run-id", "100"], { cwd: dir, out: () => {}, err: (l) => err.push(l) });
  assert.notEqual(code, 0, "an unreadable runs document must fail");
});

test("kit ci hold writes the verdict and says why, in both directions", async (t) => {
  const dir = tempDir(t, "kit-ci-");
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: [run(99, HEAD, "failure")] }));
  const out = [];
  const code = await main(["ci", "hold", "--runs", "runs.json", "--sha", HEAD, "--event", "schedule", "--run-id", "100", "--out", "v.json"], { cwd: dir, out: (l) => out.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /HELD: the newest decided run at aaaaaaaaaaaa failed, run 99 \(failure, https:\/\/example\.test\/runs\/99\)/);
  assert.equal(JSON.parse(readFileSync(join(dir, "v.json"), "utf8")).held, true);
  const out2 = [];
  await main(["ci", "hold", "--runs", "runs.json", "--sha", HEAD, "--event", "push", "--run-id", "100"], { cwd: dir, out: (l) => out2.push(l), err: () => {} });
  assert.match(out2.join("\n"), /Not held \(not scheduled\)/);
});

test("the scheduled-hold template is a reusable workflow with one job: job token only, actions write, the verdict from this workflow's runs, a held run cancelled and never ended green", () => {
  const text = readFileSync(new URL("../../../templates/ci/scheduled-hold.yml", import.meta.url), "utf8");
  const wf = parseYaml(text);
  assert.deepEqual(Object.keys(wf.on), ["workflow_call"]);
  assert.equal(wf.on.workflow_call.outputs.held.value, "${{ jobs.hold.outputs.held }}");
  assert.deepEqual(Object.keys(wf.jobs), ["hold"]);
  const job = wf.jobs.hold;
  assert.deepEqual(job.permissions, { actions: "write", contents: "read" });
  assert.equal(job.outputs.held, "${{ steps.verdict.outputs.held }}");
  const verdict = job.steps.find((s) => s.id === "verdict");
  assert.match(verdict.run, /actions\/workflows\/\$wf\/runs\?branch=\$BRANCH&per_page=25/);
  assert.match(verdict.run, /node scripts\/kit\.mjs ci hold --runs runs\.json --sha "\$SHA" --event "\$EVENT" --run-id "\$RUN_ID"/, "the kit at its head, through the site's bootstrap");
  assert.equal(verdict.env.GH_TOKEN, "${{ github.token }}", "the job token, no new secret");
  assert.deepEqual([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]), [], "no secret: the kit reaches the hold as its published archive, fetched by the bootstrap with no credential");
  assert.equal(wf.on.workflow_call.secrets, undefined);
  const cancel = job.steps.find((s) => /cancel/.test(s.name ?? ""));
  assert.equal(cancel.if, "steps.verdict.outputs.held == 'true'");
  assert.match(cancel.run, /actions\/runs\/\$RUN_ID\/cancel/);
  assert.match(cancel.run, /exit 1\s*$/, "a cancel that does not land is an error, never a green end");
  const toolchain = JSON.parse(readFileSync(new URL("../../core/registry/toolchain.json", import.meta.url), "utf8"));
  assert.equal(job.steps.find((s) => /setup-node/.test(s.uses ?? "")).with["node-version"], toolchain.tools.node.exact);
});
