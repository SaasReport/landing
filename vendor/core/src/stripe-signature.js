// Verify a request the Stripe App UI made to our backend (the Stripe-Signature header from fetchStripeSignature).
// Same scheme as Stripe webhooks: header "t=<unix>,v1=<hex hmac-sha256 of `${t}.${payload}` with the app secret>".
// Web Crypto only, so it runs in a Worker. The role claim in the payload is only as good as this check:
// roles seen in the browser are UI hints, never authority.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function equalConstantTime(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/**
 * @param {string} payload the exact signed string (for the default signature: JSON.stringify({user_id, account_id}))
 * @param {string} header the Stripe-Signature header
 * @param {string|string[]} secrets the app signing secret(s); two are valid during rotation
 * @param {{now: number, toleranceSeconds?: number}} opts now is epoch seconds, passed in (no clock here)
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyStripeSignature(payload, header, secrets, { now, toleranceSeconds = 300 }) {
  if (typeof header !== "string" || !header) return { ok: false, reason: "missing signature" };
  if (!Number.isSafeInteger(now)) throw new TypeError("now must be integer epoch seconds");
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")).map(([, v]) => v); // an entry with no value, or not a SHA-256 hex digest, is not a signature
  if (!/^\d+$/.test(t ?? "") || !sigs.length) return { ok: false, reason: "malformed signature" };
  if (Math.abs(now - Number(t)) > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };
  for (const secret of [].concat(secrets)) {
    const expected = await hmacHex(secret, `${t}.${payload}`);
    if (sigs.some((s) => equalConstantTime(s, expected))) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}
