/**
 * A GitHub App private key arrives as PEM. GitHub issues PKCS#1 ("RSA PRIVATE KEY"); WebCrypto imports PKCS#8 only,
 * so a PKCS#1 key is wrapped in a PrivateKeyInfo (RFC 5208) with the rsaEncryption algorithm identifier. Nothing here
 * logs or returns key bytes.
 */
import { BrokerError } from "./errors.js";

const RSA_ALG_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
const VERSION_0 = [0x02, 0x01, 0x00];

function derLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const tlv = (tag, body) => [tag, ...derLength(body.length), ...body];

/** The DER bytes of a PEM block, and whether its label says PKCS#1 RSA. */
export function decodePem(pem) {
  const lines = String(pem || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const label = lines.find((l) => l.startsWith("-----BEGIN ")) || "";
  const body = lines.filter((l) => !l.startsWith("-----")).join("");
  if (!body) throw new BrokerError("key_invalid", "the private key is empty");
  let raw;
  try { raw = atob(body); } catch { throw new BrokerError("key_invalid", "the private key is not base64"); }
  const der = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return { der, pkcs1: label.includes(" RSA ") };
}

/** PKCS#8 DER for WebCrypto, from either a PKCS#1 or a PKCS#8 PEM. */
export function pkcs8FromPem(pem) {
  const { der, pkcs1 } = decodePem(pem);
  if (!pkcs1) return der;
  const body = [...VERSION_0, ...RSA_ALG_ID, ...tlv(0x04, [...der])];
  return Uint8Array.from(tlv(0x30, body));
}
