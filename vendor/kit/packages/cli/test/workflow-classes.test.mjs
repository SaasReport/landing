// wo-0016, lane 1: the hand-written workflows check (packages/cli/src/canon/workflows.js, deleted) is four finding classes on the
// engine: ci-runner-pinned, ci-action-pinned, ci-workflow-exists, ci-canary-expired. These are the cases its own test file
// held (workflows.test.mjs, deleted with it), run against the classes: everything the old check refused is refused, everything
// it passed passes. The forms of each class are findings/<class>/forms.json (proven in findings.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGate } from "../src/canon/findings.js";
import { walk } from "../src/canon/files.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const CLASSES = ["ci-runner-pinned", "ci-action-pinned", "ci-workflow-exists", "ci-canary-expired"];
const CFG = { workflows: { runner: "ubuntu-24.04", canary: { runner: "ubuntu-26.04", review_by: "2026-11-19" } } };
const TODAY = "2026-10-01";

/** A repository holding kit.canon.json and the given workflows, checked by all four classes: [{ id, match, line }]. */
async function check(t, workflows, { config = CFG, today = TODAY, now, extra = {} } = {}) {
  const root = tempDir(t, "kit-wfc-");
  const files = { "kit.canon.json": JSON.stringify(config), ...extra, ...Object.fromEntries(Object.entries(workflows).map(([f, b]) => [`.github/workflows/${f}`, b])) };
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); }
  const out = [];
  for (const id of CLASSES) for (const f of await runGate(id, root, walk(root), undefined, now ? { now } : { today })) out.push({ id, match: f.match, line: f.line, problem: f.problem });
  return out;
}
const wf = (job) => `name: t\non: [push]\njobs:\n${job}`;
const STEPS = "    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n";

test("a pinned job and a matrix with an allowed-to-fail canary pass", async (t) => {
  assert.deepEqual(await check(t, {
    "a.yml": wf(`  test:\n    runs-on: ubuntu-24.04\n${STEPS}`),
    "b.yml": wf(`  test:\n    strategy:\n      matrix:\n        include:\n          - runner: ubuntu-24.04\n            canary: false\n          - runner: ubuntu-26.04\n            canary: true\n    runs-on: \${{ matrix.runner }}\n    continue-on-error: \${{ matrix.canary }}\n${STEPS}`),
    "c.yml": wf(`  canary:\n    runs-on: ubuntu-26.04\n    continue-on-error: true\n${STEPS}  reuse:\n    uses: ./.github/workflows/a.yml\n`),
  }), []);
});

test("no workflow at all is a failure (a repo with no CI); workflows.required: false declares the exception", async (t) => {
  const none = await check(t, {});
  assert.deepEqual(none.map((f) => [f.id, f.match]), [["ci-workflow-exists", "/workflows"]]);
  assert.match(none[0].problem, /no workflow in \.github\/workflows/);
  assert.deepEqual(await check(t, {}, { config: { workflows: { ...CFG.workflows, required: false } } }), []);
});

test("floating labels, other images, blocking canaries and unreadable runners fail", async (t) => {
  const found = await check(t, {
    "a.yml": wf(`  one:\n    runs-on: ubuntu-latest\n${STEPS}  two:\n    runs-on: [self-hosted, linux]\n${STEPS}  three:\n    runs-on: ubuntu-22.04\n${STEPS}  four:\n    runs-on: ubuntu-26.04\n${STEPS}  five:\n${STEPS}  six:\n    runs-on:\n      - windows-latest\n${STEPS}`),
  });
  assert.deepEqual(found.map((f) => f.match).sort(), ["/jobs/five/runs-on", "/jobs/four/continue-on-error", "/jobs/one/runs-on", "/jobs/six/runs-on", "/jobs/three/runs-on", "/jobs/two/runs-on"]);
  assert.ok(found.every((f) => f.id === "ci-runner-pinned" && f.line > 3), JSON.stringify(found));
  assert.match(found.find((f) => f.match === "/jobs/four/continue-on-error").problem, /canary image.*other than the declared one/);
});

test("actions floating on a branch or naming no ref fail; tags, shas and local actions pass", async (t) => {
  const text = "jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: org/x@0123456789abcdef0123456789abcdef01234567\n      - uses: ./local\n      - uses: org/y@main\n      - uses: org/z@master # tracking\n      - uses: org/w\n      - uses: docker://alpine:latest\n";
  const found = (await check(t, { "a.yml": text })).filter((f) => f.id === "ci-action-pinned");
  assert.deepEqual(found.map((f) => f.match), ["/jobs/a/steps/3/uses", "/jobs/a/steps/4/uses", "/jobs/a/steps/5/uses", "/jobs/a/steps/6/uses"]);
  assert.deepEqual(found.map((f) => f.line), [8, 9, 10, 11], "the line of each uses:, from the YAML parser");
});

test("a canary past its review_by fails; the day itself and the days before pass", async (t) => {
  const w = { "a.yml": wf(`  t:\n    runs-on: ubuntu-24.04\n${STEPS}`) };
  const late = await check(t, w, { today: "2026-11-20" });
  assert.deepEqual(late.map((f) => [f.id, f.match]), [["ci-canary-expired", "/workflows/canary/review_by"]]);
  assert.match(late[0].problem, /past its review_by date/);
  assert.deepEqual(await check(t, w, { today: "2026-11-19" }), []);
  assert.deepEqual(await check(t, w, { today: "2026-10-01" }), []);
});

test("the written forms the old reader read: inline and block runs-on, quoted labels, trailing comments", async (t) => {
  const jobs = "  a:\n    runs-on: 'ubuntu-24.04' # pinned\n  b:\n    runs-on: [ubuntu-24.04]\n  c:\n    runs-on:\n      - \"ubuntu-24.04\"\n";
  assert.deepEqual(await check(t, { "a.yml": wf(jobs + STEPS) }), []);
});

test("narrower than the old reader, on purpose: the matrix key is runner (the declared convention), so ${{ matrix.os }} is refused", async (t) => {
  const found = await check(t, { "a.yml": wf("  b:\n    strategy:\n      matrix:\n        os: [ubuntu-24.04, ubuntu-26.04]\n    runs-on: ${{ matrix.os }}\n" + STEPS) });
  assert.deepEqual(found.map((f) => f.match), ["/jobs/b/runs-on"]);
});

test("fail closed: a workflow the YAML parser cannot read is a finding, and so is a repository that does not bind the runner", async (t) => {
  const bad = await check(t, { "a.yml": "jobs: [\n" });
  assert.ok(bad.some((f) => f.match === "parse error"), JSON.stringify(bad));
  const unbound = await check(t, { "a.yml": wf(`  t:\n    runs-on: ubuntu-24.04\n${STEPS}`) }, { config: {} });
  assert.ok(unbound.some((f) => f.id === "ci-runner-pinned" && f.match === "unbound runner"), JSON.stringify(unbound));
});

// ---- #124 review (one test per finding; each failed before its fix, see the commit)

const job = (extra) => wf(`  t:\n${extra}${STEPS}`);

test("review 1: the canary's continue-on-error is exactly the declared shape; ${{ false }} and every other spelling is refused", async (t) => {
  for (const coe of ["${{ false }}", "${{ true && false }}", "${{ matrix.other }}", "false", "'true'", "${{ true }}", "${{ !true }}", "''"]) {
    const found = await check(t, { "a.yml": job(`    runs-on: ubuntu-26.04\n    continue-on-error: ${coe}\n`) });
    assert.deepEqual(found.map((f) => [f.id, f.match]), [["ci-runner-pinned", "/jobs/t/continue-on-error"]], coe);
    assert.match(found[0].problem, /canary image.*other than the declared one.*\$\{\{ false \}\}/, coe);
  }
  // the matrix form: the canary leg is flagged true, the pinned legs false, the expression written exactly so
  const legs = (canary, pinned) => `    strategy:\n      matrix:\n        include:\n          - runner: ubuntu-24.04\n            canary: ${pinned}\n          - runner: ubuntu-26.04\n            canary: ${canary}\n    runs-on: \${{ matrix.runner }}\n`;
  assert.deepEqual(await check(t, { "a.yml": job(legs(true, false) + "    continue-on-error: ${{ matrix.canary }}\n") }), []);
  for (const [text, at] of [
    [legs(false, false) + "    continue-on-error: ${{ matrix.canary }}\n", "/jobs/t/strategy/matrix/include/1/canary"],   // the canary leg blocks
    [legs(true, true) + "    continue-on-error: ${{ matrix.canary }}\n", "/jobs/t/strategy/matrix/include/0/canary"],        // the pinned leg cannot fail
    [legs(true, false) + "    continue-on-error: ${{ false }}\n", "/jobs/t/continue-on-error"],
    [legs(true, false) + "    continue-on-error: true\n", "/jobs/t/continue-on-error"],                                          // the pinned leg cannot fail either
    [legs(true, false), "/jobs/t/continue-on-error"],
  ]) assert.deepEqual((await check(t, { "a.yml": job(text) })).map((f) => f.match), [at], text);
});

test("review 5: no workflows block is NOT CONFIGURED and fails; only a repository with no .github/workflows says so with the declared reason", async (t) => {
  const NA = { notApplicable: { workflows: { predicate: "no-workflows" } } };
  const yml = { "a.yml": wf(`  t:\n    runs-on: ubuntu-24.04\n${STEPS}`) };
  for (const [what, workflows, config] of [["no workflows block, no workflow", {}, { project: "x" }], ["no workflows block, a workflow", yml, { project: "x" }], ["an empty block of declarations", {}, { notApplicable: {} }], ["a free-text reason", {}, { notApplicable: { workflows: { reason: "no CI here" } } }], ["another check's predicate", {}, { notApplicable: { workflows: { predicate: "no-vendored-kit" } } }], ["the reason over a repository that has a workflow", yml, NA], ["the reason beside a declared policy", {}, { ...CFG, ...NA }]]) {
    const found = (await check(t, workflows, { config })).filter((f) => f.id === "ci-workflow-exists");
    assert.ok(found.length, `${what}: lets through`);
    assert.match(found[0].problem, /NOT CONFIGURED/, what);
    assert.match(found[0].problem, /"predicate": "no-workflows"/, what);
  }
  assert.deepEqual(await check(t, {}, { config: { project: "x", ...NA } }), [], "no .github/workflows at all, declared as such");
  assert.deepEqual(await check(t, {}, { config: { project: "x", ...NA }, extra: { "README.md": "no CI\n" } }), []);
});

test("review 6: runs-on as matrix.os, inputs.runner or a group/labels object is refused with its own message, never a crash and never a pass", async (t) => {
  const cases = [
    ["runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-24.04]", /expression other than \$\{\{ matrix\.runner \}\}/],
    ["runs-on: ${{ inputs.runner }}", /expression other than \$\{\{ matrix\.runner \}\}/],
    ["runs-on: ${{matrix.runner}}\n    strategy:\n      matrix:\n        runner: [ubuntu-24.04]", /expression other than \$\{\{ matrix\.runner \}\}.*written exactly so/],
    ["runs-on:\n      group: ci-group\n      labels: ubuntu-24.04", /runner group or labels object/],
    ["runs-on: { group: ci-group }", /runner group or labels object/],
    ["runs-on: [ubuntu-24.04, '${{ inputs.label }}']", /label that is not the one runner image/],
    ["runs-on: ~", /label that is not the one runner image/],
  ];
  for (const [runsOn, message] of cases) {
    const found = await check(t, { "a.yml": job(`    ${runsOn}\n`) });
    assert.equal(found.length, 1, `${runsOn}: ${JSON.stringify(found)}`);
    assert.equal(found[0].id, "ci-runner-pinned");
    assert.equal(found[0].match, "/jobs/t/runs-on");
    assert.match(found[0].problem, message, runsOn);
  }
});

test("review 3: workflows.branch_refs is read with its declared shape; a string, a mixed list, an empty or duplicate list is a finding, never coerced", async (t) => {
  const uses = { "a.yml": wf(`  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: org/x@v1\n`) };
  for (const refs of ["main", ["main", 3], [], [""], null, { main: true }, ["main", "main"]]) {
    const found = (await check(t, uses, { config: { workflows: { ...CFG.workflows, branch_refs: refs } } })).filter((f) => f.id === "ci-action-pinned");
    assert.equal(found.length, 1, JSON.stringify(refs));
    assert.equal(found[0].match, "unbound branch_refs", JSON.stringify(refs));
    assert.match(found[0].problem, /\/workflows\/branch_refs is not the declared shape/);
  }
  const ok = (refs, ref) => check(t, { "a.yml": wf(`  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: org/x@${ref}\n`) }, { config: { workflows: { ...CFG.workflows, branch_refs: refs } } });
  assert.deepEqual(await ok(["release"], "main"), [], "the declared list replaces the default");
  assert.equal((await ok(["release"], "release")).length, 1);
});

test("review 4: a canary with no review_by date never expires, so it is a finding of its own; the date is required", async (t) => {
  const w = { "a.yml": wf(`  t:\n    runs-on: ubuntu-24.04\n${STEPS}`) };
  for (const canary of [{ runner: "ubuntu-26.04" }, { runner: "ubuntu-26.04", review_by: null }, { runner: "ubuntu-26.04", review_by: 20991231 }]) {
    const found = (await check(t, w, { config: { workflows: { runner: "ubuntu-24.04", canary } } })).filter((f) => f.id === "ci-canary-expired");
    assert.equal(found.length >= 1, true, JSON.stringify(canary));
    assert.ok(found.every((f) => f.match.startsWith("/workflows/canary")), JSON.stringify(found));
  }
  const missing = (await check(t, w, { config: { workflows: { runner: "ubuntu-24.04", canary: { runner: "ubuntu-26.04" } } } })).filter((f) => f.id === "ci-canary-expired");
  assert.match(missing[0].problem, /declares no review_by date/);
});

test("review 7: today is the UTC date of the clock it is given, not the machine's zone: across a date boundary, in zones on both sides of UTC", async (t) => {
  const w = { "a.yml": wf(`  t:\n    runs-on: ubuntu-24.04\n${STEPS}`) };
  const at = (iso) => check(t, w, { now: new Date(iso) });                     // CFG: review_by 2026-11-19
  const zone = process.env.TZ;
  try {
    for (const tz of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Tehran", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      assert.deepEqual(await at("2026-11-19T23:59:59.999Z"), [], `${tz}: the last instant of the day`);
      const next = await at("2026-11-20T00:00:00.000Z");
      assert.deepEqual(next.map((f) => f.id), ["ci-canary-expired"], `${tz}: the first instant of the next day`);
      assert.deepEqual(await at("2026-11-19T00:00:00.000Z"), [], `${tz}: the day itself, from its first instant`);
    }
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});

test("confirming review 5: a branch ref is compared without regard to case and the refs/heads/ and refs/tags/ forms are refused", async (t) => {
  const at = (ref, config) => check(t, { "a.yml": wf(`  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: org/x@${ref}\n`) }, config ? { config } : {});
  for (const ref of ["Main", "MASTER", "Head", "Trunk", "refs/heads/main", "refs/heads/feature", "refs/tags/v1"]) {
    const found = (await at(ref)).filter((f) => f.id === "ci-action-pinned");
    assert.deepEqual(found.map((f) => f.match), ["/jobs/t/steps/0/uses"], ref);
  }
  assert.equal((await at("RELEASE", { workflows: { ...CFG.workflows, branch_refs: ["release"] } })).length, 1, "the declared list is case-blind too");
  for (const ref of ["v1", "mainline", "v1.2.3", "0123456789abcdef0123456789abcdef01234567"]) assert.deepEqual(await at(ref), [], ref);
});

test("confirming review 3: a missing kit.canon.json fails the canon run (loadCanon), so no class has to guess at a repository with no canon", async (t) => {
  const { runCanon } = await import("../src/canon/index.js");
  const root = tempDir(t, "kit-nocanon-");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/a.yml"), wf(`  t:\n    runs-on: ubuntu-24.04\n${STEPS}`));
  const r = await runCanon(root);
  assert.equal(r.ok, false);
  assert.match(r.results.canon.problems[0].problem, /missing: every repository declares its canon/);
});
