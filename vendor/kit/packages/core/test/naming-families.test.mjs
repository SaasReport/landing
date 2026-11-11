// Project prefixes have one source, the registry (packages/core/scripts/naming-families.mjs): every generated: block is generated from
// it, and a VALUE scan finds any other copy of it, whatever its formatting (a scan for table shapes missed quoted-key maps, multi-line
// lists, prefix lists, one-line objects, single strings and regex alternations).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../../cli/src/git.js";
import { render as renderRegistryTable } from "../scripts/registry-table.mjs";
import { renderDoc as renderCostDoc } from "../../cli/scripts/claude-cost-doc.mjs";
import { families, forbidden, render, check, containment, copiesIn, blocksIn, renderBlocks, ALLOW_CATEGORY } from "../scripts/naming-families.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (f) => { try { return readFileSync(`${root}${f}`, "utf8"); } catch { return null; /* an absent file reads as null: check() reports it as stale or missing */ } };
const reg = JSON.parse(read("packages/core/registry/projects.json"));
const files = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", env: gitEnv() }).split("\n").filter(Boolean);
const canon = JSON.parse(read("kit.canon.json")), allow = JSON.parse(read("canon.allow.json")).entries;
const generated = canon.freshness.flatMap((x) => x.outputs || []);
const checkWith = (over = {}, extra = [], allowList = allow) => check(reg, (f) => (f in over ? over[f] : read(f)), [...files, ...extra], { generated, allow: allowList, foreign: canon.freshness });
/** A registry with several projects, to prove the scan on shapes the single-project registry cannot show. */
const many = { projects: [
  { key: "alpha", name: "Alpha", domain: "alpha.example", prefix: "alpha-", short: "al-" },
  { key: "beta", name: "Beta", domain: "beta.example", prefix: "beta-", short: "be-" },
  { key: "gamma", name: "Gamma", domain: "gamma.example", prefix: "gamma-", short: null },
], legacy: [{ prefix: "old-", belongsTo: "alpha", action: "archive, then delete" }] };

test("every registry project is a family with its full prefix, then its short one; legacy prefixes are forbidden; no prefix contains another", () => {
  const f = families(reg);
  assert.deepEqual(Object.keys(f), reg.projects.map((p) => p.key));
  assert.deepEqual(f.saasreport, ["saasreport-"]);
  assert.deepEqual(forbidden(reg), []);
  assert.deepEqual(containment(reg), []);
  assert.deepEqual(families(many), { alpha: ["alpha-", "al-"], beta: ["beta-", "be-"], gamma: ["gamma-"] });
  assert.deepEqual(forbidden(many), ["old-"]);
  const nested = structuredClone(reg); nested.projects.push({ key: "saasreportx", name: "Saasreportx", domain: "saasreportx.example", prefix: "saasreport-x-", short: null });
  assert.match(containment(nested).join("\n"), /saasreport- \(saasreport\) is a prefix of saasreport-x- \(saasreportx\)/);
});

test("the repository holds no copy of the registry: generated files and blocks equal it, every allow entry is used", () => {
  assert.deepEqual(checkWith(), []);
  for (const f of ["CLAUDE.md", "docs/diagrams/naming.mmd", "packages/plugins/runtime/kit-plugin-check.mjs"]) assert.ok(f in render(reg, read, files), `${f} carries a generated block`);
});

test("must fail: the six shapes a shape scan missed, in any file, are copies of the registry", () => {
  const shapes = {
    "quoted-map.json": '{\n  "al": "alpha",\n  "be": "beta"\n}\n',
    "multiline.js": 'export const CODES = [\n  "al",\n  "be",\n];\n',
    "prefix-list.js": 'export const P = ["al-", "be-"];\n',
    "one-line.js": 'const m = { al: "alpha", be: "beta" };\n',
    "single.js": 'const prefix = "gamma-";\n',
    "alternation.js": "const re = /^(al|be|gamma)-/;\n",
    "x.md": "The prefixes are `al-` and `be-`.\n",
    "x.schema.json": '{ "description": "The project code (al, be, gamma)." }\n',
  };
  for (const [f, text] of Object.entries(shapes)) assert.ok(copiesIn(text, many).length > 0, f);
  // the real registry: its one bare prefix is a copy in any file, whatever the file
  for (const [f, text] of Object.entries({ "packages/x/src/single.js": 'const prefix = "saasreport-";\n', "docs/x.md": "The prefix is `saasreport-`.\n", "packages/x/src/list.js": 'export const P = ["saasreport-"];\n' })) {
    const p = checkWith({ [f]: text }, [f]).join("\n");
    assert.match(p, new RegExp(`${f.replace(/[.]/g, "\\.")}:\\d+: ".+" copies the project registry`), f);
  }
  // not copies: a resource name carrying a prefix, a single code, an id, the npm scope
  for (const text of ['const worker = "saasreport-web";\n', 'const code = "saasreport";\n', "id: saasreport.terminal.arch\n", 'import x from "@saasreport/core";\n'])
    assert.deepEqual(copiesIn(text, reg), [], text);
  for (const text of ['const worker = "alpha-web";\n', 'const code = "al";\n', "id: alpha.terminal.arch\n"]) assert.deepEqual(copiesIn(text, many), [], text);
  // tests may pin values; the registry and generated outputs are their generators' business
  assert.deepEqual(checkWith({ "packages/x/test/a.test.mjs": 'assert.deepEqual(P, ["saasreport-"]);\n' }, ["packages/x/test/a.test.mjs"]), []);
});

test("must fail: a generated block edited by hand, a block left open, a stale or unused allow entry", () => {
  const md = read("CLAUDE.md");
  assert.match(checkWith({ "CLAUDE.md": md.replace("(a project with one prefix has no short form)", "(edited by hand)") }).join("\n"), /CLAUDE\.md: stale/);
  assert.throws(() => blocksIn("<!-- generated:naming-prefixes -->\n| x |\n"), /never closed/);
  assert.throws(() => blocksIn("// /generated:plugin-prefixes\n"), /closes no open block/);
  assert.equal(renderBlocks("%% generated:naming-families\nold\n%% /generated:naming-families\n", many).split("\n").length, many.projects.length + 3);
  const unused = [...allow, { file: "docs/x.md", category: ALLOW_CATEGORY, match: "saasreport-", context: "quoted once", reason: "An exception that matches nothing in the repository, so it is stale and must be reported." }];
  assert.match(checkWith({}, [], unused).join("\n"), /stale "project-prefix" entry .*docs\/x\.md "saasreport-"/);
  assert.equal(allow.filter((e) => e.category === ALLOW_CATEGORY).every((e) => e.reason.length > 40), true, "every exception carries its reason");
  const more = structuredClone(reg); more.projects.push({ key: "zzz", name: "Zzz", domain: "zzz.example", prefix: "zzz-", short: null });
  assert.notEqual(render(more, read, files)["CLAUDE.md"], md, "a new registry project reaches every generated block");
});

test("must fail: a generated: marker hides nothing unless a known generator owns that block in that file; an allow entry covers one instance", () => {
  const k1 = "packages/x/src/k1.js", k2 = "packages/x/src/k2.js", k3 = "docs/NAMING.md";
  const p1 = checkWith({ [k1]: '// generated:anything\nexport const P = ["saasreport-"];\n// /generated:anything\n' }, [k1]).join("\n");
  assert.match(p1, /k1\.js: generated:anything is no known generator's block/); assert.match(p1, /k1\.js:2: ".+" copies the project registry/);
  const p2 = checkWith({ [k2]: '// generated:registry\nexport const P = ["saasreport-"];\n// /generated:registry\n' }, [k2]).join("\n");
  assert.match(p2, /k2\.js: generated:registry is no known generator's block in this file/); assert.match(p2, /k2\.js:2: ".+" copies/);
  assert.deepEqual(checkWith({ [k3]: read(k3) }), [], "the registry table's own block in its own output is skipped");
  // one entry, one instance: an allowed line written twice is one allowed instance and one finding
  const quoted = { file: k3, category: ALLOW_CATEGORY, match: "saasreport-", context: "A dated owner decision", reason: "A dated owner decision record quoting the project's prefix; the registry is the source, the record is history." };
  const text = `${read(k3)}\nA dated owner decision: \`saasreport-\`.\n`;
  assert.deepEqual(checkWith({ [k3]: text }, [], [...allow, quoted]), []);
  const twice = checkWith({ [k3]: `${text}A dated owner decision: \`saasreport-\`.\n` }, [], [...allow, quoted]).join("\n");
  assert.match(twice, /docs\/NAMING\.md:\d+: "saasreport-" copies/);
  assert.equal((twice.match(/"saasreport-" copies/g) || []).length, 1);
});

test("must fail: a second same-named block hides nothing, in the naming scan and in the block's own generator", () => {
  // the hidden copy sits in a second block of the same declared name; the first block stays exactly as its generator writes it
  const cases = [
    { file: "docs/NAMING.md", name: "registry", own: (t) => renderRegistryTable(t, reg) },
    { file: "docs/COST.md", name: "claude-spend", own: renderCostDoc },
  ];
  for (const { file, name, own } of cases) {
    const dup = `${read(file)}\n<!-- generated:${name} -->\nexport const P = ["saasreport-"];\n<!-- /generated:${name} -->\n`;
    const p = checkWith({ [file]: dup }).join("\n");
    assert.match(p, new RegExp(`${file.replace(/[./]/g, "\\$&")}: generated:${name} appears more than once`), `${file}: the naming scan refuses the duplicate`);
    assert.throws(() => own(dup), /appears more than once/, `${file}: its owning generator refuses the duplicate`);
    assert.doesNotThrow(() => own(read(file)), `${file}: one block is fine`);
  }
});
