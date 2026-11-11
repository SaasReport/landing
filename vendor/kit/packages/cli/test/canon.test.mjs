// kit check canon (docs/CONSTITUTION.md): every check passes on a clean repository and catches its own kind of drift:
// an invalid canon, a data file off its schema, a route missing from its contract (and a contract path no code serves),
// a hardcoded project name / colour / copy / secret, allow-list entries (allowed, stale, expired), a stale generator.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { main } from "../src/index.js";
import { runCanon, routeLiterals, contractPathCovers, bundled } from "../src/canon/index.js";
import { loadPolicy, syncClaude } from "../src/claude.js";
import { literals } from "../src/canon/files.js";
import { scanSource, registryMatchers } from "../src/canon/hardcoding.js";
import { generateTarget, writeTarget } from "../../sdk/src/index.js";
import { installGuard } from "./guard-fixture.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const TMP = fileTempDir("kit-canon-");

const SCHEMA = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json";
const ALLOW = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon-allow.schema.json";

function repo(name, files) {
  const root = join(TMP, name);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  return root;
}

const OPENAPI = { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: { "/api/a": { get: { operationId: "getA", tags: ["a"], summary: "A", responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object" } } } } } } }, "/api/items/{id}": { get: { operationId: "getItem", tags: ["items"], summary: "An item", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object" } } } } } } } } };
const SDK = { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/sdk-config.schema.json", generator: "forge", targets: [{ name: "saasreport", contract: "contracts/openapi.json", out: "sdk/saasreport" }] };
/** The repository with its Forge-generated SDK written (kit check sdk: every OpenAPI contract has one). */
async function withSdk(root) {
  const g = await generateTarget(root, SDK.targets[0]);
  assert.deepEqual(g.problems, []);
  writeTarget(root, SDK.targets[0], g.files);
  syncClaude(root, loadPolicy(root, bundled()).policy);      // the cost standard is on by default: a clean repository carries it (docs/COST.md)
  installGuard(root, { mode: "source" });                      // so is the enforcement foundation (docs/AGENT-GUARD.md), run from the kit at its head (docs/FRESHNESS.md)
  return root;
}
// the site template of the freshness verifier (docs/FRESHNESS.md): a site that vendors the kit carries it, and its daily cron is a reviewed schedule exception
const FRESHNESS_TEMPLATE = readFileSync(new URL("../../../templates/ci/staleness.yml", import.meta.url), "utf8");
const FRESHNESS_CRON = FRESHNESS_TEMPLATE.match(/cron: '([^']+)'/)[1];
const clean = () => ({
  "kit.canon.json": {
    $schema: SCHEMA, project: "saasreport",
    schemas: [{ files: ["data/*.json"], schema: "schemas/item.schema.json" }, { module: "config.js", schema: "schemas/item.schema.json" }],
    contracts: [{ name: "api", type: "openapi", contract: "contracts/openapi.json", sources: ["src"] }],
    hardcoding: { paths: ["src"], allow: "canon.allow.json" },
    freshness: [{ name: "gen", command: "true", outputs: ["out.txt"] }],
    digits: { locale: "fa", files: ["site/**/*.html", "site/**/*.md"], exclude: [{ files: "site/en/**", reason: "the English edition: Latin digits are its own" }] },
    persian: "persian.config.json",
    tokens: { module: "tokens.js", sources: ["tokens.js"], paths: ["src", "site"] },
    spelling: { variant: "en-GB", paths: ["README.md"], exceptions: "spelling.exceptions.json" },
    workflows: { runner: "ubuntu-24.04", ci: { schedule_exceptions: [{ cron: FRESHNESS_CRON, reason: "the daily freshness verifier: staleness is measured against the live remote head" }] } },      // the guard fixture carries a workflow (guard-fixture.mjs), so the CI policy applies
    notApplicable: { diagrams: { predicate: "no-diagrams" }, vendor: { predicate: "no-vendored-kit" }, resilience: { predicate: "no-deployed-workers" }, release: { predicate: "no-deployed-workers" } },
  },
  ".github/workflows/staleness.yml": FRESHNESS_TEMPLATE,
  ".github/CODEOWNERS": "/kit.canon.json @owner\n/canon.allow.json @owner\n",
  ".gitignore": "node_modules/\n.claude/worktrees/\n",
  "README.md": "# A fixture\n\nThis repository exists only to prove the canon checks, and every sentence in it is plain British English prose for the checker to read.\n",
  "spelling.exceptions.json": { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/spelling-exceptions.schema.json", exceptions: [] },
  "tokens.js": "export default { color: { accent: \"#123456\" } };\n",
  "persian.config.json": { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/persian-config.schema.json", sources: [{ files: ["content/*.md"] }] },
  "content/post.md": "---\ntitle: پرداخت خسارت\n---\nخسارت پرداخت می‌شود و پرونده‌ها بسته می‌شوند.\n",
  "site/index.html": '<!doctype html><html lang="fa"><body><p>۱۲ واژه، نسخه v1.2 و <code>T+1</code></p><a href="/blog/2">بلاگ</a></body></html>\n',
  "site/index.md": "---\ntitle: خانه\n---\n۳ قسمت در [بلاگ](https://x.example/2)\n",
  "site/en/index.html": '<html lang="en"><p>12 terms</p></html>\n',
  "schemas/item.schema.json": { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "urn:test:item", type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[a-z]+$" } } },
  "data/one.json": { id: "one" },
  "config.js": "export default { id: \"cfg\" };\n",
  "contracts/openapi.json": OPENAPI,
  "src/worker.js": "// /api/legacy in a comment is not a route\nexport const routes = [\"/api/a\", `/api/items/${id}`];\nconst css = (c) => `color:${c.accent}`;\n",
  "canon.allow.json": { $schema: ALLOW, entries: [] },
  "kit.sdk.json": SDK,
});

const spawnOk = async (cmd, args) => (args[1] === "false" ? 1 : 0);

test("a clean repository passes every check", async () => {
  const root = await withSdk(repo("clean", clean()));
  const r = await runCanon(root, { spawn: spawnOk });
  assert.equal(r.ok, true, JSON.stringify(r.results, null, 2));
  assert.deepEqual(Object.keys(r.results), ["canon", "schemas", "contracts", "sdk", "hardcoding", "freshness", "diagrams", "digits", "persian", "vendor", "spelling", "tokens", "claude", "enforcement", "resilience", "release", "findings", "concepts", "migrations"]);
  assert.match(r.results.digits.summary, /^2 Persian files scanned; 0 numbers/);
});

test("t=0: not configured fails; not applicable only by a predicate the kit proves from files; a stale or false declaration fails; nothing is waived by words", async () => {
  const f = clean();
  delete f["kit.canon.json"].notApplicable.vendor;
  const r = await runCanon(repo("nc", f), { only: ["vendor"] });
  assert.equal(r.ok, false);
  assert.equal(r.results.vendor.summary, "NOT CONFIGURED");
  assert.equal(r.results.vendor.configured, false);
  assert.match(r.results.vendor.problems[0].problem, /NOT CONFIGURED.*"predicate": "no-vendored-kit"/);
  const ok = await runCanon(repo("na", clean()), { only: ["vendor"] });
  assert.equal(ok.ok, true);
  assert.match(ok.results.vendor.summary, /^not applicable \(no-vendored-kit: the repository has no vendored kit snapshot or manifest \(kit\.canon\.json vendor\.path, or vendor\/kit\)/);
  // a free-text reason waives nothing: the schema has no such field
  const words = clean(); words["kit.canon.json"].notApplicable.vendor = { reason: "we simply do not want it, thank you very much" };
  assert.match((await runCanon(repo("words", words))).results.canon.problems.map((x) => x.problem).join("\n"), /predicate: is required|unknown property "reason"/);
  // a predicate that does not hold: the repository has a vendored kit
  const held = clean(); held["vendor/kit/x.js"] = "export {};\n"; held["vendor/kit.manifest.json"] = "{}";
  const bad = await runCanon(repo("pred-false", held), { only: ["vendor"] });
  assert.equal(bad.ok, false);
  assert.match(bad.results.vendor.problems[0].problem, /the predicate "no-vendored-kit" does not hold/);
  // a predicate of another check
  const other = clean(); other["kit.canon.json"].notApplicable.vendor = { predicate: "no-diagrams" };
  assert.match((await runCanon(repo("pred-other", other), { only: ["vendor"] })).results.vendor.problems[0].problem, /does not apply to vendor/);
  // a declaration for a configured check is stale; claude can never be declared
  const g = clean(); g["kit.canon.json"].notApplicable.digits = { predicate: "no-persian-site" };
  const stale = await runCanon(repo("stale-na", g), { only: ["digits"], spawn: spawnOk });
  assert.equal(stale.ok, false);
  assert.match(stale.results.digits.problems.at(-1).problem, /notApplicable\.digits is declared but digits is configured/);
});

test("t=0: a configured check that checked nothing fails (checked = 0), whatever its summary says", async () => {
  const f = clean(); f["kit.canon.json"].hardcoding.paths = ["nowhere"];
  const r = await runCanon(repo("zero", f), { only: ["hardcoding"] });
  assert.equal(r.ok, false);
  assert.equal(r.results.hardcoding.configured, true);
  assert.equal(r.results.hardcoding.checked, 0);
  assert.match(r.results.hardcoding.problems.at(-1).problem, /checked nothing \(checked = 0\)/);
  const z = clean(); z["kit.canon.json"].freshness = []; z["kit.canon.json"].schemas = [];
  const e = await runCanon(repo("empty", z), { only: ["freshness", "schemas"], spawn: spawnOk });
  assert.equal(e.results.freshness.summary, "NOT CONFIGURED");
  assert.equal(e.results.schemas.summary, "NOT CONFIGURED");
});

test("t=0: every check returns the structured signal { configured, checked }, no string is matched", async () => {
  const root = await withSdk(repo("signal", clean()));
  const r = await runCanon(root, { spawn: spawnOk });
  for (const [name, x] of Object.entries(r.results)) {
    if (name === "canon") continue;
    if (x.notApplicable) { assert.equal(x.configured, false); continue; }
    assert.equal(typeof x.configured, "boolean", name);
    assert.equal(typeof x.checked, "number", name);
    if (x.configured) assert.ok(x.checked > 0, `${name} checked something`);
  }
});

test("the canon and its waivers need the owner: CODEOWNERS must cover kit.canon.json and canon.allow.json, and not with a placeholder", async () => {
  const f = clean(); delete f[".github/CODEOWNERS"];
  const r = await runCanon(repo("no-owners", f), { only: [], govern: true });
  assert.equal(r.ok, false);
  assert.match(r.results.canon.problems.map((x) => x.problem).join("\n"), /not covered by CODEOWNERS/);
  const p = clean(); p[".github/CODEOWNERS"] = "/kit.canon.json @OWNER\n/canon.allow.json @OWNER\n";
  assert.match((await runCanon(repo("placeholder", p), { only: [], govern: true })).results.canon.problems[0].problem, /placeholder @OWNER/);
});

test("canon: missing, off-schema, or naming an unknown project", async () => {
  let r = await runCanon(repo("none", { "x.txt": "" }));
  assert.match(r.results.canon.problems[0].problem, /missing/);
  const f = clean(); f["kit.canon.json"] = { ...f["kit.canon.json"], project: "nope", extra: true };
  r = await runCanon(repo("bad-canon", f), { only: [], govern: true });
  const p = r.results.canon.problems.map((x) => x.problem).join("\n");
  assert.match(p, /unknown property "extra"/); assert.match(p, /project "nope" is not in the registry/);
});

test("schemas: a file or module export off its schema, and a rule that matches nothing", async () => {
  const f = clean();
  f["data/two.json"] = { id: "Two" };
  f["config.js"] = "export default { name: 1 };\n";
  f["kit.canon.json"].schemas.push({ files: ["nothing/*.json"], schema: "kit-config" });
  const r = await runCanon(repo("schemas", f), { only: ["schemas"] });
  const p = r.results.schemas.problems.map((x) => `${x.file}: ${x.problem}`).join("\n");
  assert.match(p, /data\/two\.json: .*\/id: must match/);
  assert.match(p, /config\.js: .*\/id: is required/);
  assert.match(p, /nothing\/\*\.json: matches no file/);
  assert.equal(r.ok, false);
});

test("contracts: a route the contract lacks, and a contract path no code serves", async () => {
  const f = clean();
  f["src/worker.js"] += "export const extra = \"/api/new\";\n";
  f["contracts/openapi.json"] = { ...OPENAPI, paths: { ...OPENAPI.paths, "/api/gone": { get: { responses: { 200: { description: "ok" } } } } } };
  const r = await runCanon(repo("contracts", f), { only: ["contracts"] });
  const p = r.results.contracts.problems.map((x) => x.problem).join("\n");
  assert.match(p, /route \/api\/new is in the code .* but not in contract "api"/);
  assert.match(p, /path \/api\/gone is in contract "api" but no route literal/);
  assert.doesNotMatch(p, /legacy/, "comments are not routes");
});

test("hardcoding: findings fail; a per-instance entry allows; no wildcard, no expiry; stale entries fail; secrets are never printed", async () => {
  const f = clean();
  f["src/brand.js"] = "export const a = \"SaasReport\";\nexport const b = \"https://saasreport.ai/x\";\nexport const c = \"#FF5A00\";\nexport const d = \"سلام دنیا\";\nexport const e = \"saasreport-web\";\n// \"#000000\" in a comment\nexport const key = \"ghp_" + "a".repeat(36) + "\";\n";
  let r = await runCanon(repo("hc", f), { only: ["hardcoding"] });
  const cats = r.results.hardcoding.findings.map((x) => x.category).sort();
  assert.deepEqual([...new Set(cats)], ["copy-literal", "hex-colour", "project-name", "project-url", "secret"]);
  assert.ok(!JSON.stringify(r.results).includes("a".repeat(36)), "secrets are never printed");
  assert.equal(r.ok, false);
  const one = (category, match, context, reason = "test fixture: this one instance is allowed") => ({ file: "src/brand.js", category, match, context, reason });
  f["canon.allow.json"] = { $schema: ALLOW, entries: [
    one("project-name", "SaasReport", "export const a"), one("project-name", "saasreport-", "export const e"),
    one("project-url", "https://saasreport.ai/x", "export const b"), one("hex-colour", "#FF5A00", "export const c ="),
    one("copy-literal", "سلام دنیا", "export const d"), one("secret", "<redacted:github-token>", "export const key"),
    { file: "src/none.js", category: "hex-colour", match: "#000000", context: "const none", reason: "stale: matches nothing" },
  ] };
  r = await runCanon(repo("hc2", f), { only: ["hardcoding"] });
  assert.equal(r.results.hardcoding.findings.length, 0, JSON.stringify(r.results.hardcoding.findings));
  assert.match(r.results.hardcoding.problems.map((x) => x.problem).join("\n"), /stale allow-list entry .*src\/none\.js/);
  // the same literal on another line is another instance: the entry's context names the line
  f["src/brand.js"] += "export const c2 = \"#FF5A00\";\n";
  f["canon.allow.json"].entries.pop();
  r = await runCanon(repo("hc3", f), { only: ["hardcoding"] });
  assert.deepEqual(r.results.hardcoding.findings.map((x) => [x.category, x.match, x.line]), [["hex-colour", "#FF5A00", 8]]);
});

test("canon-allow schema: no wildcard match, no glob path, no expiry, a context of 4 or more characters", async () => {
  const kit = bundled(), schema = kit.byName("canon-allow");
  const ok = { file: "src/a.js", category: "hex-colour", match: "#FF5A00", context: "const c", reason: "test fixture: allowed" };
  const check = (e) => kit.validator.validate({ $schema: ALLOW, entries: [e] }, schema).length;
  assert.equal(check(ok), 0);
  assert.ok(check({ ...ok, match: "*" }), "a wildcard match is refused");
  assert.ok(check({ ...ok, file: "src/**/*.js" }), "a glob is refused");
  assert.ok(check({ ...ok, until: "2099-01-01" }), "an expiry is refused");
  assert.ok(check({ ...ok, context: "ab" }), "a context under 4 characters is refused");
  const { context, ...noContext } = ok;
  assert.ok(check(noContext), "a context is required");
});

test("hardcoding scope is the same everywhere: test files are out of it; copy in data a schemas rule validates is content; the same copy in code is a finding", async () => {
  const f = clean();
  f["src/pack.js"] = "export const PACK = { greeting: \"سلام دنیا\" };\n";
  f["src/logic.js"] = "export const hi = () => \"سلام دنیا\";\n";
  f["src/logic.test.js"] = "export const t = \"#FF5A00 SaasReport\";\n";
  f["src/test/fixture.js"] = "export const t = \"https://saasreport.ai\";\n";
  f["kit.canon.json"].schemas.push({ module: "src/pack.js", export: "PACK", schema: "schemas/pack.schema.json" });
  f["schemas/pack.schema.json"] = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "urn:test:pack", type: "object", required: ["greeting"] };
  const r = await runCanon(repo("scope", f), { only: ["hardcoding"] });
  assert.deepEqual(r.results.hardcoding.findings.map((x) => [x.file, x.category]), [["src/logic.js", "copy-literal"]]);
});

test("freshness: a generator whose check fails is stale", async () => {
  const f = clean(); f["kit.canon.json"].freshness.push({ name: "bad", command: "false", outputs: ["gen/out.json"] });
  const r = await runCanon(repo("fresh", f), { only: ["freshness"], spawn: spawnOk });
  assert.match(r.results.freshness.problems[0].problem, /stale: "false" exited 1/);
});

test("digits: Latin digits in Persian output fail (HTML, Markdown, rendered pages); English pages and reasoned excludes pass", async () => {
  const f = clean();
  f["site/about/index.html"] = '<html lang="fa"><head><title>درباره ما</title></head><body><p aria-label="گام 2">سال 2026</p><p>۱۴۰۵ · مهر</p></body></html>';
  f["site/about/index.md"] = "# درباره 3\n";
  f["site/other.html"] = '<html lang="en"><p>2026</p></html>';
  f["kit.canon.json"].digits.files.push("site/**/*.svg");
  f["kit.canon.json"].digits.render = { command: "mkdir -p .out && printf '<p>قسمت 4</p>' > .out/ep.html", dir: ".out" };
  f["kit.canon.json"].digits.exclude.push({ files: "site/none/**", reason: "a stale entry that matches nothing" });
  const root = repo("digits", f);
  const { spawn } = await import("node:child_process");
  const run = (cmd, args, o) => new Promise((ok) => spawn(cmd, args, { ...o, stdio: "ignore" }).on("close", ok));
  const r = await runCanon(root, { only: ["digits"], spawn: run });
  assert.equal(r.ok, false);
  const got = r.results.digits.problems.map((p) => `${p.file} ${p.problem.split(" in ")[0]}`);
  assert.deepEqual(got, [
    ".out/ep.html:1 latin-digit text «4»",
    "site/about/index.html:1 latin-digit attr:aria-label «2»",
    "site/about/index.html:1 latin-digit text «2026»",
    "site/about/index.html:1 bidi-dot text «۵ ·»",
    "site/about/index.md:1 latin-digit md «3»",
    "site/none/** stale exclude (matches no file; remove it)",
  ]);
  const off = clean(); off["kit.canon.json"].digits.exclude = [{ files: "site/en/**", reason: "short" }];
  assert.equal((await runCanon(repo("digits-reason", off), { only: ["digits"] })).results.canon.ok, false);
});

test("kit check canon / kit check <one> through the CLI (exit codes, --json)", async () => {
  const root = await withSdk(repo("cli", clean()));
  const io = (out, err) => ({ cwd: root, env: {}, out: (s) => out.push(s), err: (s) => err.push(s), spawn: spawnOk, fetch: () => { throw new Error("no network"); } });
  let out = [], err = [];
  assert.equal(await main(["check", "canon"], io(out, err)), 0, err.join("\n"));
  assert.match(out.join("\n"), /ok hardcoding: 1 file; 0 findings/);
  out = []; err = [];
  assert.equal(await main(["check", "contracts", "--json"], io(out, err)), 0);
  assert.equal(JSON.parse(out.join("\n")).results.contracts.ok, true);
  assert.equal(await main(["check", "nope"], io([], [])), 2);   // a usage error: the command table refuses it before kit check runs
});

test("literal scanner: comments and regex literals skipped, template expressions kept, routes folded", () => {
  const src = "const a = /\"#FFFFFF\"/g; // \"#000000\"\n/* 'SaasReport' */ const b = `x ${y} \"#ABCDEF\"`; const c = 'it\\'s';";
  const vals = literals(src).map((l) => l.value);
  assert.deepEqual(vals, ["x ${y} \"#ABCDEF\"", "it\\'s"]);
  const m = registryMatchers({ projects: [{ name: "SaasReport", domain: "saasreport.ai", prefix: "saasreport-", short: "saasreport-" }], legacy: [{ prefix: "old-" }] });
  assert.deepEqual(scanSource("f.js", "import x from \"@saasreport/core\"; const n = \"@saasreport/site\"; const k = 'old-date-picker';", m).map((x) => x.match), ["old-"]);
  const root = repo("routes", { "s/a.js": "const p = `/api/forms/${id}`; const q = \"/mcp\"; const r = \"/apix\";", "s/b.js": "const m = url.pathname.match(/^\\/api\\/leads\\/([a-z-]+)$/);" });
  assert.deepEqual([...routeLiterals(root, ["s"])].sort(), ["/api/forms/{}", "/api/leads/{}", "/mcp"]);
});

test("canonical OpenAPI parameter segments cover actual /api/forms/sandbox-key without duplicate contracts", async () => {
  assert.equal(contractPathCovers("/api/forms/{form}", "/api/forms/sandbox-key"), true);
  assert.equal(contractPathCovers("/api/forms/{form}", "/api/forms/sandbox-key/claim"), false);
  assert.equal(contractPathCovers("/api/forms/{form}", "/api/unknown/sandbox-key"), false);
  const f = clean();
  f["contracts/openapi.json"] = { ...OPENAPI, paths: {
    ...OPENAPI.paths,
    "/api/forms/{form}": { post: { operationId: "submitForm", tags: ["forms"],
      summary: "Submit a canonical form", parameters: [
        { name: "form", in: "path", required: true, schema: { type: "string" } }
      ], responses: { 200: { description: "accepted" } } } }
  } };
  f["src/worker.js"] += '\\nconst sandboxRegistration = "/api/forms/sandbox-key";\\n';
  const r = await runCanon(repo("templated-concrete", f), { only: ["contracts"] });
  assert.deepEqual(r.results.contracts.problems, [], JSON.stringify(r.results.contracts.problems));
  f["src/worker.js"] += '\\nconst uncontracted = "/api/unknown/sandbox-key";\\n';
  const rejected = await runCanon(repo("templated-negative", f), { only: ["contracts"] });
  assert.ok(rejected.results.contracts.problems.some((x) => x.problem.includes("route /api/unknown/sandbox-key")), "uncontracted literal is refused");
});
