/**
 * Who is asking, and is the ask genuine: the agent is registered, the Ed25519 signature over the canonical request
 * verifies with that agent's own key, the request is fresh and its nonce has never been used. Order matters: the
 * cheap structural checks first, the signature before anything is written, the nonce claim last (a forged request
 * cannot burn a real agent's nonce).
 */
import { canonicalJson } from "@saasreport/core/concepts";
import { sha256 } from "@saasreport/core/sha256";
import { BrokerError } from "./errors.js";
import { validateRequest } from "./schemas.js";

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);
const keyCache = new Map();

async function publicKey(b64) {
  if (!keyCache.has(b64)) keyCache.set(b64, crypto.subtle.importKey("raw", fromB64(b64), { name: "Ed25519" }, false, ["verify"]));
  return keyCache.get(b64);
}

const unsigned = ({ sig, ...body }) => body;

/** The canonical bytes an agent signs, and the request digest recorded as evidence. */
export const signedBytes = (msg) => utf8(canonicalJson(unsigned(msg)));
export const requestDigest = (msg) => sha256(canonicalJson(msg));

async function signatureValid(agent, msg) {
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, await publicKey(agent.publicKey), fromB64(msg.sig), signedBytes(msg));
  } catch {
    return false; /* a key or signature that cannot be read does not verify */ }
}

/** The registered agent for a signed message, or a BrokerError. Does not claim the nonce. */
export async function authenticate(config, msg, now) {
  const agent = config.agents.find((a) => a.id === msg.agent);
  if (!agent) throw new BrokerError("unknown_agent");
  if (!(await signatureValid(agent, msg))) throw new BrokerError("bad_signature");
  // Signed for another project's broker: never valid here, whatever its nonce (no cross-broker replay).
  if (msg.aud !== config.project) throw new BrokerError("bad_signature", "signed for another broker");
  if (Math.abs(now - msg.iat) > config.freshnessSeconds) throw new BrokerError("stale");
  return agent;
}

/** Structural check of a request body against kit.broker-request.v1. */
export function parseRequest(body) {
  const problems = validateRequest(body);
  if (problems.length) throw new BrokerError("bad_request", problems.slice(0, 3).join("; "));
  return body;
}

/**
 * The independent review a merge needs: a different, registered reviewer agent signed "clean" for exactly this
 * project, repository, pull request, base and head, naming the one agent (`for`) that may use it. Reviewers hold no
 * write action (loadConfig), so a reviewer never reviews its own work.
 */
export async function verifyReview(config, msg, now) {
  const r = msg.review;
  if (!r) throw new BrokerError("review_required");
  if (r.agent === msg.agent) throw new BrokerError("review_invalid", "the reviewer is the requesting agent");
  const reviewer = config.agents.find((a) => a.id === r.agent);
  if (!reviewer || !reviewer.reviewer) throw new BrokerError("review_invalid", "not a registered reviewer");
  if (!(await signatureValid(reviewer, r))) throw new BrokerError("review_invalid", "bad signature");
  if (r.aud !== config.project) throw new BrokerError("review_invalid", "signed for another broker");
  if (r.for !== msg.agent) throw new BrokerError("review_invalid", "the review names another agent");
  if (r.repo !== msg.repo || r.pr !== msg.pr || r.base !== msg.base || r.head !== msg.head) throw new BrokerError("review_invalid", "the review is for another change");
  if (r.iat > now + config.freshnessSeconds || now - r.iat > config.merge.reviewMaxAgeSeconds) throw new BrokerError("review_invalid", "stale");
  return reviewer;
}
