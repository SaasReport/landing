// The browser file set is STRUCTURAL: a test file is a browser file because it imports browser-env.mjs (parsed by the canon engine's
// tree-sitter, never matched as text), and the finding class browser-launch-outside-browser-env refuses a test file that reaches a
// browser (playwright, playwright-core, chromium, launchGuarded) any other way, so the one classification is sound. The class
// skipped-browser-test covers exactly that set, declared once: its files.importing is the classifier's own source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../core/test/support/temp.mjs";
import { runGate } from "../src/canon/findings.js";
import { browserTestFiles, browserModules } from "../scripts/test-files.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENV = "packages/cli/test/browser-env.mjs";
const treeOf = (t, files) => { const dir = tempDir(t, "kit-bset-"); for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), text); } return dir; };
const registry = () => JSON.parse(readFileSync(join(ROOT, "packages/core/registry/finding-classes.json"), "utf8")).classes;
const refused = async (t, id, files) => { const dir = treeOf(t, files); return (await runGate(id, dir, Object.keys(files))).filter((x) => x.match !== "parse error"); };

test("a browser file is one that imports browser-env.mjs (static, dynamic or re-export); a comment, a string or another module of that name is not", async (t) => {
  const dir = treeOf(t, {
    [ENV]: "export const x = 1;\n",
    "packages/cli/test/a.test.mjs": 'import { CHROMIUM } from "./browser-env.mjs";\n',
    "packages/cli/test/b.test.mjs": '// import { x } from "./browser-env.mjs"\nconst s = "browser-env.mjs";\n/* ./browser-env.mjs */\n',
    "packages/cli/test/c.test.mjs": 'const { loadPlaywright } = await import("./browser-env.mjs");\n',
    "packages/cli/test/d.test.mjs": 'export * from "./browser-env.mjs";\n',
    "packages/cli/test/e.test.mjs": 'import x from "../../other/test/browser-env.mjs";\n',
    "packages/cli/test/f.test.mjs": 'const { x } = require("./browser-env.mjs");\n',
    "vendor/v/test/g.test.mjs": 'import x from "../../../packages/cli/test/browser-env.mjs";\n',
  });
  try {
    assert.deepEqual(await browserTestFiles(dir, [ENV]), ["packages/cli/test/a.test.mjs", "packages/cli/test/c.test.mjs", "packages/cli/test/d.test.mjs", "packages/cli/test/f.test.mjs", "vendor/v/test/g.test.mjs"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transitive: a test that reaches browser-env.mjs through relative imports (any depth, cycles allowed) is a browser file; one that does not is not", async (t) => {
  const dir = treeOf(t, {
    [ENV]: "export const x = 1;\n",
    "packages/cli/test/a.test.mjs": 'import "./h1.mjs";\n',
    "packages/cli/test/h1.mjs": 'import "./h2.mjs";\n',
    "packages/cli/test/h2.mjs": 'import "./h3.mjs";\nexport * from "./h1.mjs";\n',
    "packages/cli/test/h3.mjs": 'import { x } from "./browser-env.mjs";\n',
    "packages/cli/test/b.test.mjs": 'import "./c1.mjs";\n',
    "packages/cli/test/c1.mjs": 'import "./c2.mjs";\n',
    "packages/cli/test/c2.mjs": 'import "./c1.mjs";\nimport "node:fs";\nimport "./missing.mjs";\n',
  });
  try { assert.deepEqual(await browserTestFiles(dir, [ENV]), ["packages/cli/test/a.test.mjs"]); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skipped-browser-test covers a test that reaches browser-env.mjs only through a helper", async (t) => {
  assert.ok((await refused(t, "skipped-browser-test", { "packages/cli/test/t.test.mjs": 'import "./helper.mjs";\ntest("x", { skip: true }, () => {});\n', "packages/cli/test/helper.mjs": 'import "./browser-env.mjs";\n' })).length);
});

test("one source: the classifier's module is the class's files.importing, and the class names no file of the set", async (t) => {
  const cls = registry().find((c) => c.id === "skipped-browser-test");
  assert.deepEqual(cls.detect.map((d) => d.files.importing), cls.detect.map(() => [ENV]));
  assert.deepEqual(await browserModules(ROOT), [ENV]);
  for (const d of cls.detect) assert.ok(d.files.include.every((g) => /\*/.test(g) && !/(theme|visual|search)-qa|browser-(ci|bounds|set|step)/.test(g)), `the class lists no file by name: ${d.files.include}`);
  const set = await browserTestFiles(ROOT);
  for (const f of ["theme-qa", "visual-qa", "search-qa", "browser-ci", "browser-bounds"]) assert.ok(set.includes(`packages/cli/test/${f}.test.mjs`), f);
});

test("skipped-browser-test covers every file of the set, by import: browser-bounds and browser-ci too; a file outside the set may skip", async (t) => {
  for (const name of ["browser-bounds", "browser-ci", "some-future-browser-test"]) {
    assert.ok((await refused(t, "skipped-browser-test", { [`packages/cli/test/${name}.test.mjs`]: 'import { CHROMIUM } from "./browser-env.mjs";\ntest("x", { skip: true }, () => {});\n' })).length, `${name} must be covered`);
  }
  assert.deepEqual(await refused(t, "skipped-browser-test", { "packages/cli/test/plain.test.mjs": 'test("x", { skip: true }, () => {});\n' }), [], "a test file outside the set is out of scope");
  assert.ok((await refused(t, "skipped-browser-test", { [ENV]: "export const skip = true;\ntest.skip('x');\n" })).length, "browser-env itself is covered");
});

const forms = JSON.parse(readFileSync(join(ROOT, "findings/browser-launch-outside-browser-env/forms.json"), "utf8"));

test("browser-launch-outside-browser-env: a test file that reaches a browser other than through browser-env.mjs is refused (every written form of forms.json)", async (t) => {
  assert.ok(forms.refuse.length >= 18);
  for (const f of forms.refuse) assert.ok((await refused(t, "browser-launch-outside-browser-env", f.files)).length, `must be refused: ${JSON.stringify(f.files)}`);
});

test("browser-launch-outside-browser-env: through browser-env.mjs, or no browser at all, passes (a comment or a string is not a launch)", async (t) => {
  for (const f of forms.pass) assert.deepEqual(await refused(t, "browser-launch-outside-browser-env", f.files), [], JSON.stringify(f.files));
});

test("the repository passes both classes", async (t) => {
  assert.deepEqual(await runGate("browser-launch-outside-browser-env", ROOT, (await import("../scripts/test-files.mjs")).testFiles(ROOT)), []);
  assert.deepEqual(await runGate("skipped-browser-test", ROOT, [...await browserTestFiles(ROOT), ENV]), []);
});
