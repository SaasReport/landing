import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createPublicKey, verify as nodeVerify, randomBytes } from "node:crypto";
import {
  appJwt, pkcs8FromPem, createBroker, createBrokerWorker, memoryStore, verifyChain, signedBytes, validateConfig,
  MERGE_PERMISSIONS, loadConfig, STATUS,
} from "../src/index.js";

const NOW = 1_790_000_000;
const OWNER = "Example-Org";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ACTIONS = 15368; // the app that creates GitHub Actions check runs
const GREEN = [{ name: "test", status: "completed", conclusion: "success", app: { id: ACTIONS } }];

const rsa = (type) => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type, format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const RSA1 = rsa("pkcs1");

function agentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { pub: Buffer.from(raw).toString("base64"), priv: privateKey };
}
const KEYS = { coder: agentKey(), reviewer: agentKey(), other: agentKey(), outsider: agentKey() };
const id = (n) => `kit:agent:example:${n}`;

const CONFIG = {
  project: "example",
  app: { id: 4242, owner: OWNER },
  githubApi: "https://api.github.test",
  repos: ["kit"],
  agents: [
    { id: id("coder"), publicKey: KEYS.coder.pub, actions: ["push", "merge"] },
    { id: id("reviewer"), publicKey: KEYS.reviewer.pub, actions: ["read"], reviewer: true },
    { id: id("other"), publicKey: KEYS.other.pub, actions: ["read"] },
  ],
  actions: { push: { permissions: { contents: "write", pull_requests: "write" } }, read: { permissions: { contents: "read" } } },
  merge: { method: "squash", allowedConclusions: ["success", "skipped"], requiredChecks: [{ name: "test", appId: ACTIONS }], allowedBases: ["main"], reviewMaxAgeSeconds: 3600 },
  freshnessSeconds: 60,
};

const nonce = () => randomBytes(12).toString("base64url");
function signMsg(name, body) {
  const msg = { v: 1, aud: "example", agent: id(name), nonce: nonce(), iat: NOW, ...body };
  return { ...msg, sig: sign(null, signedBytes(msg), KEYS[name].priv).toString("base64") };
}
const review = (name, over = {}) => signMsg(name, { verdict: "clean", for: id("coder"), repo: "kit", pr: 7, base: "main", head: HEAD, ...over });
const mergeReq = (over = {}, rev = review("reviewer")) => signMsg("coder", { action: "merge", repo: "kit", pr: 7, base: "main", head: HEAD, review: rev, ...over });

/** A fake GitHub: records calls, verifies the app JWT with the public key. */
/** The permission each endpoint needs, as GitHub's permission table states it. */
const NEEDS = [
  [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/, ["contents", "write"]],
  [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/, ["pull_requests", "read"]],
  [/^\/repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]+\/check-runs/, ["checks", "read"]],
  [/^\/repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]+\/status$/, ["statuses", "read"]],
];
const covers = (perms, [name, level]) => perms?.[name] === "write" || (level === "read" && perms?.[name] === "read");

function fakeGitHub({ pull = {}, runs = GREEN, grant, status = { state: "pending", total_count: 0 }, mergeStatus = 200, pulls, mergeReply } = {}) {
  const tokens = new Map(); // token → permissions: a call the token does not cover is a 403, as on GitHub
  let pullReads = 0;
  let didMerge = false; // after GitHub's merge, the pull request reads as merged (unless a test says it is stale)
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.replace(CONFIG.githubApi, "");
    const auth = init.headers.authorization.replace("Bearer ", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, auth, body });
    const ok = (b, status = 200) => new Response(b == null ? null : JSON.stringify(b), { status });
    if (path === `/orgs/${OWNER}/installation`) {
      const [h, p, s] = auth.split(".");
      assert.ok(nodeVerify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(RSA1.publicKey), Buffer.from(s, "base64url")), "app JWT verifies");
      return ok({ id: 99 });
    }
    if (path === "/app/installations/99/access_tokens") {
      const permissions = grant || { ...body.permissions, metadata: "read" };
      const token = tokens.size ? `ghs_TEST${tokens.size}` : "ghs_TEST";
      tokens.set(token, permissions);
      return ok({ token, expires_at: "2026-10-07T05:00:00Z", permissions }, 201);
    }
    const need = NEEDS.find(([re]) => re.test(path.split("?")[0]));
    if (need && !covers(tokens.get(auth), need[1])) return ok({ message: "Resource not accessible by integration" }, 403);
    if (path === "/installation/token") return ok(null, 204);
    const prState = () => (didMerge ? { state: "closed", merged: true, merge_commit_sha: "c".repeat(40) } : { state: "open", merged: false });
    if (path === "/repos/Example-Org/kit/pulls/7" && pulls) return ok({ ...prState(), draft: false, mergeable: true, head: { sha: HEAD }, base: { ref: "main" }, ...pulls[Math.min(pullReads++, pulls.length - 1)] });
    if (path === "/repos/Example-Org/kit/pulls/7") return ok({ ...prState(), draft: false, mergeable: true, head: { sha: HEAD }, base: { ref: "main" }, ...pull });
    if (path === `/repos/Example-Org/kit/commits/${HEAD}/status`) return ok(status);
    if (path.startsWith(`/repos/Example-Org/kit/commits/${HEAD}/check-runs`)) return ok({ total_count: runs.length, check_runs: runs });
    if (path === "/repos/Example-Org/kit/pulls/7/merge" && mergeReply) return mergeReply();
    if (path === "/repos/Example-Org/kit/pulls/7/merge" && mergeStatus === 200) didMerge = true;
    if (path === "/repos/Example-Org/kit/pulls/7/merge") return mergeStatus === 200 ? ok({ merged: true, sha: "c".repeat(40) }) : ok({ message: "no" }, mergeStatus);
    return ok({ message: "not found" }, 404);
  };
  return { fetch, calls };
}

const broker = (gh, store = memoryStore(), sleeps = []) => ({
  store, sleeps,
  b: createBroker({ config: CONFIG, privateKey: RSA1.privateKey, store, fetch: gh.fetch, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } }),
});
const rejects = (p, reason) => assert.rejects(p, (e) => e.reason === reason);

test("the example config is a valid kit.broker-config.v1", () => assert.deepEqual(validateConfig(CONFIG), []));

test("PKCS#1 and PKCS#8 keys both sign a JWT GitHub can verify", async () => {
  for (const key of [RSA1, rsa("pkcs8")]) {
    const jwt = await appJwt({ appId: 4242, privateKey: key.privateKey, now: NOW });
    const [h, p, s] = jwt.split(".");
    assert.ok(nodeVerify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(key.publicKey), Buffer.from(s, "base64url")));
    const claims = JSON.parse(Buffer.from(p, "base64url"));
    assert.deepEqual(claims, { iat: NOW - 60, exp: NOW + 540, iss: "4242" });
  }
  assert.equal(pkcs8FromPem(RSA1.privateKey)[0], 0x30);
});

test("a token is scoped to one repository and the action's permissions, and recorded without the token", async () => {
  const gh = fakeGitHub();
  const { b, store } = broker(gh);
  const r = await b.token(signMsg("coder", { action: "push", repo: "kit" }));
  assert.equal(r.token, "ghs_TEST");
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(mint.body, { repositories: ["kit"], permissions: { contents: "write", pull_requests: "write" } });
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].decision, "allow");
  assert.ok(!JSON.stringify(store.records).includes("ghs_TEST"), "evidence never carries the token");
  assert.deepEqual(verifyChain(store.records), []);
});

test("a token wider than asked is revoked at once, refused and recorded", async () => {
  const gh = fakeGitHub({ grant: { contents: "write", administration: "write" } });
  const { b, store } = broker(gh);
  await rejects(b.token(signMsg("coder", { action: "push", repo: "kit" })), "upstream_failed");
  assert.equal(store.records.at(-1).decision, "deny");
  assert.ok(gh.calls.some((c) => c.method === "DELETE" && c.auth === "ghs_TEST"), "the wider token is revoked");
});

test("a request or review signed for another project's broker is refused", async () => {
  const { b, store } = broker(fakeGitHub());
  await rejects(b.token(signMsg("coder", { action: "push", repo: "kit", aud: "elsewhere" })), "bad_signature");
  assert.equal(store.records.length, 0);
  await rejects(b.merge(mergeReq({}, review("reviewer", { aud: "elsewhere" }))), "review_invalid");
});

test("unauthenticated requests are refused without a record", async () => {
  const { b, store } = broker(fakeGitHub());
  await rejects(b.token(signMsg("outsider", { action: "read", repo: "kit" })), "unknown_agent");
  const forged = { ...signMsg("coder", { action: "push", repo: "kit" }), repo: "kit2" };
  await rejects(b.token(forged), "bad_signature");
  await rejects(b.token(signMsg("coder", { action: "push", repo: "kit", iat: NOW - 3600 })), "stale");
  await rejects(b.token({ v: 1 }), "bad_request");
  assert.equal(store.records.length, 0);
});

test("replay, forbidden action and forbidden repository are recorded denies", async () => {
  const { b, store } = broker(fakeGitHub());
  const msg = signMsg("coder", { action: "push", repo: "kit" });
  await b.token(msg);
  await rejects(b.token(msg), "replayed");
  await rejects(b.token(signMsg("other", { action: "push", repo: "kit" })), "forbidden_action");
  await rejects(b.token(signMsg("coder", { action: "push", repo: "elsewhere" })), "forbidden_repo");
  await rejects(b.token(signMsg("coder", { action: "merge", repo: "kit", pr: 7, base: "main", head: HEAD, review: review("reviewer") })), "forbidden_action");
  assert.deepEqual(store.records.map((r) => r.reason), ["token_issued", "replayed", "forbidden_action", "forbidden_repo", "forbidden_action"]);
  assert.deepEqual(verifyChain(store.records), []);
});

test("the broker merges only with a different reviewer, green checks and the exact head, pinned to that sha", async () => {
  const gh = fakeGitHub();
  const { b, store } = broker(gh);
  const r = await b.merge(mergeReq());
  assert.equal(r.merged, true);
  const put = gh.calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body, { sha: HEAD, merge_method: "squash" });
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.deepEqual(mint.body.permissions, MERGE_PERMISSIONS);
  assert.ok(gh.calls.some((c) => c.method === "DELETE"), "the merge token is revoked");
  assert.deepEqual(store.records.map((r) => r.reason), ["merge_admitted", "merged"]);
  assert.equal(store.records.at(-1).reviewer, id("reviewer"));
  assert.equal(store.records.at(-1).merged, "c".repeat(40));
  assert.equal(store.records.at(-1).base, "main");
});

test("merge refusals", async () => {
  const cases = [
    [() => mergeReq({}, review("coder")), "review_invalid", {}],
    [() => mergeReq({}, review("other")), "review_invalid", {}],
    [() => mergeReq({}, review("reviewer", { head: OTHER })), "review_invalid", {}],
    [() => mergeReq({}, review("reviewer", { iat: NOW - 7200 })), "review_invalid", {}],
    [() => mergeReq({}, review("reviewer", { base: "release" })), "review_invalid", {}],
    [() => mergeReq({}, review("reviewer", { pr: 8 })), "review_invalid", {}],
    [() => mergeReq({}, review("reviewer", { repo: "other" })), "review_invalid", {}],
    [() => mergeReq({}, review("reviewer", { for: id("other") })), "review_invalid", {}],
    [() => ({ ...mergeReq(), review: review("reviewer", { head: OTHER }) }), "bad_signature", {}],
    [() => mergeReq({ base: "release" }, review("reviewer", { base: "release" })), "forbidden_repo", {}],
    [() => mergeReq(), "base_moved", { pull: { base: { ref: "release" } } }],
    [() => mergeReq(), "checks_not_green", { runs: [{ ...GREEN[0], name: "lint" }] }],
    [() => mergeReq(), "checks_not_green", { runs: [{ ...GREEN[0], app: { id: 4242 } }] }],
    [() => mergeReq(), "checks_not_green", { runs: [{ ...GREEN[0], app: { id: 999 } }] }],
    [() => mergeReq(), "checks_not_green", { status: { state: "pending", total_count: 1 } }],
    [() => mergeReq(), "checks_not_green", { status: { state: "failure", total_count: 2 } }],
    [() => mergeReq({}, null), "bad_request", {}],
    [() => mergeReq(), "head_moved", { pull: { head: { sha: OTHER } } }],
    [() => mergeReq(), "not_mergeable", { pull: { mergeable: null } }],
    [() => mergeReq(), "not_mergeable", { pull: { draft: true } }],
    [() => mergeReq(), "checks_not_green", { runs: [] }],
    [() => mergeReq(), "checks_not_green", { runs: [...GREEN, { name: "build", status: "in_progress", conclusion: null, app: { id: ACTIONS } }] }],
    [() => mergeReq(), "checks_not_green", { runs: [{ ...GREEN[0], conclusion: "failure" }] }],
  ];
  for (const [make, reason, gh] of cases) {
    const fake = fakeGitHub(gh);
    const { b } = broker(fake);
    const req = make();
    if (req.review === null) delete req.review;
    await rejects(b.merge(req), reason);
    assert.ok(!fake.calls.some((c) => c.method === "PUT"), `${reason}: never merged`);
  }
});

test("a review is single-use, but an early attempt does not burn it", async () => {
  const store = memoryStore();
  const rev = review("reviewer");
  await rejects(broker(fakeGitHub({ runs: [] }), store).b.merge(mergeReq({}, rev)), "checks_not_green");
  await broker(fakeGitHub(), store).b.merge(mergeReq({}, rev));
  // A fresh, still-mergeable pull request state: only the spent review can refuse it.
  await rejects(broker(fakeGitHub(), store).b.merge(mergeReq({}, rev)), "replayed");
});

test("the merge token can read everything the gate reads (a fake that enforces permissions)", async () => {
  const gh = fakeGitHub({ status: { state: "success", total_count: 1 } });
  assert.equal((await broker(gh).b.merge(mergeReq())).merged, true);
  const statusRead = gh.calls.find((c) => c.path.endsWith("/status"));
  assert.ok(statusRead, "the commit status was read");
  const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
  assert.equal(mint.body.permissions.statuses, "read", "with a token that may read it (the fake answers 403 otherwise)");
});

test("a malformed commit status fails closed", async () => {
  await rejects(broker(fakeGitHub({ status: { state: "failure" } })).b.merge(mergeReq()), "upstream_failed");
  await rejects(broker(fakeGitHub({ status: { state: "weird", total_count: 0 } })).b.merge(mergeReq()), "upstream_failed");
});

test("a base changed before the merge is refused; one changed during it is merged, recorded once and warned", async () => {
  const beforeStore = memoryStore();
  const before = fakeGitHub({ pulls: [{}, { base: { ref: "release" } }] });
  await rejects(broker(before, beforeStore).b.merge(mergeReq()), "base_moved");
  assert.ok(!before.calls.some((c) => c.method === "PUT"), "never merged");
  assert.deepEqual(beforeStore.records.map((r) => [r.decision, r.reason]), [["allow", "merge_admitted"], ["deny", "base_moved"]]);

  const store = memoryStore();
  const during = fakeGitHub({ pulls: [{}, {}, { base: { ref: "release" } }] });
  const r = await broker(during, store).b.merge(mergeReq());
  assert.deepEqual([r.merged, r.warning], [true, "merged_wrong_base"], "the merge happened and the answer says so");
  assert.deepEqual(store.records.map((x) => [x.decision, x.reason, x.base, x.reviewedBase ?? null, x.merged ?? null]), [
    ["allow", "merge_admitted", "main", null, null],
    ["allow", "merged_wrong_base", "release", "main", "c".repeat(40)],
  ], "exactly two records, the second saying what GitHub actually did");
  assert.deepEqual(verifyChain(store.records), []);
});

test("a base that cannot be read back after the merge is recorded as unverified, not as the reviewed one", async () => {
  const store = memoryStore();
  const gh = fakeGitHub({ pulls: [{}, {}, { base: null }] });
  const r = await broker(gh, store).b.merge(mergeReq());
  assert.equal(r.warning, "merged_unverified");
  assert.equal(store.records.at(-1).reason, "merged_unverified");
});

test("a merged request whose record cannot be written is evidence_failed, with no contradicting deny", async () => {
  const store = memoryStore();
  const append = store.append.bind(store);
  let n = 0;
  store.append = async (rec, seq) => (++n >= 2 ? false : append(rec, seq));
  await rejects(broker(fakeGitHub(), store).b.merge(mergeReq()), "merged_evidence_failed");
  assert.deepEqual(store.records.map((x) => x.reason), ["merge_admitted"], "no deny claiming nothing was merged");
});

test("GitHub merged but its reply was lost: recorded as merged from the read-back, never as a deny", async () => {
  const done = { merged: true, merge_commit_sha: "d".repeat(40) };
  const lost = [
    () => { throw new TypeError("network"); },
    () => new Response("oops", { status: 502 }),
    () => new Response("not json", { status: 200 }),
  ];
  for (const mergeReply of lost) {
    const store = memoryStore();
    const gh = fakeGitHub({ mergeReply, pulls: [{}, {}, done] });
    const r = await broker(gh, store).b.merge(mergeReq());
    assert.deepEqual([r.merged, r.sha, r.warning], [true, "d".repeat(40), undefined]);
    assert.deepEqual(store.records.map((x) => [x.decision, x.reason, x.merged ?? null]), [["allow", "merge_admitted", null], ["allow", "merged", "d".repeat(40)]]);
  }
});

test("after an unclear failure nothing is ever a deny: a late merge is found by polling, else the outcome is unknown", async () => {
  const late = memoryStore();
  const gh = fakeGitHub({ mergeReply: () => new Response("x", { status: 502 }), pulls: [{}, {}, {}, { merged: true, merge_commit_sha: "d".repeat(40) }] });
  const { b, sleeps } = broker(gh, late);
  const r = await b.merge(mergeReq());
  assert.deepEqual([r.merged, r.sha], [true, "d".repeat(40)]);
  assert.deepEqual(sleeps, [1000], "polled once, then found the merge");
  assert.deepEqual(late.records.map((x) => [x.decision, x.reason]), [["allow", "merge_admitted"], ["allow", "merged"]]);

  const still = memoryStore();
  const open = broker(fakeGitHub({ mergeReply: () => new Response("x", { status: 503 }) }), still);
  await rejects(open.b.merge(mergeReq()), "merge_outcome_unknown");
  assert.deepEqual(open.sleeps, [1000, 3000, 6000]);
  assert.deepEqual(still.records.map((x) => [x.decision, x.reason]), [["allow", "merge_admitted"], ["allow", "merge_outcome_unknown"]], "never a deny");

  const unknown = memoryStore();
  await rejects(broker(fakeGitHub({ mergeReply: () => { throw new TypeError("network"); }, pulls: [{}, {}, { base: null }] }), unknown).b.merge(mergeReq()), "merge_outcome_unknown");
  assert.deepEqual(unknown.records.map((x) => [x.decision, x.reason]), [["allow", "merge_admitted"], ["allow", "merge_outcome_unknown"]]);
});

test("an open pull request's test-merge commit is never recorded as the merge; no known sha is merged_unverified", async () => {
  const store = memoryStore();
  const gh = fakeGitHub({ mergeReply: () => new Response(JSON.stringify({ merged: true }), { status: 200 }), pulls: [{}, {}, { merge_commit_sha: "e".repeat(40) }] });
  const r = await broker(gh, store).b.merge(mergeReq());
  assert.equal(r.sha, undefined);
  assert.equal(r.warning, "merged_unverified");
  assert.equal(store.records.at(-1).merged, undefined);
});

test("a stale read-back after a successful reply is read again, and never confirms a base or commit", async () => {
  const store = memoryStore();
  const stale = { state: "open", merged: false, base: { ref: "release" } };
  const r = await broker(fakeGitHub({ pulls: [{}, {}, stale, stale] }), store).b.merge(mergeReq());
  assert.deepEqual([r.merged, r.warning, r.sha], [true, "merged_unverified", "c".repeat(40)], "GitHub's own sha, base unconfirmed");
  assert.equal(store.records.at(-1).base, "main", "the stale copy's base is not recorded as the merge target");
  assert.equal(store.records.at(-1).reviewedBase, undefined);
});

test("a lost reply then a merged read-back without a merge commit is merged_unverified, with no sha", async () => {
  const store = memoryStore();
  let n = 0;
  const gh = fakeGitHub({ mergeReply: () => { throw new TypeError("network"); } });
  const inner = gh.fetch;
  gh.fetch = async (url, init) => {
    if (url.endsWith("/pulls/7") && init.method === "GET" && ++n >= 3) {
      if (n === 3) return new Response(JSON.stringify({ state: "closed", merged: true, base: { ref: "main" }, head: { sha: HEAD } }), { status: 200 });
      throw new TypeError("network");
    }
    return inner(url, init);
  };
  const r = await broker(gh, store).b.merge(mergeReq());
  assert.deepEqual([r.merged, r.warning, r.sha], [true, "merged_unverified", undefined]);
});

test("the Worker answers 502 merge_outcome_unknown when the outcome cannot be known", async () => {
  const gh = fakeGitHub({ mergeReply: () => { throw new TypeError("network"); } });
  const w = createBrokerWorker({ fetch: gh.fetch, now: () => NOW, store: memoryStore(), sleep: async () => {} });
  const text = JSON.stringify(mergeReq());
  const res = await w.fetch(new Request("https://broker.test/broker/v1/merge", { method: "POST", body: text, headers: { "content-length": String(Buffer.byteLength(text)) } }), { BROKER_CONFIG: JSON.stringify(CONFIG), APP_PRIVATE_KEY: RSA1.privateKey });
  assert.deepEqual([res.status, (await res.json()).error], [502, "merge_outcome_unknown"]);
});

test("an unknown outcome whose record fails is merged_evidence_failed, and the Worker maps the unknown to 502", async () => {
  const store = memoryStore();
  const append = store.append.bind(store);
  let n = 0;
  store.append = async (rec, seq) => (++n >= 2 ? false : append(rec, seq));
  await rejects(broker(fakeGitHub({ mergeReply: () => { throw new TypeError("network"); } }), store).b.merge(mergeReq()), "merged_evidence_failed");
  assert.deepEqual(store.records.map((x) => x.reason), ["merge_admitted"]);
  assert.equal(STATUS.merge_outcome_unknown, 502);
  assert.equal(STATUS.merged_evidence_failed, 500);
});

test("any 4xx from the merge is a refusal without a read-back", async () => {
  for (const status of [403, 404, 405, 409, 422, 429]) {
    const store = memoryStore();
    const gh = fakeGitHub({ mergeStatus: status });
    await assert.rejects(broker(gh, store).b.merge(mergeReq()));
    const putAt = gh.calls.findIndex((c) => c.method === "PUT");
    assert.ok(!gh.calls.slice(putAt + 1).some((c) => c.path.endsWith("/pulls/7")), `${status}: no read-back after a definite refusal`);
    assert.equal(store.records.at(-1).decision, "deny", `${status}: the refusal is recorded`);
  }
});

test("createBroker applies the same config rules as the Worker", () => {
  const writer = { ...CONFIG, agents: [CONFIG.agents[0], { ...CONFIG.agents[1], actions: ["push"] }] };
  assert.throws(() => createBroker({ config: writer, privateKey: RSA1.privateKey, store: memoryStore() }), (e) => e.reason === "config_invalid");
});

test("GitHub refusing the merge maps to the contract's 409s, never to 502", async () => {
  await rejects(broker(fakeGitHub({ mergeStatus: 409 })).b.merge(mergeReq()), "head_moved");
  await rejects(broker(fakeGitHub({ mergeStatus: 405 })).b.merge(mergeReq()), "not_mergeable");
  await rejects(broker(fakeGitHub({ mergeStatus: 403 })).b.merge(mergeReq()), "upstream_failed", "a missing App permission is a setup error");
});

test("the evidence chain detects tampering", async () => {
  const { b, store } = broker(fakeGitHub());
  await b.token(signMsg("coder", { action: "push", repo: "kit" }));
  await b.token(signMsg("coder", { action: "push", repo: "kit" }));
  assert.deepEqual(verifyChain(store.records), []);
  const forged = store.records.map((r) => ({ ...r }));
  forged[0].decision = "deny";
  assert.ok(verifyChain(forged).some((p) => p.includes("hash")));
  assert.ok(verifyChain(store.records.slice(1)).length > 0, "a dropped record breaks the chain");
});

test("an evidence failure revokes the token and returns nothing", async () => {
  const gh = fakeGitHub();
  const store = memoryStore();
  store.append = async () => false;
  const { b } = broker(gh, store);
  await rejects(b.token(signMsg("coder", { action: "push", repo: "kit" })), "evidence_failed");
  assert.ok(gh.calls.some((c) => c.method === "DELETE" && c.auth === "ghs_TEST"));
});

test("the Worker fails closed and serves the contract", async () => {
  const gh = fakeGitHub();
  const w = createBrokerWorker({ fetch: gh.fetch, now: () => NOW, store: memoryStore() });
  const env = { BROKER_CONFIG: JSON.stringify(CONFIG), APP_PRIVATE_KEY: RSA1.privateKey };
  const post = (path, body) => {
    const text = JSON.stringify(body);
    return new Request(`https://broker.test${path}`, { method: "POST", body: text, headers: { "content-length": String(Buffer.byteLength(text)) } });
  };
  assert.equal((await w.fetch(new Request("https://broker.test/broker/v1/health"), env)).status, 200);
  assert.equal((await w.fetch(new Request("https://broker.test/broker/v1/health"), { ...env, APP_PRIVATE_KEY: "" })).status, 500);
  assert.equal((await w.fetch(new Request("https://broker.test/broker/v1/health"), { ...env, BROKER_CONFIG: "{}" })).status, 500);
  const bare = createBrokerWorker({ fetch: gh.fetch, now: () => NOW });
  assert.equal((await bare.fetch(new Request("https://broker.test/broker/v1/health"), env)).status, 500, "no DB bound");
  assert.deepEqual(await (await w.fetch(new Request("https://broker.test/broker/v1/health"), env)).json(), { ok: true, project: "example" });
  assert.equal((await w.fetch(new Request("https://broker.test/broker/v1/token"), env)).status, 405);
  assert.equal((await w.fetch(new Request("https://broker.test/nope"), env)).status, 404);
  const ok = await w.fetch(post("/broker/v1/token", signMsg("coder", { action: "push", repo: "kit" })), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const denied = await w.fetch(post("/broker/v1/merge", mergeReq({}, review("coder"))), env);
  assert.deepEqual([denied.status, (await denied.json()).error], [403, "review_invalid"]);
  const big = new Request("https://broker.test/broker/v1/token", { method: "POST", body: "x".repeat(9000), headers: { "content-length": "9000" } });
  assert.equal((await w.fetch(big, env)).status, 413);
});

test("config refuses shared keys, reviewers that write, unknown actions and agent-writable checks", () => {
  const shared = { ...CONFIG, agents: [CONFIG.agents[0], { ...CONFIG.agents[1], publicKey: CONFIG.agents[0].publicKey }] };
  assert.throws(() => loadConfig({ BROKER_CONFIG: shared }), (e) => e.reason === "config_invalid");
  // The same 32 bytes spelled differently (the last character carries 2 ignored bits): refused by the schema.
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const pub = KEYS.coder.pub;
  const respelled = pub.slice(0, 42) + B64[B64.indexOf(pub[42]) + 1] + "=";
  assert.ok(Buffer.from(respelled, "base64").equals(Buffer.from(pub, "base64")), "same key bytes");
  assert.ok(validateConfig({ ...CONFIG, agents: [{ ...CONFIG.agents[0], publicKey: respelled }] }).length > 0, "a non-canonical spelling is refused");
  const writer = { ...CONFIG, agents: [CONFIG.agents[0], { ...CONFIG.agents[1], actions: ["push"] }] };
  assert.throws(() => loadConfig({ BROKER_CONFIG: writer }), (e) => /reviewer with a write action/.test(e.message));
  const proto = { ...CONFIG, agents: [{ ...CONFIG.agents[0], actions: ["constructor"] }] };
  assert.throws(() => loadConfig({ BROKER_CONFIG: proto }), (e) => e.reason === "config_invalid");
  assert.ok(validateConfig({ ...CONFIG, actions: { push: { permissions: { checks: "write" } } } }).length > 0, "checks:write is never a token permission");
  assert.ok(validateConfig({ ...CONFIG, actions: { push: { permissions: { statuses: "write" } } } }).length > 0, "statuses:write is never a token permission");
  assert.ok(validateConfig({ ...CONFIG, actions: { push: { permissions: { workflows: "write" } } } }).length > 0, "workflows is never a token permission");
  assert.ok(validateConfig({ ...CONFIG, actions: { push: { permissions: { workflows: "read" } } } }).length > 0, "not even read (GitHub has no read level)");
  assert.ok(validateConfig({ ...CONFIG, actions: { push: { permissions: { actions: "write" } } } }).length > 0, "actions:write is never a token permission");
  const unknown = { ...CONFIG, agents: [{ ...CONFIG.agents[0], actions: ["deploy"] }] };
  assert.throws(() => loadConfig({ BROKER_CONFIG: unknown }), (e) => e.reason === "config_invalid");
  assert.ok(validateConfig({ ...CONFIG, actions: { merge: { permissions: { contents: "write" } } } }).length > 0, "merge is never a token action");
});
