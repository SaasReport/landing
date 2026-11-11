// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance.
// scripts/upstream-sync.mjs reports upstream changes since the origin, classified against ORIGIN.json, and never
// applies anything: run against a synthetic upstream repository (git), and against a fake GitHub compare API.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, fromGitHub, main } from "../scripts/upstream-sync.mjs";
import { tempDir } from "../../core/test/support/temp.mjs";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const tree = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? tree(join(d, f)).map((x) => `${f}/${x}`) : [f])).sort();
const snapshot = () => Object.fromEntries(tree(PKG).filter((f) => !f.startsWith("node_modules/")).map((f) => [f, sha(readFileSync(join(PKG, f)))]));

function upstream(t) {
  const dir = tempDir(t, "forge-upstream-");
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "packages/forge/shared"), { recursive: true });
  const files = { "forge.ts": "export class Forge {}\n", "shared/naming.ts": "export const a = 1;\n", "init.ts": "export const init = 1;\n" };
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, "packages/forge", f), c);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "origin");
  const commit = git(dir, "rev-parse", "HEAD").trim();
  const origin = {
    name: "@example/forge", license: "Apache-2.0", copyright: "Example",
    origin: { repository: "example/forge", path: "packages/forge", commit, date: "2026-10-02T00:00:00Z" },
    ported: [{ upstream: "forge.ts", sha256: sha(files["forge.ts"]), port: "src/forge.js" }, { upstream: "shared/naming.ts", sha256: sha(files["shared/naming.ts"]), port: "src/naming.js" }],
    not_ported: [{ upstream: "init.ts", sha256: sha(files["init.ts"]), reason: "overlays: a second source beside the contract" }],
  };
  const originFile = join(dir, "ORIGIN.json");
  writeFileSync(originFile, JSON.stringify(origin));
  return { dir, origin, originFile };
}

test("upstream-sync: nothing changed since the origin → exit 0; the origin files verify", async (t) => {
  const u = upstream(t);
  const out = [], err = [];
  assert.equal(await main(["--source", u.dir, "--ref", "main", "--origin", u.originFile], { out: (s) => out.push(s), err: (s) => err.push(s) }), 0, err.join(""));
  assert.match(out.join(""), /No upstream changes under the origin path/);
});

test("upstream-sync: modified, added, deleted files are classified and diffed, exit 3, and nothing under packages/forge changes", async (t) => {
  const u = upstream(t);
  const before = snapshot();
  writeFileSync(join(u.dir, "packages/forge/forge.ts"), "export class Forge { x = 1 }\n");
  writeFileSync(join(u.dir, "packages/forge/shared/new-thing.ts"), "export const n = 2;\n");
  rmSync(join(u.dir, "packages/forge/init.ts"));
  writeFileSync(join(u.dir, "README.md"), "outside the origin path\n");
  git(u.dir, "add", "-A");
  git(u.dir, "commit", "-qm", "upstream work");
  const out = [], err = [];
  assert.equal(await main(["--source", u.dir, "--origin", u.originFile], { out: (s) => out.push(s), err: (s) => err.push(s) }), 3);
  const r = out.join("");
  assert.match(r, /\| `forge\.ts` \| modified \| `src\/forge\.js` \| review the diff; port what applies \|/);
  assert.match(r, /\| `init\.ts` \| deleted \| not ported \| check the reason still holds: overlays/);
  assert.match(r, /\| `shared\/new-thing\.ts` \| added \| not in ORIGIN\.json \| port it, or record it in not_ported/);
  assert.doesNotMatch(r, /README/, "only the origin path");
  assert.match(r, /```diff\n[\s\S]*\+export class Forge \{ x = 1 \}/);
  assert.match(r, /Nothing has been applied/);
  assert.match(err.join(""), /3 upstream changes since [0-9a-f]{12}; nothing applied/);
  assert.deepEqual(snapshot(), before, "the port is untouched");
  // a report may not be written into the port
  const e2 = [];
  assert.equal(await main(["--source", u.dir, "--origin", u.originFile, "--out", join(PKG, "src", "report.md")], { out: () => {}, err: (s) => e2.push(s) }), 1);
  assert.match(e2.join(""), /inside packages\/forge: upstream-sync only reports/);
  assert.deepEqual(snapshot(), before);
});

test("upstream-sync: an origin file that no longer matches its recorded sha256 is reported", async (t) => {
  const u = upstream(t);
  u.origin.ported[0].sha256 = "0".repeat(64);
  writeFileSync(u.originFile, JSON.stringify(u.origin));
  const out = [];
  assert.equal(await main(["--source", u.dir, "--origin", u.originFile], { out: (s) => out.push(s), err: () => {} }), 3);
  assert.match(out.join(""), /`forge\.ts`: differs from the sha256 ORIGIN\.json records/);
});

test("upstream-sync --github: GitHub's compare API, renamed files follow ORIGIN.json", async () => {
  const origin = { origin: { repository: "example/forge", path: "packages/forge", commit: "a".repeat(40), date: "2026-10-02T00:00:00Z" }, ported: [{ upstream: "shared/naming.ts", port: "src/naming.js" }], not_ported: [] };
  let url;
  const fake = async (u) => { url = u; return new Response(JSON.stringify({ commits: [{ sha: "b".repeat(40) }], files: [
    { filename: "packages/forge/shared/names.ts", previous_filename: "packages/forge/shared/naming.ts", status: "renamed", patch: "@@ -1 +1 @@" },
    { filename: "docs/x.md", status: "modified" },
  ] }), { headers: { "content-type": "application/json" } }); };
  const r = await fromGitHub(origin, "main", fake, "");
  assert.equal(url, `https://api.github.com/repos/example/forge/compare/${"a".repeat(40)}...main`);
  assert.equal(r.resolved, "b".repeat(40));
  assert.deepEqual(classify(origin, r.changes).map((i) => [i.file, i.from, i.status, i.kind, i.port]), [["shared/names.ts", "shared/naming.ts", "renamed", "ported", "src/naming.js"]]);
});
