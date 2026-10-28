/**
 * The CLI side of the approval ledger (@saasreport/core/ledger, kit.approval-ledger.v1): read and write the file, key custody, the git-history walk,
 * the witness file, the migration of the old fa-review format. One implementation for the Shariah concept ledger and the Persian fa-review ledger.
 *
 * KEY CUSTODY is a mechanism, with a stated limit. A private key is a passphrase-ENCRYPTED PEM (passphrase of 12+ characters, checked at load), kept under
 * ~/.kit (0700), never in a git work tree (a separate-gitdir work tree is caught by living outside ~/.kit), decrypted only from an interactive terminal prompt
 * (TTY on stdin and stdout; the library API has NO injectable prompt: only the kit's own tests have a module-private seam), never from an environment variable,
 * never in bulk. LIMIT: an agent that can allocate a pseudo-terminal AND knows the passphrase (script, expect, a pty library) can still answer the prompt; no check
 * in the same OS account can tell it from a person. What holds is that the agent never has the passphrase or the key; the browser signing page (a non-extractable
 * WebCrypto key in the owner's browser) is the primary signer for that reason, and separation of agent credentials (#117) is what makes this complete.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, chmodSync, appendFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { gitEnv } from "./git.js";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { witnessViaEndpoint } from "@saasreport/core/witness";
import { remoteVerify } from "@saasreport/core/verifier";
import { newNonce } from "@saasreport/core/verdict";
import { TEST } from "./test-seam.js";
import { formatProblems } from "@saasreport/core/schema";
import { genesisFor, ledgerId, nextEntry, signedBody, entryHash, memberHash, verifyLedger, witnessProblems, ledgerHead, checkAppend, FUTURE_SKEW_MS } from "@saasreport/core/ledger";
import { toBase64 } from "@saasreport/core/ed25519";

const P = (file, problem) => ({ file, problem });
export const LEDGER_SCHEMA_URL = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/approval-ledger.schema.json";
export const git = (root, args, input) => { const r = spawnSync("git", args, { cwd: root, encoding: "utf8", ...(input != null ? { input } : {}), maxBuffer: 1 << 28, env: gitEnv() }); return r.status === 0 ? r.stdout : null; };
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Reads and schema-validates a ledger. `expect` is what the kit registry says (id, project, kind, subject): a mismatch is refused by verifyLedger. */
export function readLedgerFile(root, file, kit) {
  if (!existsSync(join(root, file))) return { ledger: null, missing: true, problems: [] };
  let ledger;
  try { ledger = JSON.parse(readFileSync(join(root, file), "utf8")); } catch (e) { return { ledger: null, missing: false, problems: [P(file, `not JSON: ${e.message}`)] }; }
  // The pre-ledger fa-review.json (entries by file, no chain, no anchor) is not schema-checked: it is the input of `kit persian migrate`, and the gate says so.
  if (ledger && typeof ledger === "object" && ledger.anchor === undefined && ledger.id === undefined) return { ledger, missing: false, old: true, problems: [] };
  const problems = formatProblems(kit.validator.validate(ledger, kit.byName("approval-ledger"))).map((m) => P(file, `approval-ledger: ${m}`));
  return { ledger, missing: false, problems };
}

/** A new ledger anchored at the current git commit; identity (id, project, kind, subject) from the registry's expectation. */
export function createLedger(root, expect, { baselines = [], migratedFrom = null, at = new Date().toISOString() } = {}) {
  const commit = git(root, ["rev-parse", "HEAD"])?.trim();
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("the ledger is anchored at a git commit: commit the repository first (git rev-parse HEAD found none)");
  if (expect.anchor && expect.anchor !== commit && git(root, ["merge-base", "--is-ancestor", expect.anchor, "HEAD"]) === null) throw new Error("the registry's anchor is not an ancestor of HEAD");
  const ledger = { $schema: LEDGER_SCHEMA_URL, id: expect.id, project: expect.project, kind: expect.kind, subject: expect.subject, anchor: { commit: expect.anchor || commit, genesis: genesisFor(expect.anchor || commit), baselineThrough: baselines.length, ...(migratedFrom ? { migratedFrom } : {}) }, entries: [] };
  for (const b of baselines) ledger.entries.push(nextEntry(ledger, { [expect.subject]: b[expect.subject], sha256: b.sha256, status: "baseline", at, ...(b.segments != null ? { segments: b.segments } : {}), ...(b.note ? { note: b.note } : {}) }));
  return ledger;
}
/** Writes the ledger exactly as the chain has it: entries are never re-sorted. */
export const writeLedgerFile = (root, file, ledger) => writeFileSync(join(root, file), `${JSON.stringify(ledger, null, 2)}\n`);

/* ---------------- key custody ---------------- */

/**
 * The signer code's hash: the files that decide what a signature means (the ledger and signature code and the commands that sign), hashed together. The OWNER signs it into the
 * trust record (`signer.sha256`, kit trust signer-hash); the CLI refuses to decrypt a key when the code it is running does not match, so an agent that edits the signer (to log a
 * passphrase, to sign something else) cannot make the owner's key work under it. Vendored copies have the same relative layout, so they hash the same.
 */
export function signerHash() {
  const core = dirname(fileURLToPath(import.meta.resolve("@saasreport/core/ledger"))), cli = dirname(fileURLToPath(import.meta.url));
  const files = [["core/ledger.js", join(core, "ledger.js")], ["core/ed25519.js", join(core, "ed25519.js")], ["core/trust.js", join(core, "trust.js")], ["core/canonical.js", join(core, "canonical.js")], ["core/sha256.js", join(core, "sha256.js")], ["cli/ledger-io.js", join(cli, "ledger-io.js")], ["cli/commands/shariah.js", join(cli, "commands", "shariah.js")], ["cli/commands/persian.js", join(cli, "commands", "persian.js")], ["cli/commands/ledger.js", join(cli, "commands", "ledger.js")]];
  const h = createHash("sha256");
  for (const [name, p] of files) h.update(`${name}\0`).update(readFileSync(p)).update("\0");
  return h.digest("hex");
}
/** Refuses to sign when the owner-signed record pins a signer hash that this code does not have. */
export async function assertSigner(kit, project) {
  const ap = await kit.approvals(project);
  if (ap.signer && ap.signer.sha256 !== signerHash()) throw new Error(`the signer code differs from the one the owner signed (${signerHash().slice(0, 12)} here, ${ap.signer.sha256.slice(0, 12)} in the trust record): this kit is not the owner's release, so your key is not decrypted. Re-vendor or reinstall the kit at the owner's release`);
}

/** The only place a key may live: ~/.kit (the seam moves it for the kit's own tests). */
export const keyDirFor = (io) => io?.[TEST]?.keyDir ?? join(homedir(), ".kit");

/** The nearest existing ancestor of a path (resolved through symlinks), and whether it lies inside a git work tree (a `.git` entry, file or directory, on the way up). Fails closed. */
export function insideWorkTree(path) {
  let dir = resolve(path);
  while (!existsSync(dir)) { const up = dirname(dir); if (up === dir) return true; dir = up; }   // nothing exists: unknowable, refuse
  let real;
  try { real = realpathSync(dir); } catch { return true; /* an unresolvable location is refused as if it were inside a work tree */ }
  for (let d = real; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}
const realish = (p) => { const rest = []; let d = resolve(p); while (!existsSync(d)) { rest.unshift(d.slice(dirname(d).length + 1)); const up = dirname(d); if (up === d) break; d = up; } try { return join(realpathSync(d), ...rest); } catch { return null; /* unresolved: every caller refuses the path (keyPathProblem) */ } };
const under = (p, base) => { const rp = realish(p), rb = realish(base); return Boolean(rp && rb && (rp === rb || rp.startsWith(rb + sep))); };
/** A key path is acceptable only inside the key directory (~/.kit), outside every work tree, and not under the repository being worked on, with or without a .git entry (a separate-gitdir work tree has none). */
export function keyPathProblem(io, path) {
  const p = resolve(io.cwd, path), kd = keyDirFor(io);
  if (insideWorkTree(p)) return "is inside a git work tree (or its location cannot be resolved): a private key never lives in a repository";
  const top = git(io.cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (realish(p) === null) return "cannot be resolved to a real location: refused (a key path whose place is unknown is not proven outside the work tree)";
  for (const base of [io.cwd, top].filter(Boolean)) if (realish(base) === null || under(p, base)) return "is inside the work tree being worked on (a work tree with a separate git dir has no .git entry, so it is found by its place)";
  mkdirSync(kd, { recursive: true, mode: 0o700 });
  if (!under(p, kd)) return `is outside the key directory ${kd} (keys live there, and only there)`;
  return null;
}

/** The interactive prompt: the passphrase is read from the terminal with echo off. No TTY (a script, an agent, CI): refused. */
export async function ttyPrompt(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("a passphrase is only read from an interactive terminal (no TTY here): signing is a person's act at a keyboard, not a script's");
  return await new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = rl._writeToOutput; rl._writeToOutput = (s) => { if (s.includes(question)) w.call(rl, s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write("\n"); res(a); });
  });
}
const prompt = (io) => io?.[TEST]?.prompt || ttyPrompt;

/** Loads the approver's key: --key <encrypted PEM>, outside any git work tree, unlocked by a terminal passphrase prompt. KIT_APPROVER_KEY is not read. */
export async function loadApproverKey(io, flags) {
  if (!flags.key) throw new Error("--key <approver private key file (passphrase-encrypted PEM)> is required: a sign-off is signed with the approver's own key, which no agent holds (kit ledger keygen makes one; the browser signing page is the primary signer)");
  const path = resolve(io.cwd, String(flags.key));
  if (!existsSync(path)) throw new Error(`key file ${flags.key} does not exist`);
  const kp = keyPathProblem(io, path);
  if (kp) throw new Error(`${flags.key} ${kp}`);
  const pem = readFileSync(path);
  if (!/ENCRYPTED PRIVATE KEY/.test(pem.toString("utf8"))) throw new Error(`${flags.key} is not passphrase-encrypted: refused (kit ledger keygen writes encrypted keys)`);
  const pass = await prompt(io)(`passphrase for ${flags.key}: `, { silent: true });
  if (typeof pass !== "string" || pass.length < 12) throw new Error("the passphrase must be at least 12 characters (a weak passphrase is refused at load, whatever the key was made with)");
  let key;
  try { key = createPrivateKey({ key: pem, passphrase: pass }); } catch { throw new Error("wrong passphrase, or not a PKCS8 private key"); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${flags.key} is not an Ed25519 key`);
  return key;
}
export const publicKeyOf = (privateKey) => Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url").toString("base64");

/**
 * Appends a signed entry. `roster` is the ledger's CURRENT roster (verifyLedger(...).roster); the key must be the registered key of `by`, so a wrong key is refused
 * before anything is written. The timestamp is the signer's clock, UTC with Z.
 */
export function appendSigned(ledger, roster, privateKey, fields, now = new Date()) {
  const r = roster.find((x) => x.name === fields.by);
  if (!r) throw new Error(`"${fields.by}" is not in the roster (${roster.map((x) => x.name).join(", ") || "empty: the owner bootstraps the first key through the registry"})`);
  if (publicKeyOf(privateKey) !== r.publicKey) throw new Error(`this key is not ${fields.by}'s registered key (roster publicKey differs)`);
  const e = nextEntry(ledger, { at: now.toISOString(), ...fields });
  e.sig = toBase64(nodeSign(null, Buffer.from(signedBody(ledger, e)), privateKey));
  ledger.entries.push(e);
  return e;
}

/**
 * appendSigned, but REFUSED when the ledger would no longer verify with the entry (a stale roster proposal, a removal of a vetoer, a weak key, a bad time...): nothing is written,
 * so two members cannot brick a ledger. The browser signing page does the same with checkAppend (core/ledger.js) before it offers the entry. ctx = { expect, bootstrap }.
 */
export async function appendChecked(ledger, roster, privateKey, fields, ctx, now = new Date()) {
  const w = ctx.witness || {}, pinned = ctx.expect?.witness, required = ctx.expect?.witnessFrom != null;
  if (required && !pinned) throw new Error("the owner-signed trust record requires a witness (witnessFrom) but pins none (witness.url, witness.publicKey): nothing is written");
  if (pinned && w.url && w.url !== pinned.url) throw new Error(`the configured witness URL is not the one the owner pinned (${pinned.url}): nothing is written`);
  const durable = Boolean(pinned) && (required || w.url);
  const probe = JSON.parse(JSON.stringify(ledger));
  const e = appendSigned(probe, roster, privateKey, fields, now);
  const chk = await checkAppend(ledger, e, { expect: ctx.expect, bootstrap: ctx.bootstrap, now: now.getTime() });
  if (!chk.ok) throw new Error(`refused at append: the ledger would not verify with this entry, so it is not written (${chk.problems.slice(0, 2).join("; ")}). If the ledger is already unrecoverable, the owner supersedes it with a new owner-signed trust record (a new anchor): docs/CONCEPTS.md section 5`);
  ledger.entries.push(e);
  if (durable) {
    const r = await witnessViaEndpoint(w.fetch || globalThis.fetch, pinned.url, w.token, { ledger }, pinned);
    if (!r.ok) { ledger.entries.pop(); throw new Error(`the witness did not accept the new head, so nothing is written (${r.problems.slice(0, 2).join("; ")})`); }
  }
  return e;
}

/** kit ledger keygen: a fresh Ed25519 key pair; the private key is written PASSPHRASE-ENCRYPTED (PKCS8, 0600) in a 0700 directory outside any git work tree. */
export async function keygen(io, outFile) {
  const out = resolve(io.cwd, outFile);
  const kp = keyPathProblem(io, out);
  if (kp) throw new Error(`${outFile} ${kp}. Use ~/.kit/<name>.pem on your own machine`);
  if (existsSync(out)) throw new Error(`${outFile} exists: refusing to overwrite a key`);
  const a = await prompt(io)("new passphrase (12 characters or more): ", { silent: true });
  if (typeof a !== "string" || a.length < 12) throw new Error("the passphrase must be at least 12 characters");
  if ((await prompt(io)("repeat the passphrase: ", { silent: true })) !== a) throw new Error("the passphrases differ");
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(out, privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: a }), { mode: 0o600 });
  try { chmodSync(out, 0o600); } catch { /* the file was created 0600 on the line above; this only re-asserts it where umask or the filesystem changed it */ }
  return Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
}

/* ---------------- git history ---------------- */

const OLD_FORMAT = (l) => !l || l.anchor === undefined || l.id === undefined;
function blobsAt(root, commits, file) {
  const out = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], commits.map((c) => `${c}:${file}`).join("\n") + "\n");
  const map = new Map();
  (out || "").split("\n").filter(Boolean).forEach((l, i) => map.set(commits[i], /missing/.test(l) ? null : l.split(" ")[0]));
  return map;
}
const sameEntries = (a, b) => a.length <= b.length && a.every((e, i) => entryHash(e) === entryHash(b[i]));

/**
 * The ledger across git history, every commit against EVERY parent (no history simplification: a merge cannot hide a withdrawal):
 *  - a commit's ledger must extend its first parent's ledger entry for entry (nothing rewritten, re-sorted, removed or truncated) and keep the anchor;
 *  - a merge must also carry every entry of its other parents that is not already in the merge base, RE-SIGNED on top (same subject, hash, status and
 *    approver): this is how a fork is resolved, and a withdrawal that a merge drops is refused;
 *  - the ledger is never deleted; a new-format ledger is NEVER turned back into the old format (a commit that does is refused, whatever follows); the old
 *    fa-review format may be replaced once, and only by the migration the OWNER-SIGNED trust record names (`migration.sha256`): a commit whose
 *    `anchor.migratedFrom.sha256` is that old file's hash and whose baselines are exactly old, unchanged, never withdrawn or rejected entries;
 *  - a merge carries each other parent's new entries re-signed in order AFTER the first parent's entries (positional, not "somewhere in the file");
 *  - the anchor commit must be an ANCESTOR of HEAD.
 * Needs the full history, else it FAILS: a check that cannot run is not a pass.
 */
export function ledgerHistoryProblems(root, file, current, { migration = null, anchor: signedAnchor = null } = {}) {
  if (git(root, ["rev-parse", "--is-shallow-repository"])?.trim() === "true") return [P(file, "the ledger's history cannot be verified on a shallow clone: fetch the full history (CI: actions/checkout with fetch-depth: 0). A check that cannot run is not a pass")];
  if (git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return [P(file, "the ledger's history cannot be verified: this is not a git work tree (a check that cannot run is not a pass)")];
  const out = [];
  const revs = (git(root, ["rev-list", "--topo-order", "--parents", "HEAD"]) ?? "").split("\n").filter(Boolean).map((l) => l.split(" "));
  const commits = revs.map((r) => r[0]), blobs = blobsAt(root, commits, file), cache = new Map();
  const load = (blob) => {
    if (!blob) return null;
    if (!cache.has(blob)) { const t = git(root, ["cat-file", "blob", blob]); let j = null; try { j = JSON.parse(t); } catch { j = { entries: [], __bad: true }; /* a revision that is not JSON is marked __bad and refused by the walk below, never read as approving */ } cache.set(blob, { json: j, hash: sha(t) }); }
    return cache.get(blob);
  };
  for (const [c, ...parents] of revs) {
    const child = load(blobs.get(c));
    const where = `commit ${c.slice(0, 12)}`;
    if (child?.json.__bad) out.push(P(file, `the ledger in ${where} is not JSON: a revision that cannot be read is refused, never taken as an empty ledger`));
    if (!parents.length) continue;
    const pv = parents.map((p) => load(blobs.get(p)));
    if (!child) { if (pv.some(Boolean)) out.push(P(file, `the ledger was deleted in ${where}: it is never removed`)); continue; }
    pv.forEach((p, i) => {
      if (!p || blobs.get(parents[i]) === blobs.get(c)) return;
      if (!OLD_FORMAT(p.json) && OLD_FORMAT(child.json)) { out.push(P(file, `the ledger was turned back into the old format in ${where}: a new-format ledger never returns to it (the old format carries no chain, and a later "migration" would launder whatever was written in between)`)); return; }
      if (OLD_FORMAT(p.json)) {
        if (OLD_FORMAT(child.json)) return;   // before the migration the old file is just a file
        const m = child.json.anchor?.migratedFrom;
        const olds = new Map((p.json.entries || []).map((e) => [e.file, e]));
        const ok = migration && m && m.sha256 === migration.sha256 && m.entries === migration.entries && m.sha256 === p.hash && m.entries === (p.json.entries || []).length
          && child.json.entries.every((e) => e.status === "baseline" && olds.get(e.file)?.sha256 === e.sha256 && !["withdrawn", "rejected"].includes(olds.get(e.file)?.status));
        if (!ok) out.push(P(file, `the ledger changed format in ${where} without the migration the owner-signed trust record names (it records the one old file's hash; kit persian migrate baselines only its unchanged entries, never a withdrawn or rejected one)`));
        return;
      }
      if (i === 0) {
        // the ONE way the anchor changes: the owner-signed record names a NEW anchor and the new ledger is anchored exactly there (recovery of an unrecoverable ledger)
        if (signedAnchor && child.json.anchor?.commit === signedAnchor && p.json.anchor?.commit !== signedAnchor) return;
        if (!sameEntries(p.json.entries, child.json.entries)) out.push(P(file, `an earlier entry was rewritten, re-sorted or removed in ${where}: the ledger is append-only`));
        if (JSON.stringify(p.json.anchor) !== JSON.stringify(child.json.anchor)) out.push(P(file, `the anchor changed in ${where}: it is recorded once, when the ledger is created`));
      } else {
        // a merge: the other parent's entries beyond the merge base must be present again, re-signed, in order, AFTER the first parent's own entries
        const p0 = pv[0] && !OLD_FORMAT(pv[0].json) ? pv[0].json.entries : [];
        const base = git(root, ["merge-base", parents[0], parents[i]])?.trim();
        const bb = base ? load(blobsAt(root, [base], file).get(base)) : null;
        const baseEntries = bb && !OLD_FORMAT(bb.json) ? bb.json.entries : [];
        let k = 0; while (k < baseEntries.length && k < p.json.entries.length && entryHash(baseEntries[k]) === entryHash(p.json.entries[k])) k++;
        const tuple = (e) => `${e[child.json.subject] ?? e.member?.name ?? ""}|${e.sha256}|${e.status}|${e.by ?? ""}`;
        const tail = child.json.entries.slice(p0.length).map(tuple);
        let at = 0;
        for (const e of p.json.entries.slice(k)) {
          const j = tail.indexOf(tuple(e), at);
          if (j < 0) out.push(P(file, `${where} merges a branch whose ${e.status} of ${e[child.json.subject] ?? e.member?.name} is missing from the merged ledger after the first parent's entries (or out of order). To fix: rebase the branch onto the target (git rebase), re-sign its entries on top of the target's ledger (kit shariah approve / kit persian approve, one named item at a time) and resolve the ledger file to that result, or squash-merge after re-signing. A plain merge that keeps either side's ledger is refused, and so is any merge that drops an entry`));
          else at = j + 1;
        }
      }
    });
  }
  const cur = current || null;
  const head = load(blobs.get(commits[0]));
  if (cur && head && !OLD_FORMAT(head.json) && !sameEntries(head.json.entries, cur.entries)) out.push(P(file, "an earlier entry was rewritten, re-sorted or removed in the working tree: the ledger is append-only"));
  if (cur && head && !OLD_FORMAT(head.json) && JSON.stringify(head.json.anchor) !== JSON.stringify(cur.anchor)) out.push(P(file, "the anchor changed in the working tree: it is recorded once, when the ledger is created"));
  const anchor = cur?.anchor?.commit;
  if (anchor && git(root, ["merge-base", "--is-ancestor", anchor, "HEAD"]) === null) out.push(P(file, `the anchor commit ${anchor.slice(0, 12)} is not an ancestor of HEAD (it must be on this branch's history, not merely exist as an object)`));
  return out;
}

/* ---------------- the witness ---------------- */

/**
 * The witness for a CLI check. witness = { file?, url?, token, fetch } (--witness <file>, --witness-url, KIT_WITNESS_TOKEN). Once the owner-signed record sets `witnessFrom` a DURABLE witness is
 * required, judged from the record alone, and it must be THE witness the record pins: `witness: { url, publicKey }`. The configured URL can only confirm the pin; an answer is believed only when
 * it is signed by the pinned key and bound to this request and this head (core/witness.js); a record that pins no witness cannot use one; a local file never counts once `witnessFrom` is set.
 * The ledger and the trust record are posted, and the record's expiry is judged against the witness's own clock.
 */
export async function witnessCheck(root, witness, ledger, expect, { record = expect?.record ?? null } = {}) {
  const w = witness && typeof witness === "object" ? witness : { file: typeof witness === "string" ? witness : null };
  const required = expect?.witnessFrom != null, pinned = expect?.witness;
  if (required && !pinned) return [P("witness", `the owner-signed trust record requires a witness (witnessFrom ${expect.witnessFrom}) but pins none (witness.url, witness.publicKey): an answer from a URL nobody pinned is not a witness. Refused: a missing witness fails closed`)];
  if (w.url && !pinned) return [P("witness", "the owner-signed trust record pins no witness (witness.url, witness.publicKey): a configured witness URL is refused")];
  if (pinned && w.url && w.url !== pinned.url) return [P("witness", `the configured witness URL is not the one the owner pinned (${pinned.url}): refused`)];
  if (required && w.file && !w.url) return [P("witness", "a local --witness file never counts once the record sets witnessFrom: the durable, pinned witness is required")];
  if (!pinned) return w.file ? fileWitness(root, w.file, ledger) : [];
  if (!required && !w.url) return w.file ? fileWitness(root, w.file, ledger) : [];
  const r = await witnessViaEndpoint(w.fetch || globalThis.fetch, pinned.url, w.token, { ledger, ...(record ? { record: record.body } : {}) }, pinned);
  const out = r.ok ? [] : r.problems.map((m) => P("witness", m));
  if (r.ok && record && r.now && Date.parse(record.expires) < Date.parse(r.now)) out.push(P("witness", `the trust record expired at ${record.expires} (the witness's clock says ${r.now}): the owner re-signs it (kit trust)`));
  return out;
}

/**
 * The remote verifier gate. This process cannot be made trustworthy against the agent that runs it (the owner pin is an environment variable; fetch and the code are replaceable:
 * NODE_OPTIONS, a preload, an edited signer), so the verdict that counts is the pinned verifier's, SIGNED and bound (core/verdict.js): the owner-signed record pins
 * `verifier: { url, publicKey, required }`. Required and unreachable, unsigned, wrongly signed, replayed or for another state: the gate FAILS. A verifier the record does not pin is
 * refused (an unpinned stub saying { ok: true } is not a verdict), the configured URL must be the pinned one, and a verdict NEVER replaces the witness check (the gate runs both).
 * verifier = { url?, token, fetch } from --verifier-url / KIT_VERIFIER_URL (the URL can only confirm the pin) and KIT_VERIFIER_TOKEN.
 */
export async function verifierProblems(verifier, project, kind, ledger, expect, { root, kit } = {}) {
  const pinned = expect?.verifier;
  if (!pinned) return verifier?.url ? [P("verifier", "the owner-signed trust record pins no verifier (verifier.url, verifier.publicKey): a verdict is believed only under a key the owner pinned, so a configured verifier is refused")] : [];
  if (verifier?.url && verifier.url !== pinned.url) return [P("verifier", `the configured verifier URL is not the one the owner pinned (${pinned.url}): refused`)];
  if (!pinned.required && !verifier?.url) return [];
  if (!expect.record?.body?.github) return [P("verifier", "no owner-signed trust record to bind the verdict to")];
  const sha = git(root, ["rev-parse", "HEAD"])?.trim();
  if (!/^[0-9a-f]{40}$/.test(sha || "")) return [P("verifier", "the commit being deployed cannot be determined (not a git work tree)")];
  const { contentHashOf } = await import("./content-state.js");
  const bind = { repo: expect.record.body.github, sha, ledgerHead: ledgerHead(ledger), recordHash: expect.record.hash, contentHash: await contentHashOf(root, kind, kit, expect.ledger) };
  const r = await remoteVerify(verifier?.fetch || globalThis.fetch, pinned, verifier?.token || null, { project, kind, sha, nonce: newNonce() }, bind);
  return r.ok ? [] : r.problems.map((m) => P("verifier", m));
}

/* ---------------- the witness file (CI, local) ---------------- */

/** An append-only JSON-lines witness kept OUTSIDE the repository: refuses a ledger behind or forked from the highest head recorded for it, then records the head. */
export function fileWitness(root, path, ledger) {
  const f = resolve(root, path);
  if (insideWorkTree(f)) return [P(path, "the witness file must be outside the repository (it is the memory the repository cannot rewrite)")];
  let seen = null;
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) { try { const r = JSON.parse(l); if (r.ledger === ledger.id && (!seen || r.seq > seen.seq)) seen = r; } catch { return [P(path, "the witness file is not JSON lines")]; } }
  const problems = witnessProblems(ledger, seen).map((m) => P(path, m));
  if (!problems.length) { const h = ledgerHead(ledger); if (!seen || h.seq > seen.seq) { mkdirSync(dirname(f), { recursive: true, mode: 0o700 }); appendFileSync(f, `${JSON.stringify({ ledger: ledger.id, seq: h.seq, hash: h.hash, at: new Date().toISOString() })}\n`); } }
  return problems;
}

export { verifyLedger, ledgerId, memberHash, FUTURE_SKEW_MS, sep };
