/**
 * The reviewed ledger of kit-shipped migrations excused from the comment rule (packages/core/registry/legacy-migration-comments.json,
 * kit.legacy-migration-comments.v1): each entry is { path, reason, reviewed } under the sha256 of the exact bytes it excuses (constitution §9: one
 * reviewed instance with its reason, never a silent baseline). Two proofs, in the kit's own tree only (a site holds a vendored copy of the file and
 * none of the migrations it names):
 *   - every hash matches the file at its path (an entry for a file that changed or went is stale and fails);
 *   - the list only shrinks: no hash that the base ref (origin/main) does not already hold. Where the base ref cannot be resolved (a clone without
 *     it) the second proof cannot run: under CI (CI or GITHUB_ACTIONS set) that is a finding, never a skip; locally it is an explicit note, never silence.
 *     The base ref is the ledger's own `base` field (registry/legacy-migration-comments.json), not a literal here. A base that holds no ledger yet is the
 *     change that introduces it: a note, and every entry is then the base list.
 *
 *   legacyLedger(root, { env })        → { problems: [{ file, problem }], notes: [string] }
 *   legacyLedgerProblems(root, opts)   → the problems only
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "./git.js";

export const LEDGER_PATH = "packages/core/registry/legacy-migration-comments.json";

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() });
const ok = (root, args) => { try { git(root, args); return true; } catch { return false; /* a git probe (rev-parse, cat-file): a non-zero exit IS its answer "no", and the caller turns it into a finding or a note */ } };

export function legacyLedger(root, { env = process.env } = {}) {
  const file = join(root, LEDGER_PATH);
  if (!existsSync(file)) return { problems: [], notes: [] };
  const P = (problem) => ({ file: LEDGER_PATH, problem });
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { problems: [P(`not JSON: ${e.message}`)], notes: [] }; }
  const problems = [], notes = [], base = doc.base;
  for (const [hash, e] of Object.entries(doc.files || {})) {
    const at = join(root, e?.path || "");
    if (!e?.path || !existsSync(at)) { problems.push(P(`entry ${hash.slice(0, 12)} names ${e?.path ?? "no path"}, which is not in the tree: remove the entry (the list only shrinks)`)); continue; }
    if (createHash("sha256").update(readFileSync(at)).digest("hex") !== hash) problems.push(P(`entry ${hash.slice(0, 12)} does not match ${e.path} (the file changed; an applied migration is never edited): remove the entry or restore the file`));
  }
  if (typeof base !== "string" || !base) { problems.push(P("the ledger names no base ref (`base`): the shrink-only proof has nothing to compare against")); return { problems, notes }; }
  if (!ok(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])) {
    const why = `the base ref ${base} cannot be resolved here (a clone without it): the shrink-only proof of the legacy ledger cannot run`;
    if (env.CI || env.GITHUB_ACTIONS) problems.push(P(`${why}; fetch it (actions/checkout with fetch-depth: 0), a CI run never skips this proof`));
    else notes.push(`${why} (skipped here, NOT proven; CI refuses to skip it)`);
    return { problems, notes };
  }
  if (!ok(root, ["cat-file", "-e", `${base}:${LEDGER_PATH}`])) { notes.push(`${base} holds no legacy ledger yet: this change introduces it, so its entries are the base list`); return { problems, notes }; }
  let before;
  try { before = JSON.parse(git(root, ["show", `${base}:${LEDGER_PATH}`])); } catch (e) { problems.push(P(`the ledger at ${base} cannot be read (${String(e.message).split("\n")[0]}): the shrink-only proof cannot run`)); return { problems, notes }; }
  for (const [hash, e] of Object.entries(doc.files || {})) if (!(hash in (before.files || {}))) problems.push(P(`entry ${hash.slice(0, 12)} (${e?.path}) is not in ${base}'s ledger: the list only shrinks, a new or changed migration obeys the comment rule instead`));
  return { problems, notes };
}

export const legacyLedgerProblems = (root, opts) => legacyLedger(root, opts).problems;
