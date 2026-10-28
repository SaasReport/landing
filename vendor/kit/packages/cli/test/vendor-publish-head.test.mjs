// publishHead writes through the Cloudflare R2 data-plane API (R2's S3-compatible request format) with SigV4 (the REST object endpoint refuses a bucket-scoped token, 403, proven 2026-10-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { signV4, publishHead } from "../src/vendor-stale.js";

// the specification's public example key id, assembled so no secret scanner mistakes the documented vector for a credential
const EXAMPLE_KEY_ID = "AK" + "IAIOSFODNN7EXAMPLE";
const sha = (d) => createHash("sha256").update(d).digest("hex");
const ACCOUNT = "0123456789abcdef0123456789abcdef", TOKEN_ID = "fedcba9876543210fedcba9876543210", TOKEN = "test-token-value";
const SHA = "a".repeat(40), DATE = "2026-10-13T10:00:00.000Z";
const doc = { v: 1, repository: "https://github.com/SaasReport/kit", ref: "main", sha: SHA, date: DATE, recent: [{ sha: SHA, date: DATE }] };

test("signV4 reproduces the documented SigV4 example signature (a GET with a Range header)", () => {
  const out = signV4({
    method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { range: "bytes=0-9" }, bodyHash: sha(""),
    accessKeyId: EXAMPLE_KEY_ID, secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", amzDate: "20130524T000000Z",
  });
  assert.equal(out.authorization, `AWS4-HMAC-SHA256 Credential=${EXAMPLE_KEY_ID}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`);
});

test("publishHead PUTs to the R2 data-plane endpoint with the exact URL, headers and a signature over the body", async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response("", { status: 200 }); };
  const now = new Date("2026-10-13T10:11:12.345Z");
  const r = await publishHead(doc, { token: TOKEN, tokenId: TOKEN_ID, accountId: ACCOUNT, bucket: "bkt", key: "kit-main.json", fetch, now });
  assert.deepEqual(r, { bucket: "bkt", key: "kit-main.json", sha: SHA, archive: null });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0], body = JSON.stringify(doc);
  assert.equal(url, `https://${ACCOUNT}.r2.cloudflarestorage.com/bkt/kit-main.json`);
  assert.equal(init.method, "PUT");
  assert.equal(init.body, body);
  const h = init.headers;
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["cache-control"], "no-store");
  assert.equal(h["x-amz-date"], "20261013T101112Z");
  assert.equal(h["x-amz-content-sha256"], sha(body));
  assert.equal(h.host, `${ACCOUNT}.r2.cloudflarestorage.com`);
  assert.ok(h.authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${TOKEN_ID}/20261013/auto/s3/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=`));
  assert.match(h.authorization, /Signature=[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(h).includes(TOKEN), false, "the token value never travels");
  // the secret key is SHA-256 hex of the token: a different token gives a different signature
  const other = [];
  await publishHead(doc, { token: "other", tokenId: TOKEN_ID, accountId: ACCOUNT, bucket: "bkt", key: "kit-main.json", now, fetch: async (u, i) => { other.push(i); return new Response("", { status: 200 }); } });
  assert.notEqual(other[0].headers.authorization, h.authorization);
});

test("publishHead refuses a missing or malformed token id, token or account, and a document off its contract, before any request", async () => {
  const fetch = async () => { throw new Error("must not be called"); };
  const ok = { token: TOKEN, tokenId: TOKEN_ID, accountId: ACCOUNT, bucket: "b", key: "k", fetch };
  for (const tokenId of [undefined, "", "abc", TOKEN_ID.toUpperCase(), `${TOKEN_ID}0`]) await assert.rejects(publishHead(doc, { ...ok, tokenId }), /CLOUDFLARE_API_TOKEN_ID/);
  await assert.rejects(publishHead(doc, { ...ok, token: "" }), /CLOUDFLARE_API_TOKEN and/);
  await assert.rejects(publishHead(doc, { ...ok, accountId: "nope" }), /CLOUDFLARE_ACCOUNT_ID/);
  await assert.rejects(publishHead({ ...doc, sha: "x" }, ok), /off its contract/);
});

test("publishHead fails closed on a non-2xx answer", async () => {
  await assert.rejects(publishHead(doc, { token: TOKEN, tokenId: TOKEN_ID, accountId: ACCOUNT, bucket: "b", key: "k", fetch: async () => new Response("", { status: 403 }) }), /answered 403/);
});

test("with an archive: the archive is PUT first (immutable, gzip), then the head object naming it (key, public url, sha256, bytes); an off-contract key is refused before any PUT", async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response("", { status: 200 }); };
  const now = new Date("2026-10-28T07:00:00.000Z");
  const body = Buffer.from("not really gzip");
  const archive = { key: `kit-${SHA}.tar.gz`, bytes: body.length, sha256: sha(body), body };
  const r = await publishHead(doc, { token: TOKEN, tokenId: TOKEN_ID, accountId: ACCOUNT, bucket: "bkt", key: "kit-main.json", archive, headUrl: "https://pub.example.r2.dev/kit-main.json", fetch, now });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://${ACCOUNT}.r2.cloudflarestorage.com/bkt/kit-${SHA}.tar.gz`);
  assert.equal(calls[0].init.body, body);
  assert.equal(calls[0].init.headers["content-type"], "application/gzip");
  assert.equal(calls[0].init.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(calls[1].url, `https://${ACCOUNT}.r2.cloudflarestorage.com/bkt/kit-main.json`);
  const published = JSON.parse(calls[1].init.body);
  assert.deepEqual(published.archive, { key: archive.key, url: `https://pub.example.r2.dev/kit-${SHA}.tar.gz`, sha256: archive.sha256, bytes: body.length });
  assert.deepEqual(r.archive, published.archive);
  const none = [];
  await assert.rejects(publishHead(doc, { token: TOKEN, tokenId: TOKEN_ID, accountId: ACCOUNT, bucket: "bkt", key: "kit-main.json", archive: { ...archive, key: "kit.tar.gz" }, headUrl: "https://pub.example.r2.dev/kit-main.json", fetch: async (u, i) => { none.push(u); return new Response("", { status: 200 }); }, now }), /off its contract/);
  assert.equal(none.length, 0, "nothing published when the document would be off its contract");
  // the archive PUT failing stops the head object: a head object never names an archive that is not there
  const only = [];
  await assert.rejects(publishHead(doc, { token: TOKEN, tokenId: TOKEN_ID, accountId: ACCOUNT, bucket: "bkt", key: "kit-main.json", archive, headUrl: "https://pub.example.r2.dev/kit-main.json", fetch: async (u) => { only.push(u); return new Response("", { status: 500 }); }, now }), /answered 500/);
  assert.equal(only.length, 1);
});
