/**
 * kit ci unstarted: a CI run whose failed jobs never started (no runner was assigned, so no step ran) failed because the CI
 * provider was down, not because of the repository (kit #123 at 2509241: both jobs "not started because it repeatedly failed
 * to be acquired" during GitHub's outage of 2026-10-07 16:52-17:01 UTC). Such a run is re-run once, on the record; a run any
 * of whose failed jobs ran a step is the repository's failure and stays red, and a run already re-run is never re-run again.
 * The verdict is kit.ci-rerun-verdict.v1.
 */
const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

/** How many of a job's steps started (a step queued but never run, or skipped, did not start). */
const stepsStarted = (job) => {
  if (!Array.isArray(job.steps)) throw new Error(`job "${job.name}" carries no steps: whether it started cannot be read, so it is not re-run`);
  return job.steps.filter((s) => s.status === "in_progress" || (s.status === "completed" && s.conclusion !== "skipped")).length;
};

/**
 * The verdict for one attempt of a run, from the GitHub REST document of its jobs ({ jobs: [...] }). Throws on a document
 * that is not one, so the caller fails loudly instead of re-running or passing on a guess.
 */
export function unstartedVerdict(doc, attempt) {
  if (!doc || !Array.isArray(doc.jobs)) throw new Error("not a jobs document: expected { jobs: [...] } from the GitHub REST API");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`run attempt must be a positive integer (got ${attempt})`);
  if (Number.isInteger(doc.total_count) && doc.jobs.length < doc.total_count) throw new Error(`the run has ${doc.total_count} jobs and the document holds ${doc.jobs.length}: a job not read could have run steps, so nothing is decided`);
  const failed = doc.jobs.filter((j) => FAILED.has(j.conclusion)).map((j) => ({ name: String(j.name), conclusion: j.conclusion, steps_started: stepsStarted(j) }));
  const verdict = (rerun, reason) => ({ schema: "kit.ci-rerun-verdict.v1", run_attempt: attempt, rerun, reason, failed_jobs: failed });
  if (!failed.length) return verdict(false, "no_failed_job");
  if (failed.some((j) => j.steps_started > 0)) return verdict(false, "a_failed_job_ran_steps");
  if (attempt > 1) return verdict(false, "already_rerun");
  return verdict(true, "unstarted");
}

/**
 * kit ci hold: a scheduled run whose cause is unchanged is held, not failed again every tick. On 2026-10-27 one deployer re-ran and
 * re-alerted one failing commit 32 times in a day, a watcher failed eight ticks with no new cause, four scheduled workflows of one site
 * had failed every tick for months, and three repositories each wrote their own hold. The verdict is kit.ci-hold-verdict.v1.
 *
 * The document is the GitHub REST list of THIS workflow's runs on the branch ({ workflow_runs: [...] }, newest first). Only a scheduled
 * run can be held. The decision reads the newest completed run at the same head_sha that is not this run and was decided: a held run is
 * cancelled (templates/ci/scheduled-hold.yml), and a cancelled or skipped run never decides, so a hold never launders the failure it
 * repeats. That run failed: held, and the record is that run. It succeeded, or none exists at this head (main moved, or a first tick):
 * not held, the work runs and fails once more on its own.
 */
const SHA = /^[0-9a-f]{40}$/;
export function holdVerdict(doc, { sha, event, runId, max = 25 } = {}) {
  if (!doc || !Array.isArray(doc.workflow_runs)) throw new Error("not a runs document: expected { workflow_runs: [...] } from the GitHub REST API");
  if (!SHA.test(String(sha))) throw new Error(`the head sha must be a 40-hex commit (got ${JSON.stringify(sha)})`);
  if (typeof event !== "string" || !event) throw new Error("the event name is required (github.event_name)");
  if (!Number.isInteger(runId) || runId < 1) throw new Error(`the run id must be a positive integer (got ${runId})`);
  const verdict = (held, reason, record = null) => ({ schema: "kit.ci-hold-verdict.v1", head_sha: sha, event, run_id: runId, held, reason, record });
  if (event !== "schedule") return verdict(false, "not_scheduled");
  const prior = doc.workflow_runs.slice(0, max).filter((r) => r && r.id !== runId && r.head_sha === sha && r.status === "completed");
  const decided = prior.find((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped");
  if (!decided) return verdict(false, prior.length ? "no_decided_run_at_head" : "no_prior_run_at_head");
  const record = { id: decided.id, html_url: String(decided.html_url ?? ""), conclusion: String(decided.conclusion), run_attempt: Number.isInteger(decided.run_attempt) ? decided.run_attempt : 1 };
  if (decided.conclusion === "success") return verdict(false, "prior_succeeded", record);
  if (FAILED.has(decided.conclusion)) return verdict(true, "prior_failed", record);
  return verdict(false, "prior_inconclusive", record);
}
