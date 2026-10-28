/**
 * kit persian — the Persian copy workflow (docs/PERSIAN.md).
 *
 *   kit persian fix [--write] [--log changes.json] [files…]   apply the autofix rules (typography: ZWNJ, ی/ک, punctuation)
 *                                                             to the sources; a dry run prints what would change
 *   kit persian review                                       every source file's review state (approved, baseline, changed, new, invalid)
 *   kit persian approve --by <reviewer> --key <pem> [--note n] files…
 *                                                             the native reader signs the current text of the named files with their own Ed25519 key
 *                                                             (an encrypted key, unlocked by a terminal passphrase prompt; no bulk flag, no env var)
 *   kit persian reject|withdraw --by <reviewer> --key <pem> --statement "<why>" files…   the reader's veto (a withdrawal holds the file until they approve again or a majority does)
 *   kit persian migrate                                       the old fa-review.json → the approval ledger, in place; only unchanged entries become baselines
 *   kit persian baseline [--note n]                          create the ledger: files live before the gate, unsigned, anchored at the current commit (once)
 *
 * Checks live under kit check: `kit check persian` (lint, part of kit check canon) and `kit check fa-review` (the deploy gate).
 * The ledger is the kit's one approval ledger (kit.approval-ledger.v1): append-only, hash-chained, signed (docs/CONCEPTS.md section 5).
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { baselineHash } from "@saasreport/core/ledger";
import { witnessOf } from "./ledger.js";
import { join } from "node:path";
import { CliError } from "../args.js";
import { loadCanon } from "../canon/index.js";
import { kitFor } from "../bundled.js";
import { loadPersian, fixSources, readLedger, reviewState, baselineCandidates, persianExpect, verifyPersian, scopeProblems } from "../canon/persian.js";
import { createLedger, writeLedgerFile, loadApproverKey, appendChecked, assertSigner } from "../ledger-io.js";

function setup(io) {
  const kit = kitFor(io);
  const { canon, problems } = loadCanon(io.cwd, kit);
  if (!canon) throw new CliError(problems.map((p) => p.problem).join("; "));
  const p = loadPersian(io.cwd, canon, kit);
  if (!p.cfg) throw new CliError(p.problems.length ? p.problems.map((x) => `${x.file}: ${x.problem}`).join("; ") : "kit.canon.json declares no \"persian\" (docs/PERSIAN.md)");
  if (p.problems.length) throw new CliError(p.problems.map((x) => `${x.file}: ${x.problem}`).join("; "));
  return { kit, canon, ...p };
}

/** A baseline counts as approved copy, so it is the OWNER's: only the set the owner-signed trust record pins (file and hash, every one) and only at its anchor. */
function pinProblem(expect, baselines, cfg) {
  const sp = scopeProblems(cfg, expect);
  if (sp.length) throw new CliError(sp[0].problem);
  const pin = expect.baseline;
  if (!pin) throw new CliError("the owner-signed trust record pins no baseline: a baseline counts as approved copy that the owner never signed, so only a baseline the owner pinned (kit trust propose computes it from the sources the owner has read) can be created");
  if (!expect.anchor) throw new CliError("the owner-signed trust record has no anchor for the baseline");
  const got = baselineHash(baselines);
  if (pin.entries !== baselines.length || pin.sha256 !== got) throw new CliError(`the baseline this tree would produce (${baselines.length} files, ${got.slice(0, 12)}) is not the one the owner pinned (${pin.entries} files, ${pin.sha256.slice(0, 12)}): the sources changed since the owner pinned it, or this is not the set the owner read. The owner pins the set again (kit trust propose), or the changed files are signed by the owner one by one`);
}

export async function persian(io, { _: [sub, ...rest], flags }) {
  const s = setup(io);
  if (sub === "fix") {
    const changes = fixSources(io.cwd, s.cfg, s.linter, { write: Boolean(flags.write), files: rest.length ? rest : null });
    const refused = changes.filter((c) => c.refused);
    for (const c of refused) io.err(`refused ${c.file}:${c.line}: ${c.refused}`);
    changes.splice(0, changes.length, ...changes.filter((c) => !c.refused));
    for (const c of changes.slice(0, flags.write ? 0 : 50)) io.out(`${c.file}:${c.line} [${c.rules.join(", ")}]\n  - ${c.before.replace(/\n/g, "⏎")}\n  + ${c.after.replace(/\n/g, "⏎")}`);
    if (flags.log) writeFileSync(join(io.cwd, String(flags.log)), `${JSON.stringify(changes, null, 1)}\n`);
    const files = new Set(changes.map((c) => c.file)).size;
    io.out(`${flags.write ? "fixed" : "would fix"} ${changes.length} segment${changes.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}${flags.write ? "" : " (--write applies)"}${refused.length ? `; refused ${refused.length} (markup would change)` : ""}`);
    return 0;
  }
  if (!s.cfg.review) throw new CliError("persian.config.json has no \"review\"");
  const pe = await persianExpect(s.kit, s.canon);
  if (!pe.expect) throw new CliError(pe.problems.map((p) => p.problem).join("; "));
  const { file, ledger, missing, problems } = readLedger(io.cwd, pe.expect, s.kit);
  if (problems.length) throw new CliError(problems.map((p) => `${p.file}: ${p.problem}`).join("; "));
  const oldFormat = ledger && (ledger.id === undefined || ledger.anchor === undefined);
  if (sub === "migrate") {
    // Converts the old fa-review.json (entries by file, no chain) IN PLACE into the approval ledger, anchored at the current commit. Only entries whose
    // hash still equals the file's current Persian hash become baselines; changed or new copy is NOT absorbed: it stays pending for the reader to sign.
    const old = existsSync(join(io.cwd, file)) ? readFileSync(join(io.cwd, file)) : null;
    if (!old) throw new CliError(`${file} does not exist: nothing to migrate (kit persian baseline creates a new ledger)`);
    let j; try { j = JSON.parse(old.toString("utf8")); } catch { throw new CliError(`${file} is not JSON`); }
    if (!oldFormat && !j.entries?.some((e) => e.file && !e.seq)) throw new CliError(`${file} is already in the approval-ledger format`);
    const sha256 = createHash("sha256").update(old).digest("hex");
    const m = pe.expect.migration;
    if (!m || m.sha256 !== sha256 || m.entries !== (j.entries || []).length) throw new CliError(`the owner-signed trust record does not name this migration (the old ${file} has sha256 ${sha256.slice(0, 12)}, ${(j.entries || []).length} entries; the record names ${m ? `${m.sha256.slice(0, 12)}, ${m.entries} entries` : "none"}): a migration happens once, and only the one the owner signed (kit trust)`);
    const cur = new Map(reviewState(io.cwd, s.cfg, null).map((x) => [x.file, x]));
    const baselines = [], pending = [];
    for (const e of j.entries || []) {
      const c = cur.get(e.file);
      if (["withdrawn", "rejected"].includes(e.status)) pending.push(e.file);   // a vetoed file never becomes a baseline: it stays pending
      else if (c && c.sha256 === e.sha256) baselines.push({ file: e.file, sha256: e.sha256, segments: e.segments, note: e.status === "approved" ? `approved in the old ledger by ${e.by} on ${String(e.at).slice(0, 10)} (unsigned); sign again to renew` : "live before the native-review gate; not an approval" });
      else pending.push(e.file);
    }
    pinProblem(pe.expect, baselines, s.cfg);
    try { writeLedgerFile(io.cwd, file, createLedger(io.cwd, pe.expect, { baselines, migratedFrom: { sha256, entries: (j.entries || []).length } })); } catch (e) { throw new CliError(e.message); }
    io.out(`migrated ${file} in place: ${baselines.length} baseline(s) from ${(j.entries || []).length} old entries, anchored at the current commit, old file hash ${sha256.slice(0, 12)} recorded; ${pending.length} file(s) changed since their last review stay PENDING (not absorbed): ${pending.join(", ") || "none"}`);
    return 0;
  }
  if (oldFormat) throw new CliError(`${file} is in the old format: run kit persian migrate`);
  if (sub === "baseline") {
    // baseline records copy that was live before the gate, once: when the ledger is created. After that a new or changed file is only signed by a reader.
    if (!missing) throw new CliError(`${file} exists: baseline is only for creating the ledger; new or changed files need kit persian approve --by <reviewer> --key <pem>`);
    const states = reviewState(io.cwd, s.cfg, null);
    const baselines = baselineCandidates(states).map((x) => ({ file: x.file, sha256: x.sha256, segments: x.segments, note: flags.note ? String(flags.note) : "live before the native-review gate; not an approval" }));
    pinProblem(pe.expect, baselines, s.cfg);
    try { writeLedgerFile(io.cwd, file, createLedger(io.cwd, pe.expect, { baselines })); } catch (e) { throw new CliError(e.message); }
    io.out(`baseline: ${baselines.length} file${baselines.length === 1 ? "" : "s"} recorded in ${file}, unsigned, anchored at the current commit (changed files stay pending)`);
    return 0;
  }
  if (missing) throw new CliError(`${file} is missing: kit persian baseline (once)`);
  const v = await verifyPersian(ledger, pe.expect);
  const states = reviewState(io.cwd, s.cfg, v);
  if (sub === "review") {
    for (const m of v.problems) io.err(`  - ${file}: ${m}`);
    for (const st of states.filter((x) => x.state !== "empty")) io.out(`${st.state.padEnd(8)} ${st.file}${st.entry ? ` (${st.entry.status}${st.entry.by ? ` by ${st.entry.by}` : ""}, ${st.entry.at.slice(0, 10)})` : ""}`);
    return v.ok ? 0 : 1;
  }
  if (["approve", "reject", "withdraw"].includes(sub)) {
    if (flags.all || flags["all-pending"]) throw new CliError("there is no bulk signing: name each file you have read (kit persian approve --by <name> --key <pem> <file>…)");
    if (!v.ok) throw new CliError(`the ledger does not verify, so nothing is appended to it: ${v.problems.join("; ")}`);
    const by = flags.by && String(flags.by);
    if (!by || !v.roster.some((r) => r.name === by)) throw new CliError(`--by must name a member of the roster (${v.roster.map((r) => r.name).join(", ") || "empty: the owner signs the first roster into the trust record"}); an approval is signed by that person with their own key after reading the text`);
    const status = { approve: "approved", reject: "rejected", withdraw: "withdrawn" }[sub];
    const statement = flags.statement && String(flags.statement);
    if (status !== "approved" && (!statement || statement.length < 10)) throw new CliError("--statement \"<why>\" is required (at least 10 characters) to reject or withdraw");
    const pick = states.filter((x) => rest.includes(x.file));
    const unknown = rest.filter((f) => !states.some((x) => x.file === f));
    if (unknown.length) throw new CliError(`not Persian sources: ${unknown.join(", ")}`);
    if (!pick.length) throw new CliError(`nothing to ${sub}: name the files you have read`);
    try {
      await assertSigner(s.kit, s.canon.project);
      const key = await loadApproverKey(io, flags);
      for (const st of pick) await appendChecked(ledger, v.roster, key, { file: st.file, sha256: st.sha256, status, by, segments: st.segments, ...(statement ? { statement } : {}), ...(flags.note ? { note: String(flags.note) } : {}) }, { expect: pe.expect, bootstrap: pe.expect.bootstrap, witness: witnessOf(flags, io) });
    } catch (e) { throw new CliError(e.message); }
    writeLedgerFile(io.cwd, file, ledger);
    io.out(`${status} ${pick.length} file${pick.length === 1 ? "" : "s"} by ${by}, signed with your key, appended to ${file}`);
    return 0;
  }
  throw new CliError(`kit persian ${sub ?? ""}: one of fix, review, approve, reject, withdraw, baseline, migrate`);
}
