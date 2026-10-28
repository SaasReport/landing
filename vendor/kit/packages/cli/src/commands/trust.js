/**
 * kit trust — the owner-signed trust record of a project (docs/CONCEPTS.md section 5): who may approve what, signed by the OWNER's SSH key and verified against the owner's
 * published GitHub SSH signing keys for an owner pinned outside the repository (KIT_OWNER).
 *
 *   kit trust propose --project <p> --github <Org/repo> --owner <github user> --name "<Full Name>" --public-key <approval public key> [--owner <github>] --verifier-url <u> --verifier-key <k> --witness-url <u> --witness-key <k> --out <record.json>
 *                                             an UNSIGNED draft record whose roster is exactly one person (the owner: sole approver of BOTH kinds, persian and shariah); the owner handle defaults to projects.json owner.github; it
 *                                             signs nothing, writes no ledger row and no approval; the owner takes the public key from the signing page and signs the draft
 *   kit trust body <record.json>              print the exact text the owner signs (the canonical JSON without `signature`) into <record>.body
 *   (the owner, on their own machine)         ssh-keygen -Y sign -f ~/.ssh/<key> -n kit-trust@<project> <record>.body       → <record>.body.sig
 *   kit trust attach <record.json> <sig>      write the signature into the record; the record then goes into packages/core/registry/trust/<project>.json (a kit PR)
 *   kit trust signer-hash                     the hash of the signer code, for `signer` in the record: the CLI then signs only when its own code matches
 *   kit trust verify <project>                verify the bundled record against the pinned owner's GitHub keys, this repository and the witness
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../args.js";
import { kitFor } from "../bundled.js";
import { trustBody, trustNamespace } from "@saasreport/core/trust";
import { checkPublicKey } from "@saasreport/core/ed25519";
import { signerHash, git } from "../ledger-io.js";
import { baselineHash, ledgerHead } from "@saasreport/core/ledger";
import { scopeHash } from "@saasreport/core/scope";
import { keyFingerprint } from "@saasreport/core/trust";
import { loadCanon } from "../canon/index.js";
import { loadPersian, reviewState, baselineCandidates } from "../canon/persian.js";

export async function trust(io, { _: [sub, a, b], flags }) {
  if (sub === "propose") {
    const need = (k) => { if (!flags[k]) throw new CliError(`kit trust propose: --${k} is required`); return String(flags[k]); };
    const kit = kitFor(io), project = need("project"), github = need("github"), name = need("name"), publicKey = need("public-key"), out = need("out");
    // the owner handle comes from the registry (projects.json owner.github), not from this code; --owner overrides it
    const owner = flags.owner ? String(flags.owner) : kit.registry.projects.find((p) => p.key === project)?.owner?.github;
    if (!owner) throw new CliError(`kit trust propose: project "${project}" has no owner.github in packages/core/registry/projects.json: pass --owner <github user>`);
    const bad = checkPublicKey(publicKey);
    if (bad) throw new CliError(`--public-key is ${bad}: copy the approval public key shown by the signing page (never generate it here)`);
    if (!/^[a-z0-9-]+$/.test(project) || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(github) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || name.length < 2) throw new CliError("kit trust propose: project, github (Org/repo), owner or name is malformed");
    const days = flags["expires-days"] != null ? Number(flags["expires-days"]) : 365;
    if (!(days > 0 && days <= 730)) throw new CliError("--expires-days must be between 0 and 730");
    const kinds = String(flags.kinds || "persian,shariah").split(",").map((s) => s.trim()).filter(Boolean);
    if (kinds.some((k) => !["persian", "shariah"].includes(k))) throw new CliError("--kinds is persian, shariah or both");
    const seq = Number(flags.seq ?? 1);
    if (!Number.isInteger(seq) || seq < 1) throw new CliError("--seq must be a whole number from 1");
    if (seq > 1 && !/^[0-9a-f]{64}$/.test(String(flags.supersedes || ""))) throw new CliError("--supersedes <sha256 of the record this replaces> is required for seq > 1 (records are a signed chain)");
    // the STRICT policy is the only policy: ledgers anchored at the current commit, witnessFrom with a pinned witness, a required pinned verifier, the signer hash, the pinned Persian baseline and scope
    const roster = [{ name, publicKey, fingerprint: keyFingerprint(publicKey) }];   // exactly one approver, for both kinds: the owner
    const now = new Date();
    const approvals = { concepts: flags.concepts ? String(flags.concepts) : kinds.includes("shariah") ? "shariah" : null };
    const anchor = git(io.cwd, ["rev-parse", "HEAD"])?.trim();
    if (!/^[0-9a-f]{40}$/.test(anchor || "")) throw new CliError("the strict policy anchors the ledgers at the current commit: run it in the git repository");
    const copied = [];
    for (const k of kinds) {
      const ledgerFile = k === "persian" ? "fa-review.json" : "shariah-review.json";
      let ledgerAnchor = anchor;   // an existing ledger keeps ITS anchor (the commit it was created at); a new one is anchored at the current commit
      try { const l = JSON.parse(readFileSync(join(io.cwd, ledgerFile), "utf8")); if (/^[0-9a-f]{40}$/.test(l.anchor?.commit || "")) { ledgerAnchor = l.anchor.commit; copied.push(`${k}: anchor ${ledgerAnchor} COPIED from ${ledgerFile} (the ledger's own anchor: it is in the working tree, which an agent can edit)`); } } catch { /* no ledger file yet: the anchor stays the current commit, and the copied note below says so */ }
      if (ledgerAnchor === anchor) copied.push(`${k}: anchor ${anchor} = the current commit (a new ledger)`);
      approvals[k] = { ledger: ledgerFile, anchor: ledgerAnchor, roster: [...roster], witnessFrom: 0 };
    }
    if (kinds.includes("persian")) {
      // the baseline and the scope the owner pins are the Persian copy and the scope as they stand now (the owner has read them, or accepts them as the pre-gate state)
      const { canon } = loadCanon(io.cwd, kit), { cfg } = canon ? loadPersian(io.cwd, canon, kit) : {};
      if (!cfg) throw new CliError("the strict policy pins the Persian baseline and scope from persian.config.json: run it in the repository, or use --kinds shariah");
      const files = baselineCandidates(reviewState(io.cwd, cfg, null)).map((s) => ({ file: s.file, sha256: s.sha256 }));
      approvals.persian.baseline = { sha256: baselineHash(files), entries: files.length };
      approvals.persian.scope = { sha256: scopeHash(cfg, canon.persian) };
      io.out(`baseline pinned: ${files.length} Persian source file(s):\n${files.map((f) => `  ${f.sha256.slice(0, 12)}  ${f.file}`).join("\n")}\nThe owner signs this pin and the review scope (sources, exclude, mixed): only these files, at these hashes, are the pre-gate state; every other Persian text needs the owner's own signature.`);
    }
    for (const f of ["verifier-url", "verifier-key", "witness-url", "witness-key"]) if (!flags[f]) throw new CliError(`kit trust propose: --${f} is required (the strict policy pins the broker verifier and the witness: url and Ed25519 public key of each)`);
    for (const f of ["verifier-key", "witness-key"]) { const bad2 = checkPublicKey(String(flags[f])); if (bad2) throw new CliError(`--${f} is ${bad2}`); }
    const rec = { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/trust-record.schema.json", v: 1, project, github, owner, seq, supersedes: seq === 1 ? null : String(flags.supersedes), at: now.toISOString(), expires: new Date(now.getTime() + days * 864e5).toISOString(), approvals };
    // the owner's checkpoint: the record's OWN seq and the current ledger heads, so a database (re)started from it can never accept anything older
    rec.checkpoint = { recordSeq: seq, ledgers: {} };
    for (const k of kinds) { const lf = join(io.cwd, approvals[k].ledger); if (existsSync(lf)) { try { const l = JSON.parse(readFileSync(lf, "utf8")); if (l.anchor && l.entries) { rec.checkpoint.ledgers[k] = ledgerHead(l); copied.push(`${k}: checkpoint head seq ${rec.checkpoint.ledgers[k].seq}, hash ${rec.checkpoint.ledgers[k].hash} COPIED from ${approvals[k].ledger}`); } } catch { /* an unreadable ledger has no head to checkpoint */ } } }
    rec.verifier = { url: String(flags["verifier-url"]), publicKey: String(flags["verifier-key"]), required: true };
    rec.witness = { url: String(flags["witness-url"]), publicKey: String(flags["witness-key"]) };
    rec.signer = { sha256: signerHash() };
    writeFileSync(join(io.cwd, out), `${JSON.stringify(rec, null, 2)}\n`);
    io.out(`wrote ${out}: UNSIGNED. Nothing is signed or approved: it names ${name} (${owner}) as the only approver for ${kinds.join(" and ")}, STRICT policy (anchor, witnessFrom with a pinned witness, required verifier, signer hash, pinned baseline and scope).
APPROVAL KEY FINGERPRINT: ${roster[0].fingerprint}
COPIED FROM THE WORKING TREE, check each against \`git log\` / the ledger you trust BEFORE you sign (a signature over an anchor or head an agent chose pins THAT):
${copied.map((c) => `  ${c}`).join("\n")}
Compare it, character for character, with the fingerprint the SIGNING PAGE shows for your approval key BEFORE you sign: this key came from an argument, and a different key under your name would be an approver you did not choose.
Next, on your own machine: kit trust body ${out}; ssh-keygen -Y sign -f <your ssh key> -n ${trustNamespace(project)} ${out}.body; kit trust attach ${out} ${out}.body.sig
CODEOWNERS (the ledgers and the reviewer lists need the owner's review): ${["/fa-review.json", "/shariah-review.json", "/concepts.config.json", "/persian.config.json", "/kit.canon.json"].map((f) => `${f} @${owner}`).join("  ")}`);
    return 0;
  }
  if (sub === "body") {
    if (!a) throw new CliError("kit trust body <record.json>");
    const rec = JSON.parse(readFileSync(join(io.cwd, a), "utf8"));
    writeFileSync(join(io.cwd, `${a}.body`), trustBody(rec));
    io.out(`wrote ${a}.body. Sign it on your own machine: ssh-keygen -Y sign -f <your ssh key> -n ${trustNamespace(rec.project)} ${a}.body`);
    return 0;
  }
  if (sub === "attach") {
    if (!a || !b) throw new CliError("kit trust attach <record.json> <body.sig>");
    const rec = JSON.parse(readFileSync(join(io.cwd, a), "utf8"));
    rec.signature = readFileSync(join(io.cwd, b), "utf8").trim();
    writeFileSync(join(io.cwd, a), `${JSON.stringify(rec, null, 2)}\n`);
    io.out(`signature attached to ${a}; kit trust verify <project> proves it against the owner's GitHub keys`);
    return 0;
  }
  if (sub === "verify") {
    const kit = kitFor(io), ap = await kit.approvals(a);
    for (const m of ap.problems) io.err(`  - ${m}`);
    io.out(ap.known ? `ok trust ${a}: record seq ${ap.record.seq} (${ap.record.hash.slice(0, 12)}) signed by the pinned owner; ledgers: ${["shariah", "persian", "uploads"].filter((k) => ap[k]).join(", ") || "none"}` : "FAILED");
    return ap.known ? 0 : 1;
  }
  if (sub === "signer-hash") { io.out(signerHash()); return 0; }
  throw new CliError("kit trust: one of propose, body, attach, verify, signer-hash");
}
