/**
 * `kit release deployer-check <workflow.yml>` (docs/RELEASE.md, central mode): what the kit asks of the central deployer's workflow, proven from
 * the parsed YAML. In central mode `kit release ship` does not read the source repository through the GitHub API: the proof that
 * KIT_RELEASE_SOURCE_SHA is the source's main HEAD is the deployer's, a re-read over SSH with the project's read-only deploy key immediately
 * before ship, by a command that FAILS CLOSED: `kit release head-check` (ls-remote compared with KIT_RELEASE_SOURCE_SHA and the checkout's
 * HEAD, host key pinned), or `deployer.mjs head`, which wraps it. A raw `git ls-remote` line compares nothing (its output can be discarded
 * and the step still pass), so it is a finding. The workflow is held to this shape, per job that runs `kit release ship`:
 *
 *   0. a step "runs" a command by INVOCATION, never by text: its shell is split into commands (lines, `&&`, `;`), leading VAR=value
 *      assignments, a `node`/`npx` launcher and a path prefix are dropped, and the command must START with the program (Codex round 3 on #147:
 *      `echo "kit release head-check"` matched the text and passed as a re-read; a step that unloaded the key and then edited release.json
 *      matched "unload" and was skipped). An intervening unload step consists of unload commands ONLY;
 *   1. a step that runs HEAD_REREAD comes BEFORE ship and, in between, only steps that unload the key (KEY_UNLOAD) may run: nothing that runs
 *      the source's code (npm ci, the vendored kit, a build, a test) sits between the re-read and ship;
 *   2. a step that loads the deploy key (KEY_LOAD) is in the same job before the re-read, and the re-read is not a GitHub API call;
 *      a `kit release head-check` step carries the identity env and the pinned-host GIT_SSH_COMMAND;
 *   2b. the re-read step's outcome can fail the job: no continue-on-error, no `if` but none or an always-true one (true, ${{ true }}, success(),
 *      always()), no shell masking of its exit status (|| true, || :, || exit 0, set +e, a pipe without pipefail, a trailing `; cmd`, a
 *      background &), and the re-read is the LAST command of the step (the status of a step is its last command's);
 *   3. the ship step passes KIT_RELEASE_ENVIRONMENT, KIT_RELEASE_SOURCE_REPOSITORY and KIT_RELEASE_SOURCE_SHA (IDENTITY_ENV, the one list),
 *      and no credential that reads the source repository: a SOURCE_, GH_APP_ or GITHUB_APP_ prefix, a _PAT suffix, or a GH/GITHUB token other than the
 *      deployer's own GH_TOKEN/GITHUB_TOKEN. Names the project declares (requiredSecrets: MONITOR_TOKEN, a Telegram bot token) are Worker
 *      secrets and pass, whatever their suffix.
 *
 * → [{ job, step, problem }]; empty when the workflow holds the shape. Deterministic, no network.
 */
import { parseYaml } from "../yaml-lite.js";
import { IDENTITY_ENV } from "./config.js";

/** The commands of a step's shell, in order: comment lines dropped, each line split at `&&` and `;` (`||`, a pipe and `&` are masks, read by maskProblems). */
export function commandsOf(run) {
  return String(run ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .flatMap((l) => l.split(/\s*(?:&&|;)\s*/)).map((c) => c.trim()).filter(Boolean);
}
/** What a command invokes: leading VAR=value assignments, a `node`/`npx` launcher and the program's path prefix dropped ("kit.js release ship ..."). */
export const invocationOf = (cmd) => String(cmd).replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(/^(?:node|npx)\s+/, "").replace(/^\S*\//, "");
/** Does any command of the step invoke `re` (anchored at the program), and does its last command? */
export const invokes = (step, re) => commandsOf(step?.run).some((c) => re.test(invocationOf(c)));
const lastInvokes = (step, re) => { const c = commandsOf(step?.run); return c.length > 0 && re.test(invocationOf(c[c.length - 1])); };
const every = (step, re) => { const c = commandsOf(step?.run); return c.length > 0 && c.every((x) => re.test(invocationOf(x))); };

export const SHIP_STEP = /^kit(?:\.m?js)?\s+release\s+ship(?:\s|$)/;   // kit.js: a vendored snapshot or the kit itself; kit.mjs: the bootstrap of a site at t=0 (docs/FRESHNESS.md)
export const KIT_HEAD_CHECK = /^kit(?:\.m?js)?\s+release\s+head-check(?:\s|$)/;
export const HEAD_REREAD = new RegExp(`${KIT_HEAD_CHECK.source}|^deployer\\.mjs\\s+head(?:\\s|$)`);
/** The masks of an exit status in a step's shell: [pattern, name]. */
export const MASKS = [
  [/\|\|\s*(?:true\b|:|exit\s+0\b|echo\b)/, "|| true (or || :, || exit 0, || echo): the failure is turned into success"],
  [/\bset\s+\+[a-z]*e/, "set +e: the shell goes on after a failing command"],
  [/;\s*(?:true|:|exit\s+0)\s*$/m, "a trailing ; true (or ; :, ; exit 0)"],
  [/(?:^|[^&|])&\s*$/m, "a background & (the step does not wait for the command's status)"],
];
const TRIVIAL_IF = /^\s*(?:\$\{\{\s*)?(?:true|success\(\)|always\(\))(?:\s*\}\})?\s*$/;
/** Why this re-read step's outcome cannot fail the job (or []): [mask description]. */
export function maskProblems(step, reread) {
  const out = [];
  const coe = step?.["continue-on-error"];
  if (coe !== undefined && coe !== false && String(coe).trim() !== "false") out.push("continue-on-error: the job passes whatever the re-read answers");
  if (step?.if !== undefined && !(step.if === true || TRIVIAL_IF.test(String(step.if)))) out.push(`if: ${String(step.if).slice(0, 60)} (the re-read can be skipped, and a skipped step passes)`);
  const run = runOf(step);
  for (const [re, what] of MASKS) if (re.test(run)) out.push(what);
  if (/\|(?!\|)/.test(run.replace(/\|\|/g, "")) && !/\bpipefail\b/.test(run)) out.push("a pipe without set -o pipefail (the step's status is the last command of the pipe)");
  if (!lastInvokes(step, reread)) out.push("another command follows the re-read: the step's status is the last command's");
  return out;
}
export const RAW_LS_REMOTE = /^git\s+ls-remote(?:\s|$)/;
export const KEY_LOAD = /^ssh-add(?:\s|$)|^deployer\.mjs\s+key(?:\s|$)/;
export const KEY_UNLOAD = /^deployer\.mjs\s+unload(?:\s|$)/;
const API_READ = /^gh\s+api(?:\s|$)|^curl(?:\s|$)|api\.github\.com/;
/** Credentials that read the source repository, by name: never a blanket suffix (MONITOR_TOKEN is a Worker secret). */
export const SOURCE_CREDENTIAL = /^(SOURCE_|GH_APP_|GITHUB_APP_)|_PAT$|^(GH|GITHUB)_(?!TOKEN$).*TOKEN$|^(GH|GITHUB)_?(TOKEN|PAT)_.+/i;
const OWN_TOKEN = /^(GH_TOKEN|GITHUB_TOKEN)$/;

const runOf = (s) => String(s?.run ?? "");
const label = (s, i) => s?.name ?? `step ${i + 1}`;

/** `declared`: the secret names the project declares (requiredSecrets): Worker secrets, never source credentials. */
export function deployerWorkflowProblems(text, { declared = [] } = {}) {
  let doc;
  try { doc = parseYaml(text); } catch (e) { return [{ job: "(workflow)", step: "", problem: `cannot be read (${e.message})` }]; }
  const out = [];
  const allowed = new Set(declared);
  const jobs = doc?.jobs && typeof doc.jobs === "object" ? Object.entries(doc.jobs) : [];
  let ships = 0;
  for (const [job, def] of jobs) {
    const steps = Array.isArray(def?.steps) ? def.steps : [];
    steps.forEach((s, i) => {
      if (!invokes(s, SHIP_STEP)) return;
      ships++;
      const P = (problem) => out.push({ job, step: label(s, i), problem });
      // 1. the re-read, then only key unloads (steps whose every command is the unload), then ship
      let j = i - 1;
      while (j >= 0 && every(steps[j], KEY_UNLOAD)) j--;
      if (j < 0 || !invokes(steps[j], HEAD_REREAD)) {
        const between = steps.slice(0, i).findLastIndex((x) => invokes(x, HEAD_REREAD));
        const raw = steps.slice(0, i).findLastIndex((x) => invokes(x, RAW_LS_REMOTE));
        if (between >= 0) P(`ship is not immediately preceded by the re-read of main's HEAD ("${label(steps[between], between)}"): "${label(steps[between + 1], between + 1)}" sits between them (only a step that does nothing but unload the key may)`);
        else if (raw >= 0) P(`"${label(steps[raw], raw)}" is a raw git ls-remote: it compares nothing with KIT_RELEASE_SOURCE_SHA and its output can be discarded while the step passes. Re-read main's HEAD with kit release head-check (or deployer.mjs head, which wraps it) immediately before ship`);
        else P("no step re-reads main's HEAD (`kit release head-check`) before ship: central mode trusts the deployer's re-read, so it must exist");
      } else {
        // 2. the key is loaded before the re-read; the re-read is not an API call; head-check carries identity and the pinned host key
        if (!steps.slice(0, j).some((x) => invokes(x, KEY_LOAD))) P("the deploy key is not loaded (ssh-add or `deployer.mjs key`) before the re-read of main's HEAD");
        for (const m of maskProblems(steps[j], HEAD_REREAD)) out.push({ job, step: label(steps[j], j), problem: `the re-read of main's HEAD cannot fail the job (${m})` });
        if (invokes(steps[j], API_READ)) P("the re-read of main's HEAD goes through the GitHub API: it is `kit release head-check`, an ls-remote over SSH with the read-only deploy key");
        if (invokes(steps[j], KIT_HEAD_CHECK)) {
          const henv = steps[j].env && typeof steps[j].env === "object" ? steps[j].env : {};
          for (const n of [...IDENTITY_ENV.central, "GIT_SSH_COMMAND"]) if (!(n in henv)) out.push({ job, step: label(steps[j], j), problem: `the head-check step does not pass ${n}` });
        }
      }
      // 3. identity env, no source-reading credential
      const env = s.env && typeof s.env === "object" ? s.env : {};
      for (const n of IDENTITY_ENV.central) if (!(n in env)) P(`the ship step does not pass ${n}`);
      for (const k of Object.keys(env)) if (SOURCE_CREDENTIAL.test(k) && !OWN_TOKEN.test(k) && !allowed.has(k)) P(`the ship step passes ${k}: the source repository is never read through a credential in central mode`);
    });
  }
  if (!ships) out.push({ job: "(workflow)", step: "", problem: "no step runs `kit release ship`" });
  return out;
}
