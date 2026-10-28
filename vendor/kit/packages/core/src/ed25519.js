/**
 * Ed25519 for the approval ledger.
 *
 *   - VERIFICATION is WebCrypto (`crypto.subtle.verify("Ed25519")`: Workers, Node 20+, browsers): asynchronous, no hand-written signature code.
 *   - What WebCrypto does not refuse is refused BEFORE it is asked, by `checkPublicKey` / `checkSignature`, which need only the encodings and
 *     the curve's point arithmetic (kept here for exactly that): one canonical base64 spelling only (no alternative spelling of the same bytes),
 *     a public key that is a real point of the prime-order group (not the identity, not a small-order or mixed-order point, y < p), a signature
 *     with s < L (no malleable s + L) whose R is a canonical point of that group (the identity signature, which verifies for any message
 *     under a small-order key, is refused). RFC 8032 section 7.1 vectors, small-order keys, s + L and non-canonical encodings are tests.
 */
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a, m = P) => ((a % m) + m) % m;
const pow = (b, e, m = P) => { let r = 1n; b = mod(b, m); for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; } return r; };
const inv = (a) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

function recoverX(y, sign) {
  if (y >= P) return null;
  const x2 = mod((y * y - 1n) * inv(D * y * y + 1n));
  if (x2 === 0n) return sign ? null : 0n;
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  if (mod(x * x - x2) !== 0n) return null;
  return (Number(x & 1n) !== sign) ? P - x : x;
}
function add(p, q) {
  const A = mod((p[1] - p[0]) * (q[1] - q[0])), B = mod((p[1] + p[0]) * (q[1] + q[0]));
  const C = mod(2n * p[3] * q[3] * D), Dd = mod(2n * p[2] * q[2]);
  const E = B - A, F = Dd - C, G = Dd + C, H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
const dbl = (p) => add(p, p);
const mulBy = (s, p) => { let q = [0n, 1n, 1n, 0n]; for (; s > 0n; s >>= 1n) { if (s & 1n) q = add(q, p); p = dbl(p); } return q; };
const le = (bytes) => { let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n; };
const isIdentity = (p) => mod(p[0]) === 0n && mod(p[1] - p[2]) === 0n;

/** A canonical point of the prime-order subgroup, or null. Refuses y >= p, off-curve, the identity and any point with a small-order component. */
function subgroupPoint(b) {
  if (b.length !== 32) return null;
  const y = le(b) & ((1n << 255n) - 1n), sign = b[31] >> 7;
  if (y >= P) return null;                                 // non-canonical y
  const x = recoverX(y, sign);
  if (x === null) return null;
  const pt = [x, y, 1n, mod(x * y)];
  if (isIdentity(pt)) return null;
  if (!isIdentity(mulBy(L, pt))) return null;               // L*P != identity: a small-order or mixed-order point
  return pt;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Strict base64: standard alphabet, padded, and the one spelling of those bytes (re-encoding gives the same string). → bytes | null */
export function canonicalBase64(s) {
  if (typeof s !== "string" || !B64.test(s) || s.length % 4 !== 0) return null;
  try {
    const bin = atob(s), bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return btoa(String.fromCharCode(...bytes)) === s ? bytes : null;
  } catch { return null; /* undecodable base64 is no value: every caller refuses a null */ }
}
export const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

/** → null when the public key is acceptable, else the reason. */
export function checkPublicKey(publicKeyB64) {
  const b = canonicalBase64(publicKeyB64);
  if (!b || b.length !== 32) return "not the one canonical base64 spelling of 32 bytes";
  return subgroupPoint(b) ? null : "not a point of the prime-order group (identity, small-order, mixed-order or non-canonical)";
}
/** → null when the signature's encoding is acceptable, else the reason. */
export function checkSignature(sigB64) {
  const b = canonicalBase64(sigB64);
  if (!b || b.length !== 64) return "not the one canonical base64 spelling of 64 bytes";
  if (!subgroupPoint(b.subarray(0, 32))) return "R is not a canonical point of the prime-order group (the identity signature is refused)";
  if (le(b.subarray(32)) >= L) return "s is not below the group order (malleable s + L)";
  return null;
}

const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;
const keys = new Map();
/**
 * Is `sigB64` a valid Ed25519 signature of `message` (string, UTF-8, or bytes) under `publicKeyB64`? Encodings are checked first (above), then
 * WebCrypto verifies. Never throws; resolves false on anything wrong.
 */
export async function ed25519Verify(publicKeyB64, message, sigB64) {
  try {
    if (checkPublicKey(publicKeyB64) || checkSignature(sigB64)) return false;
    const s = subtle();
    if (!s) return false;
    if (!keys.has(publicKeyB64)) keys.set(publicKeyB64, s.importKey("raw", canonicalBase64(publicKeyB64), { name: "Ed25519" }, false, ["verify"]));
    const key = await keys.get(publicKeyB64);
    return await s.verify({ name: "Ed25519" }, key, canonicalBase64(sigB64), typeof message === "string" ? new TextEncoder().encode(message) : message);
  } catch { return false; /* a key or signature that cannot be imported or checked does not verify: refused */ }
}
