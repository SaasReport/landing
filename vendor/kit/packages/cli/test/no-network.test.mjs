// The test run has no network (packages/cli/scripts/no-network.mjs, preloaded by npm test): no test can depend on a live URL. On
// 2026-10-14 three tests passed locally and failed in CI because vendor-stale fetched a registry URL that CI could not read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { runInTemp, NO_NETWORK } from "../scripts/test-run.mjs";
import { staleProblems } from "../src/vendor-stale.js";
import { useHeadDoc } from "./support/head-doc.mjs";

const SHA = "a".repeat(40);
const manifest = { source: { repository: "https://github.com/SaasReport/kit", ref: "main", commit: SHA, commit_date: "2026-10-09T00:00:00.000Z" } };

test("must-fail: with the guard preloaded, fetch and a TCP connection to a remote host throw; this machine stays reachable", () => {
  const code = `
    const out = {};
    try { await fetch("https://kit-head.invalid/kit-main.json"); out.fetch = "reached"; } catch (e) { out.fetch = e.message; }
    try { (await import("node:net")).connect({ host: "93.184.216.34", port: 443 }).on("error", () => {}); out.socket = "reached"; } catch (e) { out.socket = e.message; }
    try { await fetch("http://127.0.0.1:9/"); } catch (e) { out.local = /network disabled/.test(e.message + (e.cause?.message ?? "")) ? "refused" : "allowed"; }
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--import", NO_NETWORK, "--input-type=module", "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.fetch, /network disabled/);
  assert.match(out.socket, /network disabled/);
  assert.equal(out.local, "allowed", "loopback is the tests' own servers");
});

test("the test-run harness hands every step the guard (NODE_OPTIONS --import) and says so", () => {
  let seen;
  runInTemp([["x", []]], { spawn: (_c, _a, o) => { seen = o.env; return { status: 0 }; }, env: { PATH: "/bin", NODE_OPTIONS: "--no-warnings" } });
  assert.ok(seen.NODE_OPTIONS.includes(`--import ${NO_NETWORK}`) && seen.NODE_OPTIONS.startsWith("--no-warnings "));
  assert.equal(seen.KIT_TEST_NO_NETWORK, "1");
});

test("under npm test this very process has no network (a live registry URL is refused)", { skip: process.env.KIT_TEST_NO_NETWORK !== "1" && "run by npm test only" }, async () => {
  await assert.rejects(fetch("https://kit-head.invalid/kit-main.json"), /network disabled/);
  assert.throws(() => net.connect({ host: "93.184.216.34", port: 443 }), /network disabled/);
});

test("KIT_HEAD_DOC: read from a file under the test runner only; refused anywhere else, never obeyed or ignored", async () => {
  const file = join(fileTempDir("kit-head-doc-"), "head.json");
  writeFileSync(file, JSON.stringify({ v: 1, repository: "https://github.com/SaasReport/kit", ref: "main", sha: SHA, date: "2026-10-13T00:00:00.000Z", recent: [{ sha: SHA, date: "2026-10-13T00:00:00.000Z" }] }));
  const deps = { ci: true, fetch: async () => { throw new Error("no network"); } };
  const outside = await staleProblems(manifest, {}, { ...deps, env: { KIT_HEAD_DOC: file } });
  assert.equal(outside.problems.length, 1);
  assert.match(outside.problems[0], /KIT_HEAD_DOC is set outside the kit's test run/);
  const inside = await staleProblems(manifest, {}, { ...deps, env: { KIT_HEAD_DOC: file, NODE_TEST_CONTEXT: "child-v8" } });
  assert.deepEqual([inside.problems, inside.behind], [[], 0]);
  const missing = await staleProblems(manifest, {}, { ...deps, env: { KIT_HEAD_DOC: `${file}.nope`, NODE_TEST_CONTEXT: "child-v8" } });
  assert.equal(missing.problems.length, 1, "an unreadable head file fails closed in CI");
  // the helper tests use
  const via = useHeadDoc(SHA);
  assert.equal(process.env.KIT_HEAD_DOC, via);
  delete process.env.KIT_HEAD_DOC;
});
