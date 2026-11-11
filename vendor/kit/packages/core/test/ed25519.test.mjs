// Ed25519: WebCrypto verification behind strict encoding checks. RFC 8032 vectors, small-order and mixed-order keys, the identity signature,
// s + L, non-canonical points, and the one canonical base64 spelling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify as nodeVerify, generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { ed25519Verify, checkPublicKey, checkSignature, canonicalBase64 } from "../src/ed25519.js";

const hx = (h) => Buffer.from(h, "hex"), b64 = (b) => Buffer.from(b).toString("base64");
const P = 2n ** 255n - 19n, L = 2n ** 252n + 27742317777372353535851937790883648493n;
const leB = (n, len = 32) => { const o = Buffer.alloc(len); for (let i = 0; i < len; i++) { o[i] = Number(n & 0xffn); n >>= 8n; } return o; };
const le = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const pubOf = (k) => Buffer.from(k.export({ format: "jwk" }).x, "base64url");
const nodeOk = (pk, m, s) => { try { return nodeVerify(null, Buffer.from(m), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pk).toString("base64url") }, format: "jwk" }), Buffer.from(s)); } catch { return false; /* the reference implementation throwing on bad input means it rejects it */ } };

const VECTORS = [
  ["d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "", "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"],
  ["3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72", "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"],
  ["fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82", "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"],
];
test("RFC 8032 section 7.1 vectors verify, and a flipped bit does not", async () => {
  for (const [pk, m, s] of VECTORS) {
    assert.equal(await ed25519Verify(b64(hx(pk)), hx(m), b64(hx(s))), true);
    const bad = hx(s); bad[3] ^= 1;
    assert.equal(await ed25519Verify(b64(hx(pk)), hx(m), b64(bad)), false);
    assert.equal(checkPublicKey(b64(hx(pk))), null); assert.equal(checkSignature(b64(hx(s))), null);
  }
});
test("verifies what node signs, refuses tampering and another key, and agrees with node on random input", async () => {
  let mism = 0;
  for (let i = 0; i < 60; i++) {
    const kp = generateKeyPairSync("ed25519"), pk = pubOf(kp.publicKey), m = randomBytes(i), sg = sign(null, m, kp.privateKey);
    assert.equal(await ed25519Verify(b64(pk), m, b64(sg)), true);
    const t = Buffer.from(sg); t[(i * 7) % 64] ^= 1 << (i % 8);
    if ((await ed25519Verify(b64(pk), m, b64(t))) !== nodeOk(pk, m, t)) mism++;
    assert.equal(await ed25519Verify(b64(pubOf(generateKeyPairSync("ed25519").publicKey)), m, b64(sg)), false);
  }
  assert.equal(mism, 0);
});
test("the identity signature and small-order / mixed-order / identity keys are refused (they verify for any message in a bare implementation)", async () => {
  const ident = leB(1n), forged = Buffer.concat([ident, leB(0n)]);
  assert.equal(nodeOk(ident, "anything", forged), true, "node accepts it: the reason the kit checks first");
  assert.equal(await ed25519Verify(b64(ident), "anything", b64(forged)), false);
  assert.match(checkPublicKey(b64(ident)), /prime-order group/);
  const orderTwo = leB(P - 1n), orderFour = leB(0n), signed = (() => { const b = leB(0n); b[31] |= 0x80; return b; })();
  for (const k of [orderTwo, orderFour, signed]) { assert.match(checkPublicKey(b64(k)), /prime-order group/); for (let i = 0; i < 16; i++) assert.equal(await ed25519Verify(b64(k), `m${i}`, b64(Buffer.concat([ident, leB(0n)]))), false); }
  // mixed order: a real key plus a small-order point (8-torsion)
  assert.match(checkSignature(b64(Buffer.concat([ident, leB(0n)]))), /R is not a canonical point/);
});
test("s + L (malleable signature), non-canonical y, and a signature whose R is a non-canonical point are refused", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"), pk = pubOf(publicKey), msg = Buffer.from("hello"), sg = sign(null, msg, privateKey);
  const mal = Buffer.concat([sg.subarray(0, 32), leB(le(sg.subarray(32)) + L)]);
  assert.match(checkSignature(b64(mal)), /s is not below the group order/);
  assert.equal(await ed25519Verify(b64(pk), msg, b64(mal)), false);
  assert.match(checkPublicKey(b64(leB(P + 1n))), /prime-order group/);
  assert.match(checkSignature(b64(Buffer.concat([leB(P + 1n), leB(0n)]))), /R is not/);
});
test("one canonical base64 spelling only: a signature or key with different padding bits is refused though the bytes decode the same", async () => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"), pk = pubOf(publicKey), m = "x", sb = b64(sign(null, Buffer.from(m), privateKey));
  assert.equal(await ed25519Verify(b64(pk), m, sb), true);
  const alt = sb.slice(0, 85) + A[A.indexOf(sb[85]) ^ 1] + "==";
  assert.notEqual(alt, sb);
  assert.equal(Buffer.from(alt, "base64").equals(Buffer.from(sb, "base64")), true, "the same bytes");
  assert.equal(await ed25519Verify(b64(pk), m, alt), false);
  const pb = b64(pk), pAlt = pb.slice(0, 42) + A[A.indexOf(pb[42]) ^ 1] + "=";
  assert.equal(canonicalBase64(pAlt), null);
  assert.match(checkPublicKey(pAlt), /canonical base64/);
  for (const bad of ["", "!!!!", "abc", b64(randomBytes(31)), `${sb} `]) assert.equal(await ed25519Verify(b64(pk), m, bad), false);
});
