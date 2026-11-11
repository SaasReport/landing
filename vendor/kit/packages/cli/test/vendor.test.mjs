// kit vendor sync / check: a plain snapshot of the kit at one commit on its main, verified byte for byte.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { syncVendor, checkVendor } from "../src/vendor.js";
import { runCanon } from "../src/canon/index.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { useHeadDoc } from "./support/head-doc.mjs";

let SRC, HEAD;
const TMP = fileTempDir("kit-vendor-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).toString().trim();
before(() => {
  SRC = join(TMP, "kit");
  for (const [f, body] of Object.entries({ "LICENSE": "L", "NOTICE": "N", "packages/a/package.json": "{}", "packages/a/src/x.js": "export const x = 1;\n", "packages/a/bin/a.js": "#!/usr/bin/env node\n", "packages/a/test/t.mjs": "t", "docs/big.md": "d" })) {
    mkdirSync(join(SRC, f, ".."), { recursive: true });
    writeFileSync(join(SRC, f), body);
  }
  chmodSync(join(SRC, "packages/a/bin/a.js"), 0o755);
  git(TMP, "init", "-q", SRC);
  git(SRC, "add", "-A");
  git(SRC, "commit", "-qm", "kit");
  HEAD = git(SRC, "rev-parse", "HEAD");
  git(SRC, "update-ref", "refs/remotes/origin/main", HEAD);
  useHeadDoc(HEAD);   // the head comes from a file: the test run has no network
});

const CFG = { path: "vendor/kit", include: ["packages", "LICENSE", "NOTICE"], exclude: ["packages/a/test"] };
function consumer(name, cfg = CFG) {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "kit.canon.json"), JSON.stringify({ $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", project: "saasreport", vendor: cfg }));
  return root;
}

test("sync writes exactly the included files and a manifest with the commit and sha256 of each", () => {
  const root = consumer("ok");
  const r = syncVendor(root, CFG, { source: SRC, commit: HEAD.slice(0, 7), fetch: false });
  assert.equal(r.commit, HEAD);
  const m = JSON.parse(readFileSync(join(root, "vendor/kit.manifest.json"), "utf8"));
  assert.deepEqual(m.files.map((f) => f.path), ["LICENSE", "NOTICE", "packages/a/bin/a.js", "packages/a/package.json", "packages/a/src/x.js"]);
  assert.equal(m.source.commit, HEAD);
  assert.equal(m.files.find((f) => f.path === "packages/a/bin/a.js").executable, true);
  assert.ok(statSync(join(root, "vendor/kit/packages/a/bin/a.js")).mode & 0o100);
  assert.deepEqual(checkVendor(root, CFG).problems, []);
});

test("check fails on an edited, a missing and an added file, and on a changed include", async () => {
  const root = consumer("edited");
  syncVendor(root, CFG, { source: SRC, commit: HEAD, fetch: false });
  appendFileSync(join(root, "vendor/kit/packages/a/src/x.js"), "// hand edit\n");
  rmSync(join(root, "vendor/kit/NOTICE"));
  writeFileSync(join(root, "vendor/kit/packages/a/extra.js"), "x");
  const msgs = checkVendor(root, CFG).problems.map((p) => `${p.file}: ${p.problem}`).join("\n");
  assert.match(msgs, /x\.js: differs from the manifest/);
  assert.match(msgs, /NOTICE: missing/);
  assert.match(msgs, /extra\.js: not in the manifest/);
  assert.match(checkVendor(root, { ...CFG, include: ["packages"] }).problems[0].problem, /include\/exclude differ/);
  const r = await runCanon(root, { only: ["vendor"] });
  assert.equal(r.results.vendor.ok, false);
});

test("a commit off the kit's main and an include that matches nothing are refused", () => {
  const root = consumer("refused");
  git(SRC, "checkout", "-qb", "side");
  writeFileSync(join(SRC, "LICENSE"), "L2");
  git(SRC, "commit", "-qam", "side");
  const side = git(SRC, "rev-parse", "HEAD");
  git(SRC, "checkout", "-q", "-");
  assert.throws(() => syncVendor(root, CFG, { source: SRC, commit: side, fetch: false }), /not on the kit's main history/);
  assert.throws(() => syncVendor(root, { ...CFG, include: ["nope"] }, { source: SRC, commit: HEAD, fetch: false }), /matches nothing/);
});

test("kit check canon › vendor passes on a fresh snapshot and validates the manifest", async () => {
  const root = consumer("canon");
  syncVendor(root, CFG, { source: SRC, commit: HEAD, fetch: false });
  const r = await runCanon(root, { only: ["vendor"] });
  assert.equal(r.ok, true, JSON.stringify(r.results, null, 2));
  assert.match(r.results.vendor.summary, /^5 files at [0-9a-f]{12}$/);
});

