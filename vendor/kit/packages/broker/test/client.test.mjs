import { test } from "node:test";
import assert from "node:assert/strict";
import { signRequest, signReview, authenticate, verifyReview, parseRequest } from "../src/index.js";

test("an agent's WebCrypto signature verifies at the broker, for requests and reviews", async () => {
  const kp = async () => {
    const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    return { k, pub: Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64") };
  };
  const [coder, reviewer] = [await kp(), await kp()];
  const config = {
    project: "example", freshnessSeconds: 60, merge: { reviewMaxAgeSeconds: 3600 },
    agents: [
      { id: "kit:agent:example:coder", publicKey: coder.pub, actions: ["merge"] },
      { id: "kit:agent:example:reviewer", publicKey: reviewer.pub, actions: ["read"], reviewer: true },
    ],
  };
  const now = 1_790_000_000;
  const head = "d".repeat(40);
  const review = await signReview({ aud: "example", agent: "kit:agent:example:reviewer", forAgent: "kit:agent:example:coder", repo: "kit", pr: 3, base: "main", head }, reviewer.k.privateKey, now);
  const msg = parseRequest(await signRequest({ aud: "example", agent: "kit:agent:example:coder", action: "merge", repo: "kit", pr: 3, base: "main", head, review }, coder.k.privateKey, now));
  assert.equal((await authenticate(config, msg, now)).id, "kit:agent:example:coder");
  assert.equal((await verifyReview(config, msg, now)).id, "kit:agent:example:reviewer");
  await assert.rejects(authenticate(config, { ...msg, pr: 4 }, now), (e) => e.reason === "bad_signature");
});
