/**
 * kit ledger — the approval ledger's own tools (docs/CONCEPTS.md section 5).
 *
 *   kit ledger keygen --out <file>      a new Ed25519 approver key, PASSPHRASE-ENCRYPTED (asked on the terminal, 12+ characters), written to <file> (0600, in a 0700
 *                                       directory) which must be OUTSIDE any git work tree; the public key is printed for the roster. Run it on your own machine.
 *   kit ledger verify <shariah|persian|uploads> verify the project's ledger (chain, signatures, roster, veto) against the kit registry, and its git history
 *   kit ledger roster add|remove <shariah|persian|uploads> --by <member> --key <pem> --name <n> [--public-key <base64>]
 *                                       a roster change, signed by an EXISTING roster member (add needs the new member's public key)
 *   kit ledger roster rotate <kind> --by <member> --key <pem> --name <member> --public-key <new>   the member replaces their own key (signed with the old one)
 *   kit ledger witness-bootstrap <record.json>   the rows a fresh or replaced witness database starts with, from the record's owner-signed checkpoint
 *   kit ledger witness-sql              the SQL of the monotonic witness table (D1: append-only by trigger) for the project's migrations
 */
import { join } from "node:path";
import { CliError } from "../args.js";
import { kitFor } from "../bundled.js";
import { keygen, loadApproverKey, appendChecked, assertSigner, readLedgerFile, writeLedgerFile, ledgerHistoryProblems, witnessCheck, verifyLedger, memberHash } from "../ledger-io.js";
import { checkPublicKey } from "@saasreport/core/ed25519";
import { WITNESS_SQL, bootstrapSql } from "@saasreport/core/witness";
import { keyFingerprint, verifyTrustRecord } from "@saasreport/core/trust";
import { trustContext } from "../bundled.js";
import { TEST } from "../test-seam.js";
import { readFileSync } from "node:fs";

export const verifierOf = (flags, io) => { const env = io?.env || process.env, url = flags["verifier-url"] ? String(flags["verifier-url"]) : env.KIT_VERIFIER_URL; return { ...(url ? { url } : {}), token: env.KIT_VERIFIER_TOKEN || null, fetch: io?.fetch }; };   // always an object: the pinned URL comes from the owner-signed record, this only supplies the token and the transport
export const witnessOf = (flags, io) => ({ ...(flags["witness-url"] ? { url: String(flags["witness-url"]) } : {}), ...(flags.witness ? { file: String(flags.witness) } : {}), token: (io?.env || process.env).KIT_WITNESS_TOKEN || null, fetch: io?.fetch });

async function expectOf(io, kit, kind) {
  let project;
  try { project = JSON.parse(readFileSync(join(io.cwd, "kit.canon.json"), "utf8")).project; } catch { throw new CliError("kit.canon.json (with the project key) is missing"); }
  const ap = await kit.approvals(project);
  if (!ap.known) throw new CliError(`no verified owner-signed trust record for "${project}": ${ap.problems.join("; ")}`);
  const expect = ap[kind];
  if (!expect) throw new CliError(`the kit registry records no ${kind} ledger for ${project} (shariah or persian)`);
  return expect;
}

export async function ledger(io, { _: [sub, ...rest], flags }) {
  if (sub === "keygen") {
    if (!flags.out) throw new CliError("kit ledger keygen --out <private key file> (outside any git work tree)");
    let pub;
    try { pub = await keygen(io, String(flags.out)); } catch (e) { throw new CliError(e.message); }
    io.out(`private key (encrypted with your passphrase) written to ${flags.out}; never commit it, never give it to an agent\npublicKey: ${pub}\nGive the publicKey to the owner for the roster: { "name": "<you>", "publicKey": "${pub}" }`);
    return 0;
  }
  if (sub === "witness-sql") { io.out(WITNESS_SQL); return 0; }
  const kit = kitFor(io);
  if (sub === "verify") {
    const expect = await expectOf(io, kit, rest[0]);
    const r = readLedgerFile(io.cwd, expect.ledger, kit);
    if (r.missing) throw new CliError(`${expect.ledger} is missing`);
    const v = r.problems.length ? { ok: false, problems: r.problems.map((p) => p.problem) } : await verifyLedger(r.ledger, { expect, bootstrap: expect.bootstrap });
    const problems = [...v.problems];
    if (v.ok) { problems.push(...ledgerHistoryProblems(io.cwd, expect.ledger, r.ledger, { migration: expect.migration, anchor: expect.anchor }).map((p) => p.problem)); problems.push(...(await witnessCheck(io.cwd, witnessOf(flags, io), r.ledger, expect)).map((p) => p.problem)); }
    for (const m of problems) io.err(`  - ${m}`);
    io.out(problems.length ? "FAILED" : `ok: ${r.ledger.entries.length} entries, chain, signatures, roster and git history verify`);
    return problems.length ? 1 : 0;
  }
  if (sub === "roster") {
    const [op, kind] = rest;
    if (!["add", "remove", "rotate"].includes(op)) throw new CliError("kit ledger roster add|remove|rotate <shariah|persian|uploads> --by <member> --key <pem> --name <n> [--public-key <base64>] [--actions a,b]  (add: --actions limited to what the signers hold; rotate: --by is the member, --key their CURRENT key, --public-key the NEW one)");
    const expect = await expectOf(io, kit, kind);
    const r = readLedgerFile(io.cwd, expect.ledger, kit);
    if (r.missing || r.problems.length) throw new CliError(`${expect.ledger} is missing or invalid: create it first`);
    const v = await verifyLedger(r.ledger, { expect, bootstrap: expect.bootstrap });
    if (!v.ok) throw new CliError(`the ledger does not verify: ${v.problems.join("; ")}`);
    const name = flags.name && String(flags.name), by = flags.by && String(flags.by);
    if (!name || !by) throw new CliError("--by <existing member> and --name <member> are required");
    let member;
    if (op === "add" || op === "rotate") {
      const pk = flags["public-key"] && String(flags["public-key"]);
      const bad = !pk ? "--public-key <base64> is required" : checkPublicKey(pk);
      if (bad) throw new CliError(`public key refused: ${bad}`);
      member = { name: op === "rotate" ? by : name, publicKey: pk, ...(op === "add" && flags.actions ? { actions: String(flags.actions).split(",").map((s) => s.trim()).filter(Boolean) } : {}) };
      if (op === "rotate" && name !== by) throw new CliError("a rotation is the member's own act: --name must be --by");
    } else {
      member = v.roster.find((m) => m.name === name);
      if (!member) throw new CliError(`${name} is not in the roster`);
    }
    try {
      await assertSigner(kit, JSON.parse(readFileSync(join(io.cwd, "kit.canon.json"), "utf8")).project);
      const key = await loadApproverKey(io, flags);
      const days = flags["expires-days"] != null ? Number(flags["expires-days"]) : 7;
      if (!(days > 0 && days <= 14)) throw new Error("--expires-days must be between 0 and 14: a roster proposal lapses (a signed expiry)");
      const status = { add: "roster-add", remove: "roster-remove", rotate: "roster-rotate" }[op];
      await appendChecked(r.ledger, v.roster, key, { member, sha256: memberHash(member), status, by, ...(op === "rotate" ? {} : { expires: new Date(Date.now() + days * 864e5).toISOString() }) }, { expect, bootstrap: expect.bootstrap, witness: witnessOf(flags, io) });
    } catch (e) { throw new CliError(e.message); }
    writeLedgerFile(io.cwd, expect.ledger, r.ledger);
    io.out(op === "rotate" ? `rotated ${by}'s key (new fingerprint ${keyFingerprint(member.publicKey)}), signed with the old key; earlier entries stay verifiable` : `${op === "add" ? "added" : "removed"} ${name} ${op === "add" ? "to" : "from"} the ${kind} roster, signed by ${by}`);
    return 0;
  }
  if (sub === "witness-bootstrap") {
    // the rows a fresh or replaced witness database must start with: the current record and the ledger heads of its owner-signed checkpoint
    if (!rest[0]) throw new CliError("kit ledger witness-bootstrap <record.json>");
    // only a record that VERIFIES (owner key, pinned owner, repository, schema, expiry) is turned into SQL: a forged record would otherwise plant a forged floor
    let rec; try { rec = JSON.parse(readFileSync(join(io.cwd, rest[0]), "utf8")); } catch { throw new CliError(`${rest[0]} is not JSON`); }
    const tc = trustContext({ env: io.env || process.env, fetch: io.fetch, cwd: io.cwd, seam: io[TEST] || {} }), ks = await tc.keys();
    const v = await verifyTrustRecord(rec, { project: rec.project, owner: tc.owner, ownerKeys: ks.keys, ownerKeysError: ks.error, repo: tc.repo, pin: tc.pinFor(rec.project), now: Date.now() });
    if (!v.ok) throw new CliError(`the record does not verify, so no SQL is printed: ${v.problems.join("; ")}`);
    try { io.out(bootstrapSql(rec)); } catch (e) { throw new CliError(e.message); }
    return 0;
  }
  throw new CliError("kit ledger: one of keygen, verify, roster, witness-sql, witness-bootstrap");
}
