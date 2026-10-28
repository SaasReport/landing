/**
 * The verifier's VERDICT: a statement the remote verifier SIGNS with its own Ed25519 key, which the owner pins in the signed trust record (`verifier.publicKey`). The deploy gate sends a
 * fresh nonce and believes a verdict only when the signature verifies under that key AND the verdict is bound to exactly what the gate is about to deploy: the repository, the commit,
 * the ledger head, the trust record, the content state and the nonce. An unsigned `{ ok: true }`, a signature by any other key, a replayed verdict or a verdict for another commit
 * is not a verdict.
 *
 *   verdict   { v: 1, repo, sha, ledgerHead: { seq, hash }, recordHash, contentHash, nonce, now, ok }       signed over canonicalJson(verdict), Ed25519, base64
 *   signing key: injected (a CryptoKey, or PKCS8 bytes), never a default: the broker holds it in its own binding.
 */
import { canonicalJson } from "./canonical.js";
import { ed25519Verify, toBase64 } from "./ed25519.js";

export const verdictBody = (v) => canonicalJson({ v: 1, repo: v.repo, sha: v.sha, ledgerHead: v.ledgerHead, recordHash: v.recordHash, contentHash: v.contentHash, nonce: v.nonce, now: v.now, ok: v.ok });

/** → { verdict, signature }. `privateKey`: a CryptoKey (Ed25519, "sign") or PKCS8 bytes. */
export async function signVerdict(verdict, privateKey) {
  if (!privateKey) throw new Error("signVerdict: the verifier's signing key is injected (a binding of the broker), there is no default");
  const key = privateKey instanceof Uint8Array ? await crypto.subtle.importKey("pkcs8", privateKey, { name: "Ed25519" }, false, ["sign"]) : privateKey;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(verdictBody(verdict))));
  return { verdict, signature: toBase64(sig) };
}

export const newNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The gate's side. `signed` = { verdict, signature }; `publicKey` = the key the OWNER-SIGNED record pins; `bind` = what the gate expects:
 * { repo, sha, nonce, ledgerHead, recordHash, contentHash }. → problems[] (empty: the verdict is the pinned verifier's, for exactly this state, and says ok).
 */
export async function verifyVerdict(signed, publicKey, bind) {
  const p = [], v = signed?.verdict;
  if (!v || typeof signed.signature !== "string") return ["the verifier's answer carries no signed verdict (an unsigned { ok: true } is not a verdict): refused"];
  if (!publicKey || !(await ed25519Verify(publicKey, verdictBody(v), signed.signature))) return ["the verdict's signature does not verify under the verifier key the owner-signed record pins: refused"];
  if (String(v.repo).toLowerCase() !== String(bind.repo).toLowerCase()) p.push(`the verdict is for repository ${v.repo}, not ${bind.repo}`);
  if (v.sha !== bind.sha) p.push(`the verdict is for commit ${String(v.sha).slice(0, 12)}, not ${String(bind.sha).slice(0, 12)}`);
  if (v.nonce !== bind.nonce) p.push("the verdict answers another request (nonce differs): a replayed verdict is refused");
  if (v.ledgerHead?.seq !== bind.ledgerHead.seq || v.ledgerHead?.hash !== bind.ledgerHead.hash) p.push("the verdict is for another ledger head");
  if (v.recordHash !== bind.recordHash) p.push("the verdict is for another trust record");
  if (v.contentHash !== bind.contentHash) p.push("the verdict is for another content state (the verifier checked different files than the gate is about to deploy)");
  if (v.ok !== true) p.push("the verifier's signed verdict is: NOT ok" + (Array.isArray(signed.problems) && signed.problems.length ? ` (${signed.problems.slice(0, 3).join("; ")})` : ""));
  return p;
}
