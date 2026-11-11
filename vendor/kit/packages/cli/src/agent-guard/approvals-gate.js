/**
 * The approval gate for the guard's own paths (docs/AGENT-GUARD.md, C3). A pull request that changes the engine, the registry, the schemas, the hooks, the
 * workflows or CODEOWNERS changes the rules the audit applies to it, so it needs an approval the PR's author cannot forge: an Ed25519 signature by an OWNER key
 * over the digest of exactly those changes, checked against the owner keys of the BASE branch (agent-identities.json at base), by the audit run from the BASE
 * branch's own code.
 *
 *   digest   sha256 over "path NUL blob-sha" of every changed guard path (the ledger file itself excluded), sorted
 *   ledger   guard-approvals.jsonl: append-only, hash-chained rows { schema, digest, login, at, prev, signature }
 *
 * Owed: the shared signed approval ledger of PR #116 (core/ledger.js: roster, witness, history walk). This is the same idea on a small primitive so the gate exists now;
 * it moves onto #116's ledger when that lands.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { globRe } from "../canon/files.js";
import { gitEnv } from "../git.js";
import { pointerValue } from "./common.js";
export { pointerValue };

export const LEDGER = "guard-approvals.jsonl";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });

/**
 * The changed guard paths of base..head: [{ path, sha }] (sha "deleted" for a removal). A guard path "file#/pointer" (kit.canon.json#/vendor)
 * guards one value of a JSON file: it counts as changed when that value differs (the file's other keys stay ordinary), and its sha is the
 * value's own hash. File names compare case-insensitively for pointers, the way the guard's rules match them.
 */
export function guardChanges(root, guardGlobs, { base, head = "HEAD" }) {
  const mb = git(root, "merge-base", base, head).trim();
  const res = guardGlobs.filter((g) => !g.includes("#")).map(globRe);
  const pointers = guardGlobs.filter((g) => g.includes("#")).map((g) => { const i = g.indexOf("#"); return { file: g.slice(0, i), pointer: g.slice(i + 1) }; });
  const show = (rev, p) => { try { return git(root, "show", `${rev}:${p}`); } catch { return null; /* absent at that revision: the value is null, compared as such */ } };
  const out = [];
  for (const p of git(root, "diff", "--name-only", "--no-renames", "-z", mb, head).split("\0").filter(Boolean)) {
    if (p === LEDGER) continue;
    if (res.some((r) => r.test(p))) {
      let s = "deleted"; try { s = git(root, "rev-parse", `${head}:${p}`).trim(); } catch { /* removed at head: recorded as deleted */ }
      out.push({ path: p, sha: s });
    }
    for (const { file, pointer } of pointers) {
      if (p.toLowerCase() !== file.toLowerCase()) continue;
      const was = pointerValue(show(mb, p), pointer), now = pointerValue(show(head, p), pointer);
      if (was !== now) out.push({ path: `${p}#${pointer}`, sha: now == null ? "deleted" : sha(now) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
export const digestOf = (changes) => sha(changes.map((c) => `${c.path}\0${c.sha}`).join("\n"));

/** An owner's approval row for `digest`, signed with the owner's private key (PEM, PKCS#8 Ed25519), chained to the ledger text so far. */
export function signApproval({ privateKeyPem, digest, login, ledgerText = "", at = new Date().toISOString() }) {
  const lines = ledgerText.split("\n").filter(Boolean);
  const prev = lines.length ? sha(lines[lines.length - 1]) : "0".repeat(64);
  const body = { schema: "kit.guard-approval.v1", digest, login, at, prev };
  return { ...body, signature: sign(null, Buffer.from(JSON.stringify(body)), createPrivateKey(privateKeyPem)).toString("base64") };
}

/** → { ok, reason }: the ledger chain is intact and a row for `digest` is signed by a key of the BASE branch's owners. */
export function verifyApprovals({ ledgerText, owners, digest }) {
  if (!owners?.length) return { ok: false, reason: "the base branch lists no owner key, so a change to the guard's own paths cannot be verified (bootstrap: the owner introduces the first owner key by hand)" };
  const lines = (ledgerText || "").split("\n").filter(Boolean);
  let prev = "0".repeat(64), found = null;
  for (const [i, l] of lines.entries()) {
    let r; try { r = JSON.parse(l); } catch { /* unparseable input counts as absent, never as a valid value */ return { ok: false, reason: `ledger line ${i + 1} is not JSON` }; }
    if (r.prev !== prev) return { ok: false, reason: `ledger line ${i + 1} does not chain to the line before it` };
    prev = sha(l);
    const { signature, ...body } = r;
    const owner = owners.find((o) => o.login === r.login);
    if (!owner) continue;
    let good = false; try { good = verify(null, Buffer.from(JSON.stringify(body)), createPublicKey({ key: Buffer.from(owner.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64")); } catch { /* no usable key: the record stays unsigned and verifies as unsigned */ good = false; }
    if (good && r.digest === digest) found = r;
  }
  return found ? { ok: true, reason: "" } : { ok: false, reason: `no row of the ledger carries an owner signature over this pull request's guard changes (digest ${digest.slice(0, 12)}): run \`kit agent-guard approve --base <base>\` as the owner` };
}
