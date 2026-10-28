/**
 * The agent's side: sign a broker request (or a review) with the agent's own Ed25519 key. The key is the agent's
 * identity (its kit agent id is bound to the public half in the broker config); it never grants anything on GitHub by
 * itself. `privateKey` is a WebCrypto CryptoKey (Ed25519, "sign").
 */
import { signedBytes } from "./verify.js";

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

export function newNonce() {
  const raw = crypto.getRandomValues(new Uint8Array(18));
  return b64(raw).replace(/\+/g, "-").replace(/\//g, "_");
}

/** A signed message: v, nonce and iat are filled in when absent. */
export async function signRequest(fields, privateKey, now = Math.floor(Date.now() / 1000)) {
  const msg = { v: 1, nonce: newNonce(), iat: now, ...fields };
  delete msg.sig;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, signedBytes(msg)));
  return { ...msg, sig: b64(sig) };
}

/** A reviewer's signed "clean" verdict for exactly one head and base of one pull request, usable only by `forAgent`. */
export const signReview = ({ aud, agent, forAgent, repo, pr, base, head }, privateKey, now) =>
  signRequest({ aud, agent, verdict: "clean", for: forAgent, repo, pr, base, head }, privateKey, now);
