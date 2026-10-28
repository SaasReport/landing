/**
 * The CONTENT STATE an approval gate is about to deploy, hashed, and the source a verifier reads a repository AT A COMMIT with (docs/CONCEPTS.md section 5).
 *   contentHashOf(root, kind, kit)    sha256 of canonicalJson of what the approvals are about: the ledger file's hash and, for Persian, every source file's review hash, for
 *                                     Shariah, every concept's approval hash and the schedule. The gate computes it on the tree it is about to deploy; the verifier computes it on
 *                                     ITS OWN copy at the commit; the signed verdict must carry the same value.
 *   gitSource(root, sha, kit)         the verifier's source reader for a checkout of `sha`: the trust record and the ledger as committed, and the FULL check (git history, pinned
 *                                     baseline, content state, source proof) run on that copy. (A Worker materialises the commit and passes the same interface.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, } from "@saasreport/core/canonical";
import { sha256 } from "@saasreport/core/sha256";
import { scopeHash } from "@saasreport/core/scope";
import { approvalHash } from "@saasreport/core/concepts";
import { git } from "./ledger-io.js";
import { snapshotRoots, vendorOfCanonText } from "./vendor-path.js";
import { readTrustRecords, highestRecord } from "./trust-records.js";
import { loadCanon } from "./canon/index.js";
import { loadPersian, reviewState, checkReview } from "./canon/persian.js";
import { loadConcepts, checkShariahReview } from "./concepts.js";

const readJson = (root, f) => JSON.parse(readFileSync(join(root, f), "utf8"));

export async function contentHashOf(root, kind, kit, ledgerFile) {
  const ledgerSha = sha256(readFileSync(join(root, ledgerFile)));
  if (kind === "persian") {
    const { canon } = loadCanon(root, kit), { cfg } = canon ? loadPersian(root, canon, kit) : {};
    const files = cfg ? reviewState(root, cfg, null).map((s) => ({ file: s.file, sha256: s.sha256 })).sort((a, b) => (a.file < b.file ? -1 : 1)) : [];
    return sha256(canonicalJson({ kind, ledger: ledgerSha, files, scope: cfg ? scopeHash(cfg, canon.persian) : null }));
  }
  if (kind === "shariah") {
    const c = await loadConcepts(root, kit);
    const concepts = c.catalogue ? c.catalogue.concepts.map((k) => ({ id: k.id, hash: approvalHash(c.config, c.catalogue, k) })).sort((a, b) => (a.id < b.id ? -1 : 1)) : [];
    return sha256(canonicalJson({ kind, ledger: ledgerSha, concepts, schedule: (c.schedule?.entries || []).map((e) => ({ id: e.id, date: e.date })) }));
  }
  return sha256(canonicalJson({ kind, ledger: ledgerSha }));
}

/** The trust directories at a commit: the kit's own, and every snapshot root's, from kit.canon.json at that commit (never a literal path). */
const trustDirs = (canonText) => ["packages/core/registry/trust", ...snapshotRoots(vendorOfCanonText(canonText)).map((r) => `${r.snapshot}/packages/core/registry/trust`)];

export function gitSource(root, sha, kit, { record = null } = {}) {
  const show = (path) => git(root, ["show", `${sha}:${path}`]);
  const atSha = () => (git(root, ["rev-parse", "HEAD"])?.trim() === sha ? [] : [`the verifier's copy is not at commit ${sha.slice(0, 12)}`]);
  return {
    // the SAME rule bundled() uses: every record file of the trust directory, the project's HIGHEST seq (an invalid higher one is returned too, so the verifier refuses it instead of falling back)
    async record(project) {
      if (record) return record(project);
      const files = trustDirs(show("kit.canon.json")).flatMap((d) => (git(root, ["ls-tree", "--name-only", sha, `${d}/`]) || "").split("\n").filter(Boolean));
      return highestRecord(readTrustRecords({ files, read: show }), project);   // the same reader as bundled(): an unreadable file fails closed (throws), it is never skipped
    },
    async file(path) { const t = show(path); if (t == null) throw new Error(`${path} is not in ${sha.slice(0, 12)}`); return t; },
    async history() { return []; },   // run inside the full check below, on the same copy
    async contentState(kind, expect) {
      const problems = [...atSha()];
      if (git(root, ["status", "--porcelain"])?.trim()) problems.push("the verifier's copy has uncommitted changes");
      if (!problems.length) {
        if (kind === "persian") { const { canon } = loadCanon(root, kit); if (!canon) problems.push("kit.canon.json: missing or invalid at this commit"); else problems.push(...(await checkReview(root, canon, kit, { local: true })).problems.map((p) => `${p.file}: ${p.problem}`)); }
        else if (kind === "shariah") problems.push(...(await checkShariahReview(root, kit, { local: true })).problems.map((p) => `${p.file}: ${p.problem}`));
      }
      return { hash: await contentHashOf(root, kind, kit, expect.ledger), problems };
    },
  };
}
