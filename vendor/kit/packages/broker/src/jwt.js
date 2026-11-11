/**
 * The GitHub App JWT (RS256), signed with WebCrypto. GitHub accepts at most ten minutes of validity; the token is
 * back-dated a minute for clock drift. The imported key is non-extractable and cached per PEM string.
 */
import { pkcs8FromPem } from "./pem.js";
import { BrokerError } from "./errors.js";

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const keys = new Map();

export const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = (s) => new TextEncoder().encode(s);

async function signingKey(pem) {
  if (!keys.has(pem)) {
    keys.set(pem, crypto.subtle.importKey("pkcs8", pkcs8FromPem(pem), ALG, false, ["sign"]).catch((e) => {
      keys.delete(pem);
      throw new BrokerError("key_invalid", e.name || "import failed");
    }));
  }
  return keys.get(pem);
}

/** A JWT for the app, valid from now-60s to now+540s (seconds since epoch). */
export async function appJwt({ appId, privateKey, now }) {
  if (!Number.isInteger(appId) || appId <= 0) throw new BrokerError("config_invalid", "app.id");
  const header = base64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(utf8(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) })));
  const key = await signingKey(privateKey);
  const sig = new Uint8Array(await crypto.subtle.sign(ALG, key, utf8(`${header}.${payload}`)));
  return `${header}.${payload}.${base64url(sig)}`;
}
