// The "no Persian text" fact reads the repository's own files, never its built output: a built site carries the kit's browser formatter, which
// holds Persian digit tables and words, and that made every English-only site "have Persian text" (and forced a clean step before the canon).
// Must-fail first: the scan still finds Persian text in a source file, a root config and a tracked file; must-pass: a built site/format.js,
// a gitignored file and a declared generated path never flip it; and the kit's English-only format.js carries no Persian script at all.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../../core/test/support/temp.mjs";
import { formatForBrowser } from "@saasreport/format/browser";
import { PREDICATES, repoFacts } from "../src/canon/facts.js";
import { runGate } from "../src/canon/findings.js";

const holds = (root, canon = {}) => PREDICATES["no-persian-content"].holds(repoFacts(root, canon));
function repo(t, files, { git = false } = {}) {
  const root = tempDir(t, "facts-generated-");
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
  if (git) execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
const PERSIAN = "پرداخت خسارت پرونده";

test("must fail: Persian text in a source file, a content file or a tracked JSON still makes the repository a Persian one", (t) => {
  for (const [rel, body] of [["src/copy.js", `export const t = "${PERSIAN}";\n`], ["content/a.md", `${PERSIAN}\n`], ["data/a.json", JSON.stringify({ t: PERSIAN })]]) {
    assert.equal(holds(repo(t, { [rel]: body, "README.md": "# x\n" })), false, rel);
  }
});

test("must pass: a built site's format.js (the kit's formatter with its Persian tables) never flips the fact, by the declared generated path, by .gitignore, or both", (t) => {
  const built = formatForBrowser();   // the full build: digit sets, number words, month names
  assert.match(built, /[؀-ۿ]{2,}\s+[؀-ۿ]{2,}/, "the fixture really carries Persian words");
  const files = { "src/a.js": "export const a = 1;\n", "site/format.js": built, "site/index.html": '<html lang="en"><p>12 terms</p></html>\n' };
  assert.equal(holds(repo(t, files)), false, "with no declaration and no git, the built file is scanned (nothing says it is output)");
  assert.equal(holds(repo(t, files), { tokens: { generated: ["site"] } }), true, "tokens.generated: site");
  assert.equal(holds(repo(t, files), { tokens: { generated: ["site/**/*.js"] } }), true, "a glob");
  assert.equal(holds(repo(t, { ...files, ".gitignore": "/site/\n" }, { git: true })), true, "gitignored");
  // a tracked file under a generated path is still output, a Persian file outside both is still found
  assert.equal(holds(repo(t, { ...files, ".gitignore": "/site/\n", "content/a.md": PERSIAN }, { git: true })), false, "the repository's own Persian text is still found");
});

test("the English-only browser build carries no Persian or Arabic script, so a built English site is clean without any exemption", (t) => {
  const latin = formatForBrowser({ locales: [{ code: "en" }] });
  assert.doesNotMatch(latin, /[؀-ۿ]/);
  assert.equal(holds(repo(t, { "site/format.js": latin, "src/a.js": "export const a = 1;\n" })), true, "even scanned, it is not Persian text");
});

test("a built site's format.js passes the swallowed-error gate in both builds: scoping to Latin-script locales keeps the reason written inside each catch", async (t) => {
  for (const [name, built] of [["English-only", formatForBrowser({ locales: [{ code: "en" }] })], ["Persian", formatForBrowser({ locales: [{ code: "fa" }] })]]) {
    const found = await runGate("swallowed-error", repo(t, { "site/format.js": built }));
    assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.match}`), [], `${name} build: a catch without its reason is a finding in the built site`);
  }
  assert.ok((await runGate("swallowed-error", repo(t, { "site/format.js": "try { f(); } catch { }\n" }))).length > 0, "the gate does refuse an empty catch");
});

test("vendored private Kit content never counts as first-party Persian copy; source Persian still does", (t) => {
  for (const vendor of ["vendor/kit", "third_party/kit"]) {
    const files = {
      "README.md": "# English-only host project\\n",
      [`${vendor}/packages/site/src/locales/fa.js`]: `export const demo = "${PERSIAN}";\\n`,
      [`${vendor}.manifest.json`]: "{}",
    };
    const canon = { vendor: { path: vendor } };
    assert.equal(holds(repo(t, files), canon), true, `Kit dependency at ${vendor} is not project copy`);
    assert.equal(holds(repo(t, { ...files, "content/local.json": JSON.stringify({ copy: PERSIAN }) }), canon), false,
      "first-party Persian copy still makes the Persian gate mandatory");
    const facts = repoFacts(repo(t, files), canon);
    assert.equal(facts.vendoredKit, true, "the independent vendor integrity check stays applicable");
  }
});

test("a leftover default snapshot remains excluded from content facts when vendor.path changes", (t) => {
  const root = repo(t, {
    "src/english.js": "export const en = true;\\n",
    "vendor/kit/packages/core/example.js": `export default "${PERSIAN}";\\n`,
  });
  assert.equal(holds(root, { vendor: { path: "third_party/kit" } }), true);
  assert.equal(repoFacts(root, { vendor: { path: "third_party/kit" } }).vendoredKit, true);
});


test("vendored Kit text is dependency evidence, not a project's Persian content", (t) => {
  const files = {
    "src/app.js": "export const greeting = 'Hello';\\n",
    "vendor/kit/packages/site/src/locales/fa.js": `export const text = "${PERSIAN}";\\n`,
    "vendor/kit.manifest.json": JSON.stringify({ source: { commit: "abc" } }),
  };
  const root = repo(t, files);
  const facts = repoFacts(root, { vendor: { path: "vendor/kit" } });
  assert.equal(facts.vendoredKit, true, "vendor is still detected and must pass independent provenance checks");
  assert.equal(facts.persianText, false, "foreign locale packs cannot require site Persian approval");
  assert.equal(holds(root, { vendor: { path: "vendor/kit" } }), true);

  const own = repo(t, { ...files, "content/a.md": PERSIAN });
  assert.equal(holds(own, { vendor: { path: "vendor/kit" } }), false, "authored Persian always makes the check applicable");
});

test("configured nondefault vendored snapshot is excluded even when Git ignore is unavailable", (t) => {
  const files = {
    "third_party/runtime/examples/fa.md": PERSIAN,
    "third_party/runtime.manifest.json": "{}",
    "README.md": "# English only\\n",
  };
  assert.equal(holds(repo(t, files), { vendor: { path: "third_party/runtime" } }), true);
  assert.equal(holds(repo(t, { ...files, "src/a.js": `export const name = "${PERSIAN}";` }), { vendor: { path: "third_party/runtime" } }), false);
});


test("nested vendor source cannot forge Persian site or diagram applicability", (t) => {
  const nested = repo(t, {
    "site/kit/showcase/fa.html": '<html lang="fa"><body>پروژه فارسی</body></html>',
    "site/kit/locales/fa/notes.md": PERSIAN,
    "site/kit.manifest.json": "{}",
    "src/site.js": "export const name = 'English-only site';",
  });
  const facts = repoFacts(nested, { vendor: { path: "site/kit" } });
  assert.equal(facts.vendoredKit, true, "dependency provenance is still enforced");
  assert.equal(facts.persianSite, false, "dependency HTML cannot declare the product's locale");
  assert.equal(facts.persianText, false, "dependency text cannot require a first-party language ledger");
  assert.equal(PREDICATES["no-persian-site"].holds(facts), true);
  assert.equal(PREDICATES["no-persian-content"].holds(facts), true);

  const withOwnFa = repo(t, {
    "site/kit/example.html": '<html lang="fa"><body>پروژه فارسی</body></html>',
    "src/page.html": '<html lang="fa"><body>پروژه فارسی</body></html>',
  });
  assert.equal(repoFacts(withOwnFa, { vendor: { path: "site/kit" } }).persianText, true,
    "authored Persian markup remains applicable and cannot be exempted");
});
