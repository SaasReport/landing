// kit check spelling and kit check tokens (docs/CONSTITUTION.md): a British English project's content carries no
// American spelling outside code, URLs and its reviewed exceptions (the one list the podcast check reads too), and no
// design-token colour is written as a literal outside the token sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { runCanon } from "../src/canon/index.js";
import { textsOf } from "../src/canon/spelling.js";
import { usSpellings, britishSpelling } from "@saasreport/core/spelling";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const TMP = fileTempDir("kit-spell-");

const SCHEMA = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json";
const EXC = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/spelling-exceptions.schema.json";

function repo(name, files) {
  const root = join(TMP, name);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  return root;
}
const canon = (extra) => ({ $schema: SCHEMA, project: "saasreport", ...extra });
const spelling = { variant: "en-GB", paths: ["src/content"], exceptions: "spelling.exceptions.json" };
const exceptions = (list) => ({ $schema: EXC, exceptions: list });
const ACP = { phrase: "completed or canceled", kind: "protocol", reason: "the ACP checkout session states, as the API spells them" };

test("spelling: British content passes; an American spelling in a literal is reported with its line", async () => {
  const ok = repo("gb", {
    "kit.canon.json": canon({ spelling }),
    "spelling.exceptions.json": exceptions([ACP]),
    // code is not text: an object key, a CSS property inside a style string, a module specifier, a code span
    "src/content/a.js": 'import x from "./color.js";\nexport default [{ color: "#123", title: "The colour of money", body: "Sessions end completed or canceled; the `canceled` state is final.", style: "<b style=\\"color:red\\">Organise</b>" }];\n',
    "src/content/b.md": "# Licences\n\nThe licence of a library. ```\ncolor = 1\n``` and https://example.org/color\n",
  });
  const r = await runCanon(ok, { only: ["spelling"] });
  assert.equal(r.results.spelling.ok, true, JSON.stringify(r.results.spelling.problems));

  const bad = repo("us", {
    "kit.canon.json": canon({ spelling }),
    "spelling.exceptions.json": exceptions([ACP]),
    "src/content/a.js": 'export default [{ title: "Completed or canceled", body: "line one\\nand the color of the organization" },\n  { body: "the license is canceled" }];\n',
  });
  const p = (await runCanon(bad, { only: ["spelling"] })).results.spelling.problems.map((x) => `${x.file} ${x.problem}`);
  assert.ok(p.some((x) => x.startsWith("src/content/a.js:1 American spelling \"color\"")), p.join("\n"));
  assert.ok(p.some((x) => x.includes("\"organization\" (British: \"organisation\")")), p.join("\n"));
  assert.ok(p.some((x) => x.startsWith("src/content/a.js:2 American spelling \"license\"")), p.join("\n"));
  assert.ok(p.some((x) => x.startsWith("src/content/a.js:2 American spelling \"canceled\"")), "canceled outside the protocol phrase and outside code is prose");
  assert.ok(!p.some((x) => x.includes(":1 American spelling \"canceled\"")), "the declared protocol phrase is kept");
});

test("spelling: exceptions are reviewed: a reason and a kind, no expiry date; stale entries fail", async () => {
  const base = { "kit.canon.json": canon({ spelling }), "src/content/a.js": 'export const t = "the MIT License";\n' };
  const expired = repo("expired", { ...base, "spelling.exceptions.json": exceptions([{ phrase: "unused phrase", kind: "name", reason: "nothing uses this any more" }]) });
  const p = (await runCanon(expired, { only: ["spelling"] })).results.spelling.problems.map((x) => x.problem).join("\n");
  assert.match(p, /stale exception "unused phrase"/);
  const invalid = repo("invalid", { ...base, "spelling.exceptions.json": exceptions([{ phrase: "MIT License", reason: "short" }]) });
  assert.match((await runCanon(invalid, { only: ["spelling"] })).results.spelling.problems.map((x) => x.problem).join("\n"), /required|must have/);
  const until = repo("until", { ...base, "spelling.exceptions.json": exceptions([{ phrase: "MIT License", kind: "name", reason: "the licence's own name", until: "2099-01-01" }]) });
  assert.match((await runCanon(until, { only: ["spelling"] })).results.spelling.problems.map((x) => x.problem).join("\n"), /unknown property "until"/, "there is no expiry date");
  const missing = repo("missing", base);
  assert.match((await runCanon(missing, { only: ["spelling"] })).results.spelling.problems[0].problem, /declared but missing/);
  // a project that is not en-GB declares no spelling block: the check does not run
  assert.equal((await runCanon(repo("none", { "kit.canon.json": canon({}) }), { only: ["spelling"] })).results.spelling.summary, "NOT CONFIGURED");
});

test("spelling (core): code spans, fences and URLs are never flagged nor rewritten; protocol phrases are kept", () => {
  assert.equal(britishSpelling("the `canceled` state, the color, ```\ncanceled\n``` and https://x.org/canceled"), "the `canceled` state, the colour, ```\ncanceled\n``` and https://x.org/canceled");
  assert.equal(britishSpelling("Ends completed or canceled.", { exceptions: [ACP] }), "Ends completed or canceled.");
  assert.equal(britishSpelling("It was canceled.", { exceptions: [ACP] }), "It was cancelled.");
  assert.deepEqual(usSpellings("A `canceled` session and the canceled order").map((x) => x.us), ["canceled"]);
  assert.deepEqual(usSpellings("organized, authorizing, unauthorized").map((x) => x.gb), ["organised", "authorising", "unauthorised"]);
});

test("spelling: what is text in each file type", () => {
  assert.deepEqual(textsOf("a.js", 'const color = "Colour"; // color\nexport { x } from "./color.js";\n').map((x) => x.text), ["Colour"]);
  assert.deepEqual(textsOf("a.json", '{ "color": "grey", "n": ["center"] }').map((x) => x.text), ["grey", "center"]);
  assert.doesNotMatch(textsOf("a.html", '<p style="color:red">Hi</p><code>color</code><script>color</script>')[0].text, /color/);
});

test("tokens: a token colour written outside the token sources fails; reading the token passes", async () => {
  const files = {
    "kit.canon.json": canon({ tokens: { module: "src/tokens.js", sources: ["src/tokens.js", "src/brand.json"], paths: ["src"] } }),
    "src/brand.json": { accent: "#6B2177" },
    "src/tokens.js": 'import { readFileSync } from "node:fs";\nconst B = JSON.parse(readFileSync(new URL("./brand.json", import.meta.url), "utf8"));\nexport default { color: { accent: B.accent, ok: "#137A39", surface: "#FFFFFF" } };\n',
    "src/pages/brand.js": 'import T from "../tokens.js";\nexport const swatches = [{ name: "Success", hex: T.color.ok }, { name: "Paper", hex: T.color.surface }];\n',
  };
  assert.equal((await runCanon(repo("tok-ok", files), { only: ["tokens"] })).results.tokens.ok, true);
  const bad = repo("tok-bad", { ...files, "src/pages/brand.js": 'export const swatches = [{ name: "Success", hex: "#137a39" }, { name: "Accent", hex: "#6B2177" }];\n' });
  const p = (await runCanon(bad, { only: ["tokens"] })).results.tokens.problems.map((x) => `${x.file} ${x.problem}`);
  const dup = p.filter((x) => /is color\.\w+: read the token/.test(x));   // the token-value rule; the colour canon adds its own literal finding per colour
  assert.deepEqual(dup.map((x) => x.split(" ")[0]), ["src/pages/brand.js:1", "src/pages/brand.js:1"]);
  assert.match(dup[0], /#137a39 is color\.ok: read the token/);
  assert.match(dup[1], /#6B2177 is color\.accent/);
  assert.equal(p.filter((x) => /colour literal/.test(x)).length, 2, "and the colour canon flags each literal");
});

test("validate, then use: a malformed exceptions file, allow-list or canon is reported, never scanned with", async () => {
  // exceptions as an object instead of a list: reported by the schema, no TypeError, nothing scanned
  const bad = repo("malformed", {
    "kit.canon.json": canon({ spelling, hardcoding: { paths: ["src"], allow: "canon.allow.json" } }),
    "spelling.exceptions.json": { $schema: EXC, exceptions: { phrase: "x" } },
    "canon.allow.json": { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon-allow.schema.json", entries: { file: "x" } },
    "src/content/a.js": 'export const t = "the color";\n',
  });
  const r = await runCanon(bad, { only: ["spelling", "hardcoding"] });
  assert.equal(r.results.spelling.ok, false);
  assert.match(r.results.spelling.summary, /invalid, nothing scanned/);
  assert.ok(r.results.spelling.problems.every((p) => p.file === "spelling.exceptions.json"), JSON.stringify(r.results.spelling.problems));
  assert.match(r.results.hardcoding.summary, /invalid, nothing scanned/);
  // a canon off its schema: reported, and no check runs on it
  const c = await runCanon(repo("bad-canon", { "kit.canon.json": canon({ spelling: { variant: "en-US" } }) }), { only: ["spelling"] });
  assert.equal(c.ok, false);
  assert.equal(c.results.spelling, undefined);
  assert.ok(c.results.canon.problems.length);
});
