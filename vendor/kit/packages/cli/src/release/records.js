/**
 * The records pull request's constants (docs/RELEASE.md): ONE source for the production workflow's records step, the
 * pull_request trigger of the tested workflow and the canon check. kit.canon.json `workflows.ci.records` (branch_prefix, paths,
 * workflow, check), each defaulting to the value the `ci-run-budget` class declares in its binds (the registry is the one place a
 * default is written). The workflow never carries a literal of them: its steps ask `kit release records <what>`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = new URL("../../../core/registry/finding-classes.json", import.meta.url);
const KEYS = { branch_prefix: "records_branch_prefix", paths: "records_paths", workflow: "records_workflow", check: "records_check" };

/** { branch_prefix, paths, workflow, check } for the repository at root. */
export function recordsConstants(root) {
  const binds = Object.assign({}, ...JSON.parse(readFileSync(REGISTRY, "utf8")).classes.find((c) => c.id === "ci-run-budget").detect.map((d) => d.bind || {}));
  let set = {};
  try { set = JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8"))?.workflows?.ci?.records ?? {}; } catch { /* no kit.canon.json: the defaults */ }
  return Object.fromEntries(Object.entries(KEYS).map(([k, bind]) => [k, set[k] ?? binds[bind].default]));
}

/** The records branch of one run: `<prefix><run id>-<attempt>`. */
export const recordsBranch = (c, env) => {
  if (!env.GITHUB_RUN_ID || !env.GITHUB_RUN_ATTEMPT) throw new Error("GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT name the records branch");
  return `${c.branch_prefix}${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
};

/** git pathspecs (glob magic) of the records files, one per line: what the step commits, never more. */
export const recordsPathspecs = (c) => c.paths.map((p) => `:(glob)${p}`);

/** The same files as an upload-artifact `path` input (a step output, one line each), without what a checkout never holds. */
export const recordsArtifactPaths = (c) => [...c.paths, "!node_modules/**", "!vendor/**"];
