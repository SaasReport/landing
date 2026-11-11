/**
 * kit shariah — the signed approval ledger of a Shariah-sensitive concept series (docs/CONCEPTS.md). The AI does not issue fatwas and never
 * signs off: an approval is signed with the REVIEWER'S OWN Ed25519 key (kit ledger keygen), which no agent holds; the gate and the run
 * time verify it from the public key in the roster alone. A commit email proves nothing and is not used.
 *
 *   kit shariah init                                      create an empty ledger anchored at the current commit (it approves nothing)
 *   kit shariah review                                    every concept: approved, unreviewed, changed since approval, withdrawn, rejected, invalid
 *   kit shariah approve --by <reviewer> --key <pem> --statement "<your words>" <id…>   (an encrypted key, passphrase from the terminal; no bulk flag, no env var)
 *   kit shariah reject|withdraw --by <reviewer> --key <pem> --statement "<why>" <id…>
 *
 * Entries are only ever appended (hash-chained, never re-sorted); the latest entry of a concept wins.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../args.js";
import { kitFor } from "../bundled.js";
import { loadConcepts, CONCEPTS_FILE, reviewTable } from "../concepts.js";
import { createLedger, writeLedgerFile, loadApproverKey, appendChecked, assertSigner } from "../ledger-io.js";
import { ATTESTS } from "@saasreport/core/concepts";
import { witnessOf } from "./ledger.js";

export async function shariah(io, { _: [sub = "review", ...rest], flags }) {
  const kit = kitFor(io), file = flags.concepts ? String(flags.concepts) : CONCEPTS_FILE;
  const c = await loadConcepts(io.cwd, kit, { file });
  if (!c.config || !c.catalogue) throw new CliError(c.problems.map((p) => `${p.file}: ${p.problem}`).join("; "));
  if (c.config.kind !== "shariah" || !c.expect) throw new CliError(`the kit registry does not mark ${c.project}'s concept series as Shariah: it has no Shariah ledger`);
  const ledgerFile = c.expect.ledger;
  if (sub === "init") {
    if (existsSync(join(io.cwd, ledgerFile))) throw new CliError(`${ledgerFile} exists`);
    try { writeLedgerFile(io.cwd, ledgerFile, createLedger(io.cwd, c.expect)); } catch (e) { throw new CliError(e.message); }
    io.out(`created ${ledgerFile}: no entries, anchored at the current commit. It approves nothing, so nothing is scheduled. The owner registers the reviewer(s) PUBLIC keys in the kit project registry (approvals.shariah.roster) and puts the ledger under CODEOWNERS.`);
    return 0;
  }
  if (c.reviewMissing || !c.review) throw new CliError(`${ledgerFile} is missing or invalid: ${c.problems.map((p) => p.problem).join("; ") || "kit shariah init"}`);
  const table = reviewTable(c);
  if (sub === "review") {
    const v = c.approvals;
    for (const m of v.problems) io.err(`  - ${ledgerFile}: ${m}`);
    for (const t of table) io.out(`${t.state.padEnd(10)} ${t.id}${t.contested ? " (contested)" : ""}${t.scheduled ? ` scheduled ${t.scheduled}` : ""}${t.entry ? ` [${t.entry.status} by ${t.entry.by}, ${t.entry.at.slice(0, 10)}]` : ""}`);
    return v.ok ? 0 : 1;
  }
  if (["approve", "reject", "withdraw"].includes(sub)) {
    const by = flags.by && String(flags.by), statement = flags.statement && String(flags.statement);
    if (!by) throw new CliError("--by <reviewer> is required (a name of the roster)");
    if (!statement || statement.length < 10) throw new CliError("--statement \"<your own words>\" is required (at least 10 characters): a condition, a correction asked for, the school consulted, or why");
    if (flags.all || flags["all-pending"]) throw new CliError("there is no bulk signing: name each concept you have read");
    if (!c.approvals.ok) throw new CliError(`the ledger does not verify, so nothing is appended to it: ${c.approvals.problems.join("; ")}`);
    const pick = table.filter((t) => rest.includes(t.id));
    const unknown = rest.filter((id) => !table.some((t) => t.id === id));
    if (unknown.length) throw new CliError(`not concepts: ${unknown.join(", ")}`);
    if (!pick.length) throw new CliError("nothing to do (name the concept ids you have read)");
    const status = { approve: "approved", reject: "rejected", withdraw: "withdrawn" }[sub];
    try {
      await assertSigner(kit, c.project);
      const key = await loadApproverKey(io, flags);
      for (const t of pick) await appendChecked(c.review, c.approvals.roster, key, { id: t.id, sha256: t.hash, status, by, ...(status === "approved" ? { attests: [...ATTESTS] } : {}), statement }, { expect: c.expect, bootstrap: c.expect.bootstrap, witness: witnessOf(flags, io) });
    } catch (e) { throw new CliError(e.message); }
    writeLedgerFile(io.cwd, ledgerFile, c.review);
    io.out(`${status} ${pick.length} concept(s) by ${by}, signed with your key, appended to ${ledgerFile}`);
    return 0;
  }
  throw new CliError(`kit shariah ${sub}: one of init, review, approve, reject, withdraw`);
}
