/**
 * The environment every git call of the kit runs in: the caller's, less the variables that point git at a repository other
 * than the one asked about. Git exports GIT_DIR, GIT_INDEX_FILE and the rest to every hook it runs, so inside a pre-push hook
 * `git -C <dir>` reads the pushing repository, not <dir> (2026-10-07: the stray-gitlink case read kit's own index and lost
 * its gitlinks, and a test's `git init` in a temp directory would have re-initialised the real repository). The list is
 * git's own (git rev-parse --local-env-vars), never written here. Finding class git-env-inherited refuses a git call without
 * env: gitEnv().
 */
import { execFileSync } from "node:child_process";

let local = null;

/**
 * git's own list of repository-local environment variables. With no git installed there is no git to mislead: the empty
 * list, and the caller's own git call fails as it did before (ENOENT). Any other failure is an error.
 */
export function localEnvVars() {
  if (local) return local;
  try { local = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean); }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`git rev-parse --local-env-vars failed: ${String(e.stderr || e.message).trim()}`); local = []; }
  return local;
}

/**
 * The repository-local variables a caller may keep (gitEnv's `keep`): the index of the commit in progress, which a git hook is handed and which the decision
 * daemon must read to see what is staged. Nothing that names a repository or a work tree (GIT_DIR, GIT_WORK_TREE, ...) is keepable: that is the leak itself.
 */
export const KEEPABLE = ["GIT_INDEX_FILE"];

/**
 * env without git's repository-local variables (GIT_CONFIG_COUNT's numbered GIT_CONFIG_KEY_n/VALUE_n go with it).
 * `{ keep: ["GIT_INDEX_FILE"] }` lets that one variable stay, with the value `env` has: every name is validated, so the list cannot reopen the leak generally: a name
 * must be one of git's own repository-local variables (git rev-parse --local-env-vars) AND in KEEPABLE, else this throws. Finding class git-env-inherited accepts
 * the call only when `keep` is written as a literal array of exactly that one name.
 */
export function gitEnv(env = process.env, { keep = [] } = {}) {
  if (!Array.isArray(keep) || keep.some((k) => typeof k !== "string")) throw new TypeError("gitEnv: keep must be an array of names");
  const vars = localEnvVars();
  for (const k of keep) {
    if (vars.length && !vars.includes(k)) throw new TypeError(`gitEnv: "${k}" is not one of git's repository-local variables, so there is nothing to keep`);
    if (!KEEPABLE.includes(k)) throw new TypeError(`gitEnv: "${k}" may not be kept (only ${KEEPABLE.join(", ")}): it would point git at another repository`);
  }
  const out = { ...env };
  for (const k of vars) if (!keep.includes(k)) delete out[k];
  if (vars.includes("GIT_CONFIG_COUNT")) for (const k of Object.keys(out)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete out[k];
  return out;
}
