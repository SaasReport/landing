// The vendored package graph: one resolver for kit vendor sync, kit check vendor and kit check lockfile, reading vendor.path from the config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { vendorGraph, graphProblems, missingDeclarations, edgesOf, normalPath } from "../src/vendor-graph.js";
import { syncVendor, checkVendor } from "../src/vendor.js";
import { lockfileProblems } from "../src/canon/lockfile.js";

import { fileTempDir } from "../../core/test/support/temp.mjs";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TMP = fileTempDir("kit-vgraph-");
let n = 0;
const w = (p, v) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v, null, 2)); };
/** A consumer whose snapshot holds these packages: { name: { version, ...package.json fields } } under <path>/packages/<dir>. */
function consumer(pkgs, { path = "vendor/kit", rootDeps = {}, lock } = {}) {
  const d = join(TMP, `c${++n}`);
  for (const [name, p] of Object.entries(pkgs)) w(join(d, path, "packages", name.replace(/^@[^/]+\//, ""), "package.json"), { name, version: "1.0.0", ...p });
  w(join(d, "package.json"), { name: "site", dependencies: rootDeps });
  if (lock) w(join(d, "package-lock.json"), { lockfileVersion: 3, packages: lock });
  return d;
}
const text = (ps) => ps.map((p) => `${p.file}: ${p.problem}`).join("\n");

// -- the real kit package graph ----------------------------------------------------------------------------------------
function realPackages() {
  const out = {};
  for (const d of readdirSync(join(REPO, "packages"), { withFileTypes: true })) {
    const f = join(REPO, "packages", d.name, "package.json");
    if (d.isDirectory() && existsSync(f)) { const p = JSON.parse(readFileSync(f, "utf8")); out[p.name] = p; }
  }
  return out;
}
test("the real kit graph, generated from this repository's packages: every @saasreport dependency is needed, none unresolvable, whatever vendor.path is", () => {
  const real = realPackages();
  const names = new Set(Object.keys(real));
  const targets = (p) => ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((k) => Object.keys(p[k] || {})).filter((d) => names.has(d));
  const every = new Set(Object.values(real).flatMap(targets));
  // the project declares ONE kit package; what is installed is the closure of that declaration, computed here independently of the resolver
  const declared = "@saasreport/uploads";
  const expected = new Set(), todo = [declared];
  while (todo.length) for (const d of targets(real[todo.pop()])) if (!expected.has(d)) { expected.add(d); todo.push(d); }
  assert.ok(expected.has("@saasreport/core"), "the real graph has the edges the 404 came from");
  assert.ok(expected.size && expected.size < every.size, "the closure of one declaration is smaller than every edge target of the snapshot: this test would catch a resolver that returns all of them");
  for (const path of ["vendor/kit", "third_party/kit"]) {
    const d = consumer(Object.fromEntries(Object.entries(real).map(([k, p]) => [k, { ...p, name: k }])), { path, rootDeps: { [declared]: `file:${path}/packages/${declared.replace(/^@[^/]+\//, "")}` } });
    const g = vendorGraph(d, { path });
    assert.deepEqual(g.problems, [], `${path}: ${text(g.problems)}`);
    assert.deepEqual(g.needed.map((x) => x.name).sort(), [...expected].sort(), `${path}: the closure is the real one, not empty`);
    for (const x of g.needed) assert.equal(x.spec, `file:${path}/packages/${x.name.replace(/^@[^/]+\//, "")}`);
  }
});

test("a repository whose vendor.path is not vendor/ gets the same missing-dependency finding (it was an empty closure and a passing check)", () => {
  const d = consumer({ "@k/a": { dependencies: { "@k/b": "*" } }, "@k/b": {} }, { path: "third_party/kit", rootDeps: { "@k/a": "file:third_party/kit/packages/a" } });
  assert.match(text(graphProblems(d, { path: "third_party/kit" })), /@k\/b is needed by the vendored @k\/a but not declared: declare "@k\/b": "file:third_party\/kit\/packages\/b"/);
});

// -- npm's semantics -----------------------------------------------------------------------------------------------------
test("precedence: optionalDependencies wins over dependencies, which wins over peerDependencies; an optional peer is not installed", () => {
  const e = edgesOf({ dependencies: { x: "^1" }, optionalDependencies: { x: "^2" }, peerDependencies: { y: "^3", z: "^4" }, peerDependenciesMeta: { z: { optional: true } } });
  assert.deepEqual([...e], [["y", { range: "^3", kind: "peerDependencies" }], ["x", { range: "^2", kind: "optionalDependencies" }]]);
  const e2 = edgesOf({ dependencies: { x: "^1" }, peerDependencies: { x: "^9" } });
  assert.equal(e2.get("x").range, "^1");
});

test("needed is the closure of what the root declares: a vendored package nothing declared reaches adds nothing (@k/a, @k/b, @k/z)", () => {
  // a -> b; z -> y is vendored but declared by nobody, and no declared package needs it
  const pk = { "@k/a": { dependencies: { "@k/b": "*" } }, "@k/b": {}, "@k/z": { dependencies: { "@k/y": "*" } }, "@k/y": {} };
  const only = (rootDeps) => vendorGraph(consumer(pk, { rootDeps }), { path: "vendor/kit" });
  assert.deepEqual(only({ "@k/a": "file:vendor/kit/packages/a" }).needed.map((x) => x.name), ["@k/b"], "z and y are not installed");
  assert.deepEqual(only({}).needed, [], "nothing declared, nothing needed");
  assert.deepEqual(only({ "@k/a": "file:vendor/kit/packages/a", "@k/z": "file:vendor/kit/packages/z" }).needed.map((x) => x.name).sort(), ["@k/b", "@k/y"]);
  assert.deepEqual(only({ "@k/a": "^1" }).needed.map((x) => x.name), ["@k/b"], "a registry spec for a vendored name still roots the closure (and is flagged by the declarations check)");
  // a missing member of a package nobody declared is still a problem of the snapshot (every package is checked)
  const bad = consumer({ "@k/z": { dependencies: { "@k/gone": "*" } }, "@k/y": {} }, { rootDeps: {} });
  assert.match(text(vendorGraph(bad, { path: "vendor/kit" }).problems), /@k\/z depends on @k\/gone/);
});

test("peer and optional dependencies are edges too", () => {
  const d = consumer({ "@k/a": { peerDependencies: { "@k/b": "*" }, optionalDependencies: { "@k/c": "*" } }, "@k/b": {}, "@k/c": {} }, { rootDeps: { "@k/a": "file:vendor/kit/packages/a" } });
  assert.deepEqual(vendorGraph(d, { path: "vendor/kit" }).needed.map((x) => x.name).sort(), ["@k/b", "@k/c"]);
});

test("version ranges are checked with semver against the vendored versions; an invalid range and an unsatisfied one fail", () => {
  const d = consumer({ "@k/a": { dependencies: { "@k/b": "^2.0.0", "@k/c": "not a range!" } }, "@k/b": { version: "1.4.0" }, "@k/c": {} });
  const t = text(vendorGraph(d, { path: "vendor/kit" }).problems);
  assert.match(t, /@k\/a needs @k\/b@\^2\.0\.0 but the vendored @k\/b is 1\.4\.0/);
  assert.match(t, /dependencies\.@k\/c is "not a range!", not a version range npm understands/);
  const ok = consumer({ "@k/a": { dependencies: { "@k/b": "~1.4.0" } }, "@k/b": { version: "1.4.9" } });
  assert.deepEqual(vendorGraph(ok, { path: "vendor/kit" }).problems, []);
});

test("an optional edge to a package that is not vendored is skipped; any other edge to a vendored scope is an error", () => {
  const d = consumer({ "@k/a": { optionalDependencies: { "@k/gone": "*" }, dependencies: { "@k/missing": "*", lodash: "^4" } } });
  const t = text(vendorGraph(d, { path: "vendor/kit" }).problems);
  assert.match(t, /@k\/a depends on @k\/missing, which is not in the vendored packages/);
  assert.ok(!/gone/.test(t) && !/lodash/.test(t));
});

test("scoped and unscoped names are matched exactly; two packages with one name are refused", () => {
  const d = consumer({ plain: { dependencies: { "@k/b": "*" } }, "@k/b": { dependencies: { plain: "*" } } }, { rootDeps: { plain: "file:vendor/kit/packages/plain" } });
  assert.deepEqual(vendorGraph(d, { path: "vendor/kit" }).needed.map((x) => x.name).sort(), ["@k/b", "plain"]);
  const dup = consumer({ "@k/a": {} });
  w(join(dup, "vendor/kit/packages/a-copy/package.json"), { name: "@k/a", version: "1.0.0" });
  assert.match(text(vendorGraph(dup, { path: "vendor/kit" }).problems), /@k\/a is vendored twice/);
});

// -- the root declarations and the lockfile -------------------------------------------------------------------------------
test("declarations: a registry range or a different file: path for a vendored package is wrong; sections conflict; each problem is reported once", () => {
  const pk = { "@k/a": { dependencies: { "@k/b": "*" }, peerDependencies: { "@k/b": "*" } }, "@k/c": { dependencies: { "@k/b": "*" } }, "@k/b": {} };
  const d = consumer(pk, { rootDeps: { "@k/a": "file:vendor/kit/packages/a", "@k/b": "^1" } });
  const ps = graphProblems(d, { path: "vendor/kit" });
  assert.equal(ps.filter((p) => /@k\/b is needed/.test(p.problem)).length, 1, text(ps));
  assert.match(text(ps), /declared as "\^1"/);
});

test("lockfile: every installed vendored package is linked and its entry equals its package.json (the missing-link and drifted-entry branches)", () => {
  const pk = { "@k/a": { dependencies: { "@k/b": "*" } }, "@k/b": {} };
  const rootDeps = { "@k/a": "file:vendor/kit/packages/a", "@k/b": "file:vendor/kit/packages/b" };
  const good = { "": { name: "site", dependencies: rootDeps }, "node_modules/@k/a": { resolved: "vendor/kit/packages/a", link: true }, "node_modules/@k/b": { resolved: "vendor/kit/packages/b", link: true }, "vendor/kit/packages/a": { version: "1.0.0", dependencies: { "@k/b": "*" } }, "vendor/kit/packages/b": { version: "1.0.0" } };
  assert.deepEqual(graphProblems(consumer(pk, { rootDeps, lock: good }), { path: "vendor/kit" }), []);
  const noLink = { ...good }; delete noLink["node_modules/@k/b"];
  assert.match(text(graphProblems(consumer(pk, { rootDeps, lock: noLink }), { path: "vendor/kit" })), /@k\/b is not linked to vendor\/kit\/packages\/b in the lockfile/);
  const drift = { ...good, "vendor/kit/packages/a": { version: "1.0.0" } };
  assert.match(text(graphProblems(consumer(pk, { rootDeps, lock: drift }), { path: "vendor/kit" })), /vendor\/kit\/packages\/a: dependencies\.@k\/b is "\*" in package\.json but missing in the lockfile/);
  const noEntry = { ...good }; delete noEntry["vendor/kit/packages/b"];
  assert.match(text(graphProblems(consumer(pk, { rootDeps, lock: noEntry }), { path: "vendor/kit" })), /vendor\/kit\/packages\/b has no entry in the lockfile/);
  // kit check lockfile reports the same, once, when it is given the vendor config
  const d = consumer(pk, { rootDeps, lock: noLink });
  const lp = lockfileProblems(d, { vendor: { path: "vendor/kit" } });
  assert.equal(lp.filter((p) => /@k\/b is not linked/.test(p.problem)).length, 1, text(lp));
});

// -- sync: transactional, and it emits the declarations ---------------------------------------------------------------------
function kitRepo(files) {
  const src = join(TMP, `kit${++n}`);
  for (const [f, body] of Object.entries(files)) w(join(src, f), body);
  const git = (...a) => execFileSync("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).toString().trim();
  execFileSync("git", ["init", "-q", src]); git("add", "-A"); git("commit", "-qm", "kit");
  const head = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", head);
  return { src, head };
}
const CFG = { path: "third_party/kit", include: ["packages"] };

test("sync emits the file: dependencies the snapshot needs (sorted, once) and tells that the lockfile step is manual", () => {
  const { src, head } = kitRepo({ "packages/a/package.json": { name: "@k/a", version: "1.0.0", dependencies: { "@k/b": "*" } }, "packages/b/package.json": { name: "@k/b", version: "1.0.0" } });
  const d = join(TMP, `site${++n}`); w(join(d, "package.json"), { name: "site", dependencies: { "@k/a": "file:third_party/kit/packages/a", zed: "^1" } });
  const r = syncVendor(d, CFG, { source: src, commit: head, fetch: false });
  assert.deepEqual(r.added, ["@k/b"]);
  assert.deepEqual(JSON.parse(readFileSync(join(d, "package.json"), "utf8")).dependencies, { "@k/a": "file:third_party/kit/packages/a", "@k/b": "file:third_party/kit/packages/b", zed: "^1" });
  assert.deepEqual(checkVendor(d, CFG).problems.map((p) => p.file), ["package-lock.json"].filter(() => false), "no lockfile in the fixture: declarations are complete");
  assert.deepEqual(syncVendor(d, CFG, { source: src, commit: head, fetch: false }).added, [], "a second sync adds nothing");
});

test("sync is transactional: a snapshot that does not resolve writes no snapshot, no manifest and no package.json", () => {
  const { src, head } = kitRepo({ "packages/a/package.json": { name: "@k/a", version: "1.0.0", dependencies: { "@k/b": "^2" } }, "packages/b/package.json": { name: "@k/b", version: "1.0.0" } });
  const d = join(TMP, `site${++n}`); const before = { name: "site", dependencies: { "@k/a": "file:third_party/kit/packages/a" } }; w(join(d, "package.json"), before);
  assert.throws(() => syncVendor(d, CFG, { source: src, commit: head, fetch: false }), /does not resolve, nothing was written[\s\S]*@k\/a needs @k\/b@\^2 but the vendored @k\/b is 1\.0\.0/);
  assert.equal(existsSync(join(d, "third_party")), false, "no snapshot directory");
  assert.equal(existsSync(join(d, "third_party/kit.manifest.json")), false, "no manifest");
  assert.deepEqual(JSON.parse(readFileSync(join(d, "package.json"), "utf8")), before);
});

test("missingDeclarations lists what sync adds", () => {
  const d = consumer({ "@k/a": { dependencies: { "@k/b": "*" } }, "@k/b": {} }, { rootDeps: { "@k/a": "file:vendor/kit/packages/a" } });
  const g = vendorGraph(d, { path: "vendor/kit" });
  assert.deepEqual(missingDeclarations({ dependencies: {} }, g).map((m) => m.spec), ["file:vendor/kit/packages/b"]);
  assert.deepEqual(missingDeclarations({ dependencies: { "@k/b": "file:vendor/kit/packages/b" } }, g), []);
});

// -- review round 2: path normalisation, location specs, prerelease semantics, lockfile versions, atomic sync -----------------
test("vendor.path is normalised (./third_party/kit/, backslashes) and a root declaration may spell the path the same ways", () => {
  assert.equal(normalPath("./third_party/kit/"), "third_party/kit");
  assert.equal(normalPath("third_party\\kit"), "third_party/kit");
  const d = consumer({ "@k/a": { dependencies: { "@k/b": "*" } }, "@k/b": {} }, { path: "third_party/kit", rootDeps: { "@k/a": "file:./third_party/kit/packages/a", "@k/b": "file:third_party/kit/packages/b/" } });
  assert.deepEqual(graphProblems(d, { path: "./third_party/kit/" }), []);
  assert.deepEqual(vendorGraph(d, { path: "./third_party/kit" }).needed.map((x) => x.name).sort(), ["@k/b"]);
});

test("a vendored package may not depend on another by location (workspace:, link:, file:../): by version range only", () => {
  for (const spec of ["workspace:*", "link:../b", "file:../b", "git+https://x/y.git"]) {
    const d = consumer({ "@k/a": { dependencies: { "@k/b": spec } }, "@k/b": {} });
    assert.match(text(vendorGraph(d, { path: "vendor/kit" }).problems), /a location: a vendored package depends on another by version range/, spec);
  }
});

test("npm's prerelease rule: 2.0.0-beta.1 does not satisfy ^2.0.0 (no includePrerelease)", () => {
  const d = consumer({ "@k/a": { dependencies: { "@k/b": "^2.0.0" } }, "@k/b": { version: "2.0.0-beta.1" } });
  assert.match(text(vendorGraph(d, { path: "vendor/kit" }).problems), /needs @k\/b@\^2\.0\.0 but the vendored @k\/b is 2\.0\.0-beta\.1/);
  const ok = consumer({ "@k/a": { dependencies: { "@k/b": "^2.0.0-beta.0" } }, "@k/b": { version: "2.0.0-beta.1" } });
  assert.deepEqual(vendorGraph(ok, { path: "vendor/kit" }).problems, []);
});

test("lockfile: the entry's version is compared too", () => {
  const pk = { "@k/a": {} };
  const rootDeps = { "@k/a": "file:vendor/kit/packages/a" };
  const lock = (v) => ({ "": { name: "site", dependencies: rootDeps }, "node_modules/@k/a": { resolved: "vendor/kit/packages/a", link: true }, "vendor/kit/packages/a": { version: v } });
  assert.deepEqual(graphProblems(consumer(pk, { rootDeps, lock: lock("1.0.0") }), { path: "vendor/kit" }), []);
  assert.match(text(graphProblems(consumer(pk, { rootDeps, lock: lock("0.9.0") }), { path: "vendor/kit" })), /vendor\/kit\/packages\/a: version is "1\.0\.0" in package\.json but "0\.9\.0" in the lockfile/);
});

function tree(dir) {
  const out = {};
  const walk = (d, rel) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(p, r); else out[r] = readFileSync(p, "utf8"); } };
  walk(dir, "");
  return out;
}
test("sync is atomic: a failure injected at every step leaves the previous snapshot, manifest and package.json byte for byte", () => {
  const first = kitRepo({ "packages/a/package.json": { name: "@k/a", version: "1.0.0", dependencies: { "@k/b": "*" } }, "packages/b/package.json": { name: "@k/b", version: "1.0.0" }, "packages/a/old.js": "old" });
  const second = kitRepo({ "packages/a/package.json": { name: "@k/a", version: "1.1.0", dependencies: { "@k/b": "*" } }, "packages/b/package.json": { name: "@k/b", version: "1.1.0" }, "packages/a/new.js": "new" });
  const d = join(TMP, `site${++n}`); w(join(d, "package.json"), { name: "site", dependencies: { "@k/a": "file:third_party/kit/packages/a" } });
  syncVendor(d, CFG, { source: first.src, commit: first.head, fetch: false });
  const before = tree(d);
  assert.ok(before["third_party/kit/packages/a/old.js"] && before["package.json"].includes("@k/b"));
  // a state where the second sync has something to change in all three places
  const pkg = JSON.parse(before["package.json"]); delete pkg.dependencies["@k/b"]; w(join(d, "package.json"), pkg);
  const base = tree(d);
  for (const at of ["stage-snapshot", "stage-manifest", "stage-package", "swap-snapshot", "swap-manifest", "swap-package", "commit"]) {
    assert.throws(() => syncVendor(d, CFG, { source: second.src, commit: second.head, fetch: false, hooks: { step: (name) => { if (name === at) throw new Error(`injected at ${at}`); } } }), (e) => e.name === "CliError" && e.code === 1 && new RegExp(`injected at ${at}`).test(e.message), at);
    assert.deepEqual(tree(d), base, `${at}: the previous state is byte-identical (no staging or backup files left either)`);
  }
  const r = syncVendor(d, CFG, { source: second.src, commit: second.head, fetch: false });
  assert.deepEqual(r.added, ["@k/b"]);
  assert.ok(tree(d)["third_party/kit/packages/a/new.js"] && !tree(d)["third_party/kit/packages/a/old.js"]);
});

// -- review of #115 (M3): the undo exists before the first rename, and vendor.path may not be the root or outside it ------------------
test("sync is atomic BETWEEN the two renames of a swap: the first rename done, the second failing, the previous state is back byte for byte", () => {
  const first = kitRepo({ "packages/a/package.json": { name: "@k/a", version: "1.0.0", dependencies: { "@k/b": "*" } }, "packages/b/package.json": { name: "@k/b", version: "1.0.0" }, "packages/a/old.js": "old" });
  const second = kitRepo({ "packages/a/package.json": { name: "@k/a", version: "1.1.0", dependencies: { "@k/b": "*" } }, "packages/b/package.json": { name: "@k/b", version: "1.1.0" }, "packages/a/new.js": "new" });
  const d = join(TMP, `site${++n}`); w(join(d, "package.json"), { name: "site", dependencies: { "@k/a": "file:third_party/kit/packages/a" } });
  syncVendor(d, CFG, { source: first.src, commit: first.head, fetch: false });
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8")); delete pkg.dependencies["@k/b"]; w(join(d, "package.json"), pkg);
  const base = tree(d);
  // the fault removes what the SECOND rename moves into place, after the hook of the step has run and before the first rename: the first rename succeeds, the second throws
  const faults = { "swap-snapshot": () => rmSync(join(d, "third_party/kit.sync-new"), { recursive: true }), "swap-manifest": () => rmSync(join(d, "third_party/kit.manifest.json.sync-new")), "swap-package": () => rmSync(join(d, "package.json.sync-new")) };
  for (const [at, fault] of Object.entries(faults)) {
    assert.throws(() => syncVendor(d, CFG, { source: second.src, commit: second.head, fetch: false, hooks: { step: (name) => { if (name === at) fault(); } } }), (e) => e.name === "CliError", at);
    assert.deepEqual(tree(d), base, `${at}: failing between its two renames leaves the previous snapshot, manifest and package.json (nothing missing, no backup left)`);
  }
  assert.ok(existsSync(join(d, "package.json")));
});

test("a FIRST sync (no snapshot, no manifest yet) that fails between the renames leaves nothing behind", () => {
  const k = kitRepo({ "packages/a/package.json": { name: "@k/a", version: "1.0.0" } });
  const d = join(TMP, `site${++n}`); w(join(d, "package.json"), { name: "site", dependencies: { "@k/a": "file:third_party/kit/packages/a" } });
  const base = tree(d);
  assert.throws(() => syncVendor(d, CFG, { source: k.src, commit: k.head, fetch: false, hooks: { step: (name) => { if (name === "swap-snapshot") rmSync(join(d, "third_party/kit.sync-new"), { recursive: true }); } } }), (e) => e.name === "CliError");
  assert.deepEqual(tree(d), base);
  assert.ok(!existsSync(join(d, "third_party/kit")), "no half snapshot");
});

test("vendor.path may not be the project root or outside it, and neither may the manifest: nothing is written or deleted", () => {
  const k = kitRepo({ "packages/a/package.json": { name: "@k/a", version: "1.0.0" } });
  for (const bad of ["./", ".", "", "a/..", "..", "../x", "vendor/../..", "/abs/kit", "C:/kit"]) {
    const d = join(TMP, `site${++n}`); w(join(d, "package.json"), { name: "site" }); w(join(d, "src/app.js"), "precious");
    const base = tree(d);
    assert.throws(() => syncVendor(d, { path: bad, include: ["packages"] }, { source: k.src, commit: k.head, fetch: false }), (e) => e.name === "CliError" && /vendor\.path/.test(e.message), `path ${JSON.stringify(bad)}`);
    assert.deepEqual(tree(d), base, `${JSON.stringify(bad)}: the project is untouched`);
    assert.ok(checkVendor(d, { path: bad, include: ["packages"] }).problems.some((p) => /vendor\.path/.test(p.problem)), `check reports ${JSON.stringify(bad)}`);
    assert.ok(graphProblems(d, { path: bad }).some((p) => /vendor\.path/.test(p.problem)), `graph reports ${JSON.stringify(bad)}`);
  }
  for (const manifest of ["../outside.json", "/etc/kit.json", ".", "a/../.."]) {
    const d = join(TMP, `site${++n}`); w(join(d, "package.json"), { name: "site" });
    const base = tree(d);
    assert.throws(() => syncVendor(d, { path: "third_party/kit", manifest, include: ["packages"] }, { source: k.src, commit: k.head, fetch: false }), (e) => e.name === "CliError" && /manifest/.test(e.message), `manifest ${manifest}`);
    assert.deepEqual(tree(d), base);
  }
});

// -- unreadable JSON is a finding, never a crash and never a silent pass ---------------------------------------------------------
test("unreadable JSON: a vendored package.json, the root's and the lockfile are each one finding in kit check vendor and kit check lockfile", () => {
  const cfg = { path: "vendor/kit" };
  const bad = (what) => {
    const d = consumer({ "@k/a": {}, "@k/b": {} }, { rootDeps: { "@k/a": "file:vendor/kit/packages/a" }, lock: {} });
    if (what === "vendored") writeFileSync(join(d, "vendor/kit/packages/b/package.json"), "{ not json");
    if (what === "root") writeFileSync(join(d, "package.json"), "{ not json");
    if (what === "lock") writeFileSync(join(d, "package-lock.json"), "{ not json");
    return d;
  };
  for (const [what, file] of [["vendored", "vendor/kit/packages/b/package.json"], ["root", "package.json"], ["lock", "package-lock.json"]]) {
    const d = bad(what);
    let g, l;
    assert.doesNotThrow(() => { g = graphProblems(d, cfg); l = lockfileProblems(d, { vendor: cfg }); }, what);
    for (const [who, ps] of [["graph", g], ["lockfile", l]]) assert.equal(ps.filter((p) => p.file === file && /not readable JSON/.test(p.problem)).length, 1, `${what} via ${who}: one finding\n${text(ps)}`);
  }
  // kit check vendor itself (a manifest is needed for it to get as far as the graph)
  const d = bad("lock"); w(join(d, "vendor/kit.manifest.json"), { path: "vendor/kit", include: ["packages"], files: [] });
  assert.ok(checkVendor(d, { path: "vendor/kit", include: ["packages"] }).problems.some((p) => p.file === "package-lock.json" && /not readable JSON/.test(p.problem)));
});
