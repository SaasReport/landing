// Shared helpers of the approval-ledger CLI tests: an OWNER key whose SSH signatures sign trust records (the owner's public key is injected as "published on GitHub";
// nothing in a work tree can supply it), keys made by `kit ledger keygen` in a key directory (the module-private test seam supplies the passphrase and the key
// directory: the shipped CLI has neither), throw-away git repositories, and the CLI run in process.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { generateKeyPairSync, sign as nodeSign, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { main } from "../src/index.js";
import { TEST } from "../src/test-seam.js";

export const PASS = "a long test passphrase 1";
export const OWNER_NAME = "owner-test";
export const REPO = "SaasReport/test-repo";
export const readJson = (root, f) => JSON.parse(readFileSync(join(root, f), "utf8"));
export const writeJson = (root, f, body) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`); };
export const git = (root, ...a) => spawnSync("git", a, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
export const commit = (root, msg = "c") => { git(root, "add", "-A"); const r = git(root, "commit", "-qm", msg, "--allow-empty"); assert.equal(r.status, 0, r.stderr); return git(root, "rev-parse", "HEAD").stdout.trim(); };
export const initRepo = (root) => { mkdirSync(root, { recursive: true }); git(root, "init", "-q", "-b", "main"); };

import { newOwnerKey } from "../../core/test/fixtures/ssh.mjs";
import { makeRecord } from "../../core/test/fixtures/trustrec.mjs";
export const OWNER = newOwnerKey();
/** A trust record signed by the owner (the fixture plays the owner: fingerprints, the supersedes chain and the SSH signature). `approvals` = { concepts?, shariah?, persian?, uploads? }; opts.extra = top-level fields (verifier, signer, checkpoint). */
export function signedRecord(project, approvals, { seq = 1, github = REPO, owner = OWNER_NAME, key = OWNER, extra = {}, supersedes, expires, at } = {}) {
  return makeRecord({ project, approvals, seq, github, owner, key, extra, ...(supersedes !== undefined ? { supersedes } : {}), ...(expires ? { expires } : {}), ...(at ? { at } : {}) });
}
/** The trust the CLI reads (the bundled records), with one owner-signed record for the project. */
export const trustWith = (project, approvals, opts) => ({ records: [signedRecord(project, approvals, opts)] });

let KEYDIR = null;
export const setKeyDir = (d) => { KEYDIR = d; };
/** The seam: the passphrase prompt, the key directory, and the trust anchors a CI/Worker would take from outside the repository. */
export const seamFor = (over = {}) => ({ prompt: async () => PASS, keyDir: KEYDIR, owner: OWNER_NAME, ownerKeys: [OWNER.rawB64], repo: REPO, pin: { minSeq: 1 }, ...over });   // the pin the owner holds next to KIT_OWNER: required whenever a record exists

export const run = async (root, argv, io = {}) => {
  const out = [], err = [];
  const { trust, registry, prompt, seam: extra = {}, ...rest } = io;
  const seam = seamFor({ ...(rest.env ? { pin: undefined } : {}), ...(trust ?? registry ? { trust: trust ?? registry } : {}), ...(prompt ? { prompt } : {}), ...extra });
  const code = await main([...argv, "--cwd", root], { out: (s) => out.push(s), err: (s) => err.push(s), cwd: root, [TEST]: seam, ...rest });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

/** A key from the CLI itself: encrypted PEM in the key directory, and the public key. */
export async function keygen(dir, name) {
  const f = join(KEYDIR, `${name}.pem`);
  const cwd = join(dirname(KEYDIR), "_cwd"); mkdirSync(cwd, { recursive: true });   // a neutral directory: a key is never made inside the tree being worked on
  const r = await run(cwd, ["ledger", "keygen", "--out", f]);
  assert.equal(r.code, 0, r.err);
  return { name, file: f, pub: /publicKey: (\S+)/.exec(r.out)[1] };
}
void nodeSign;

/** What the OWNER pins for a Persian tree as it stands: { baseline, scope } (the fixture plays the owner, who read the copy and the scope). */
export async function persianPins(root) {
  const { reviewState, baselineCandidates } = await import("../src/canon/persian.js"), { baselineHash } = await import("@saasreport/core/ledger"), { scopeHash } = await import("@saasreport/core/scope");
  const cfg = readJson(root, "persian.config.json");
  const files = baselineCandidates(reviewState(root, cfg, null)).map((s) => ({ file: s.file, sha256: s.sha256 }));
  return { baseline: { sha256: baselineHash(files), entries: files.length }, scope: { sha256: scopeHash(cfg) } };
}
