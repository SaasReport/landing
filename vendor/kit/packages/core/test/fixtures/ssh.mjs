// Test helper: an OpenSSH SSHSIG signer (what the owner's `ssh-keygen -Y sign -n kit-trust@saasreport` produces), for tests of the trust root.
import { generateKeyPairSync, sign as nodeSign, createHash } from "node:crypto";
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const str = (b) => Buffer.concat([u32(b.length), Buffer.from(b)]);
export function newOwnerKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { privateKey, raw, rawB64: raw.toString("base64"), line: `ssh-ed25519 ${Buffer.concat([str("ssh-ed25519"), str(raw)]).toString("base64")} owner@test` };
}
export function sshSign(ownerKey, message, namespace) {
  const h = createHash("sha512").update(message).digest();
  const signed = Buffer.concat([Buffer.from("SSHSIG"), str(namespace), str(""), str("sha512"), str(h)]);
  const sig = nodeSign(null, signed, ownerKey.privateKey);
  const blob = Buffer.concat([Buffer.from("SSHSIG"), u32(1), str(Buffer.concat([str("ssh-ed25519"), str(ownerKey.raw)])), str(namespace), str(""), str("sha512"), str(Buffer.concat([str("ssh-ed25519"), str(sig)]))]);
  const b64 = blob.toString("base64").match(/.{1,70}/g).join("\n");
  return `-----BEGIN SSH SIGNATURE-----\n${b64}\n-----END SSH SIGNATURE-----`;
}
