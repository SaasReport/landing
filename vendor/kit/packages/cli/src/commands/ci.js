/**
 * kit ci unstarted --jobs <jobs.json> --attempt <n> [--out <verdict.json>]
 *     whether a failed CI run is re-run once because none of its failed jobs ever started (src/ci.js,
 *     kit.ci-rerun-verdict.v1). Prints one line for the run summary; writes the verdict to --out. A jobs document that cannot
 *     be read is an error (exit 1), never a re-run and never a pass.
 * kit ci hold --runs <runs.json> --sha <head sha> --event <event> --run-id <id> [--out <verdict.json>]
 *     whether a scheduled run is held because the newest decided run of this workflow at the same head failed (src/ci.js,
 *     kit.ci-hold-verdict.v1; templates/ci/scheduled-hold.yml cancels a held run). Prints one line for the run summary; writes the
 *     verdict to --out. A runs document that cannot be read is an error (exit 1), never a hold and never a pass.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CliError, onlyFlags } from "../args.js";
import { holdVerdict, unstartedVerdict } from "../ci.js";
import { bundled } from "../bundled.js";
import { formatProblems } from "@saasreport/core/schema";

const readDoc = (io, file, what) => {
  try { return JSON.parse(readFileSync(resolve(io.cwd, String(file)), "utf8")); } catch (e) { throw new CliError(`cannot read the ${what} document ${file}: ${e.message}`); }
};
const checked = (v, name, title) => {
  const kit = bundled();
  const bad = formatProblems(kit.validator.validate(v, kit.byName(name)));
  if (bad.length) throw new CliError(`the verdict breaks ${title}: ${bad.join("; ")}`);
  return v;
};

export async function ci(io, { _: [sub, ...extra], flags }) {
  if (sub === "hold") return hold(io, { extra, flags });
  if (sub !== "unstarted") throw new CliError(`unknown ci command "${sub ?? ""}" (unstarted --jobs <jobs.json> --attempt <n> | hold --runs <runs.json> --sha <sha> --event <event> --run-id <id>)`);
  onlyFlags(flags, ["jobs", "attempt", "out", "cwd", "config"], "kit ci unstarted");
  if (!flags.jobs || flags.attempt == null || extra.length) throw new CliError("usage: kit ci unstarted --jobs <jobs.json> --attempt <n> [--out <verdict.json>]");
  const doc = readDoc(io, flags.jobs, "jobs");
  let v;
  try { v = unstartedVerdict(doc, Number(flags.attempt)); } catch (e) { throw new CliError(e.message); }
  checked(v, "ci-rerun-verdict", "kit.ci-rerun-verdict.v1");
  if (flags.out) writeFileSync(resolve(io.cwd, String(flags.out)), `${JSON.stringify(v, null, 2)}\n`);
  const jobs = v.failed_jobs.map((j) => `${j.name} (${j.conclusion}, ${j.steps_started} step${j.steps_started === 1 ? "" : "s"} started)`).join(", ") || "none";
  io.out(v.rerun
    ? `Re-running attempt ${v.run_attempt} once: no failed job ever started (${jobs}), so the CI provider failed, not the repository.`
    : `Not re-run (${v.reason.replace(/_/g, " ")}): failed jobs ${jobs}.`);
  return 0;
}

async function hold(io, { extra, flags }) {
  onlyFlags(flags, ["runs", "sha", "event", "run-id", "out", "cwd", "config"], "kit ci hold");
  if (!flags.runs || !flags.sha || !flags.event || flags["run-id"] == null || extra.length) throw new CliError("usage: kit ci hold --runs <runs.json> --sha <head sha> --event <event> --run-id <id> [--out <verdict.json>]");
  const doc = readDoc(io, flags.runs, "runs");
  let v;
  try { v = holdVerdict(doc, { sha: String(flags.sha), event: String(flags.event), runId: Number(flags["run-id"]) }); } catch (e) { throw new CliError(e.message); }
  checked(v, "ci-hold-verdict", "kit.ci-hold-verdict.v1");
  if (flags.out) writeFileSync(resolve(io.cwd, String(flags.out)), `${JSON.stringify(v, null, 2)}\n`);
  const rec = v.record ? `run ${v.record.id} (${v.record.conclusion}${v.record.html_url ? `, ${v.record.html_url}` : ""})` : "no run";
  io.out(v.held
    ? `HELD: the newest decided run at ${v.head_sha.slice(0, 12)} failed, ${rec}; the cause is unchanged, so this scheduled run is cancelled, not failed and mailed again. A new commit on the branch, or a person's dispatch, runs the work.`
    : `Not held (${v.reason.replace(/_/g, " ")}): ${rec} at ${v.head_sha.slice(0, 12)}; the work runs.`);
  return 0;
}
