// @saasreport/sdk: generation through the kit's native Forge (@saasreport/forge), the generated client, CLI and Python
// client, and kit check sdk on every failure it exists for (missing, stale, hand-edited, added, duplicate
// hand-written client, naming).
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { adapt, checkSdk, generateTarget, writeTarget, fetchCalls, ownNames, ownedBy, FORGE, MANIFEST_FILE } from "../src/index.js";
import { tsType, ORIGIN } from "../../forge/src/index.js";
import { bundled } from "../../cli/src/canon/index.js";
import { formatProblems } from "@saasreport/core/schema";
import { main as kit } from "../../cli/src/index.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const FIXTURE = fileURLToPath(new URL("./fixture/", import.meta.url));
const kitSchemas = bundled();
const validate = (v, name) => formatProblems(kitSchemas.validator.validate(v, kitSchemas.byName(name)));
const target = { name: "saasreport", contract: "contracts/openapi.json", out: "sdk/saasreport", cli: "saasreport" };

function repo(t) {
  const dir = tempDir(t, "kit-sdk-");
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
const canonOf = (dir) => JSON.parse(readFileSync(join(dir, "kit.canon.json"), "utf8"));
const check = (dir) => checkSdk(dir, { canon: canonOf(dir), registry: kitSchemas.registry, validate });
async function generated(t) {
  const dir = repo(t);
  const g = await generateTarget(dir, target);
  assert.deepEqual(g.problems, []);
  writeTarget(dir, target, g.files);
  return dir;
}
const problemsOf = (r) => r.problems.map((p) => `${p.file}: ${p.problem}`);

test("native Forge: no vendored bundle, no build step; the manifest names @saasreport/forge and its upstream origin", () => {
  assert.equal(existsSync(fileURLToPath(new URL("../vendor", import.meta.url))), false, "no vendor directory");
  assert.equal(existsSync(fileURLToPath(new URL("../scripts/vendor-forge.mjs", import.meta.url))), false, "no bundler script");
  assert.equal(FORGE.package, "@saasreport/forge");
  assert.equal(FORGE.license, "Apache-2.0");
  assert.equal(FORGE.origin.commit, ORIGIN.origin.commit);
  assert.match(FORGE.origin.commit, /^[0-9a-f]{40}$/);
});

test("adapter: the kit's policy only (3.1, a summary, a 2xx); what Forge used to drop now generates", () => {
  const doc = JSON.parse(readFileSync(join(FIXTURE, "contracts/openapi.json"), "utf8"));
  assert.deepEqual(adapt(doc).problems, []);
  delete doc.paths["/api/health"].get.operationId;
  delete doc.paths["/api/items/{id}"].get.tags;
  doc.paths["/api/x"] = { head: { operationId: "x", tags: ["t"], summary: "x", responses: { 200: { description: "ok" } } } };
  assert.deepEqual(adapt(doc).problems, [], "no operationId, no tag, HEAD: all fine");
  doc.openapi = "3.0.3";
  doc.paths["/api/y"] = { get: { responses: { 404: { description: "none" } } } };
  const p = adapt(doc, "c").problems.join("\n");
  assert.match(p, /openapi 3\.0\.3/);
  assert.match(p, /GET \/api\/y has no summary or description/);
  assert.match(p, /GET \/api\/y declares no 2xx response/);
});

test("types: JSON Schema 2020-12 → TypeScript", () => {
  assert.equal(tsType({ type: ["string", "null"] }), "string | null");
  assert.equal(tsType({ enum: ["a", 1] }), '"a" | 1');
  assert.equal(tsType({ $ref: "#/components/schemas/Item" }), 'Schemas["Item"]');
  assert.equal(tsType({ type: "array", items: { type: "integer" } }), "number[]");
  assert.match(tsType({ type: "object", required: ["a"], properties: { a: { type: "string" }, b: { const: true } } }), /a: string;\n\s+b\?: true;/);
  assert.equal(tsType({}), "unknown");
});

test("generate: Forge's command tree, deterministic files, a checksum manifest", async (t) => {
  const dir = repo(t);
  const a = await generateTarget(dir, target);
  const b = await generateTarget(dir, target);
  assert.deepEqual(a.problems, []);
  assert.deepEqual(a.files.map((f) => f.path), ["cli.mjs", "index.d.ts", "index.mjs", "package.json", "python/pyproject.toml", "python/saasreport_sdk/__init__.py", "python/saasreport_sdk/py.typed", "README.md", MANIFEST_FILE]);
  assert.deepEqual(a.files, b.files, "same contract, same bytes");
  assert.equal(a.operations, 4);
  assert.deepEqual(validate(a.manifest, "sdk-manifest"), []);
  assert.deepEqual(a.manifest.generator.forge, { ...FORGE, targets: ["javascript", "python"] });
  assert.equal(a.manifest.contract.sha256, createHash("sha256").update(readFileSync(join(dir, target.contract), "utf8")).digest("hex"));
  const dts = a.files.find((f) => f.path === "index.d.ts").content;
  assert.match(dts, /export type GetItemParams = \{\n  id: string;\n  expand\?: boolean;\n\};/);
  assert.match(dts, /export type GetItemResponse = Schemas\["Item"\];/);
  assert.match(dts, /export type PutItemParams = \{\n  id: string;\n  \/\*\* Request body \(application\/json\) \*\/\n  body: Schemas\["Item"\];\n\};/);
  assert.match(dts, /export type PutItemResponse = undefined;/);
  assert.match(dts, /parent\?: Schemas\["Item"\] \| null;/);
  assert.match(dts, /items: \{[\s\S]*getItem\(params: GetItemParams/);
  const pkg = JSON.parse(a.files.find((f) => f.path === "package.json").content);
  assert.deepEqual(pkg.bin, { saasreport: "./cli.mjs" });
});

test("generated client: paths, queries, bodies, text responses and ApiError, against a fake fetch", async (t) => {
  const dir = await generated(t);
  const { createClient, ApiError } = await import(pathToFileURL(join(dir, target.out, "index.mjs")).href);
  const sent = [];
  const fetch = async (url, init) => {
    sent.push([init.method, url, init.body ?? null, init.headers["content-type"] ?? null]);
    if (url.includes("missing")) return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { "content-type": "application/json" } });
    if (url.includes(".ics")) return new Response("BEGIN:VCALENDAR", { headers: { "content-type": "text/calendar" } });
    if (init.method === "PUT") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: "a b", name: "n" }), { headers: { "content-type": "application/json" } });
  };
  const api = createClient({ baseUrl: "https://h.test/", fetch, headers: { authorization: "Bearer t" } });
  assert.deepEqual(await api.items.getItem({ id: "a b", expand: true }), { id: "a b", name: "n" });
  assert.equal(await api.items.putItem({ id: "x", body: { id: "x", name: "y" } }), undefined);
  assert.equal(await api.items.feed({ count: 3 }), "BEGIN:VCALENDAR");
  await assert.rejects(api.items.getItem({ id: "missing" }), (e) => e instanceof ApiError && e.status === 404 && e.operationId === "getItem");
  await assert.rejects(api.items.getItem({}), /missing required path parameter "id"/);
  await assert.rejects(api.items.putItem({ id: "x" }), /missing required body/);
  assert.deepEqual(sent.slice(0, 3), [
    ["GET", "https://h.test/api/items/a%20b?expand=true", null, null],
    ["PUT", "https://h.test/api/items/x", JSON.stringify({ id: "x", name: "y" }), "application/json"],
    ["GET", "https://h.test/api/feed.ics?count=3", null, null],
  ]);
});

test("generated CLI: help lists every operation; a call prints JSON", async (t) => {
  const dir = await generated(t);
  const { main } = await import(pathToFileURL(join(dir, target.out, "cli.mjs")).href);
  const out = [], err = [];
  const log = console.log, error = console.error, f = globalThis.fetch;
  console.log = (s) => out.push(String(s)); console.error = (s) => err.push(String(s));
  globalThis.fetch = async (url) => new Response(JSON.stringify({ url }), { headers: { "content-type": "application/json" } });
  try {
    assert.equal(await main(["--help"], {}), 0);
    assert.match(out.join("\n"), /saasreport items get-item --id <string> \[--expand <boolean>\]\n\s+GET \/api\/items\/\{id\}/);
    out.length = 0;
    assert.equal(await main(["items", "get-item", "--id", "7", "--base-url", "https://x.test"], {}), 0);
    assert.deepEqual(JSON.parse(out.join("")), { url: "https://x.test/api/items/7" });
    assert.equal(await main(["nope"], {}), 2);
  } finally { console.log = log; console.error = error; globalThis.fetch = f; }
});

test("kit check sdk: ok when every contract has a current, untouched generated SDK", async (t) => {
  const dir = await generated(t);
  const r = await check(dir);
  assert.deepEqual(problemsOf(r), []);
  assert.match(r.summary, /1 target for 1 contract, 4 operations, 9 generated files/);
});

test("kit check sdk: missing — a contract and no kit.sdk.json, a contract without a target, no generated output", async (t) => {
  const dir = repo(t);
  rmSync(join(dir, "kit.sdk.json"));
  assert.match(problemsOf(await check(dir)).join("\n"), /kit\.sdk\.json: missing: the repository has 1 OpenAPI contract \(contracts\/openapi\.json\) and no Forge-generated SDK/);
  cpSync(join(FIXTURE, "kit.sdk.json"), join(dir, "kit.sdk.json"));
  assert.match(problemsOf(await check(dir)).join("\n"), /sdk\/saasreport\/forge\.manifest\.json: missing: no generated SDK/);
  const canon = canonOf(dir);
  canon.contracts.push({ name: "Second", type: "openapi", contract: "contracts/second.json" });
  writeFileSync(join(dir, "kit.canon.json"), JSON.stringify(canon));
  assert.match(problemsOf(await check(dir)).join("\n"), /contracts\/second\.json: OpenAPI contract without a Forge-generated SDK/);
});

test("kit check sdk: stale — the contract changed after generation (regenerate-and-diff)", async (t) => {
  const dir = await generated(t);
  const file = join(dir, target.contract);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.paths["/api/health"].get.summary = "Liveness probe";
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const p = problemsOf(await check(dir)).join("\n");
  assert.match(p, /sdk\/saasreport: stale: contracts\/openapi\.json changed since the SDK was generated/);
});

test("kit check sdk: stale — the generator changed (manifest consistent, output differs from a regeneration)", async (t) => {
  const dir = await generated(t);
  const out = join(dir, target.out);
  const readme = join(out, "README.md");
  const text = readFileSync(readme, "utf8").replace("# saasreport-sdk", "# saasreport-sdk (older generator)");
  writeFileSync(readme, text);
  const m = JSON.parse(readFileSync(join(out, MANIFEST_FILE), "utf8"));
  m.files.find((f) => f.path === "README.md").sha256 = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(out, MANIFEST_FILE), JSON.stringify(m, null, 2));
  const p = problemsOf(await check(dir)).join("\n");
  assert.match(p, /README\.md: stale: differs from what kit sdk generate writes now/);
  assert.doesNotMatch(p, /hand-edited/);
});

test("kit check sdk: hand-edited — a generated file changed, a file added, a file removed", async (t) => {
  const dir = await generated(t);
  const out = join(dir, target.out);
  writeFileSync(join(out, "index.mjs"), readFileSync(join(out, "index.mjs"), "utf8").replace("export default createClient;", "export default createClient; // patched"));
  writeFileSync(join(out, "extra.mjs"), "export const x = 1;\n");
  rmSync(join(out, "README.md"));
  const p = problemsOf(await check(dir)).join("\n");
  assert.match(p, /index\.mjs: hand-edited: differs from the sha256 in forge\.manifest\.json/);
  assert.match(p, /extra\.mjs: not generated: added by hand/);
  assert.match(p, /README\.md: missing from the generated SDK/);
});

test("kit check sdk: duplicate — a hand-written fetch client, a copied generated file; a copy can never be allowed; per-instance entries, stale entries, no wildcard and no expiry", async (t) => {
  const dir = await generated(t);
  mkdirSync(join(dir, "src/test"), { recursive: true });
  writeFileSync(join(dir, "src/items.js"), "export const item = (id) => fetch(`/api/items/${id}`).then((r) => r.json());\n");
  writeFileSync(join(dir, "src/test/probe.js"), "fetch('/api/health');\n");   // test files are out of the scan, like the hardcoding scan
  cpSync(join(dir, target.out, "index.mjs"), join(dir, "src/copy.mjs"));
  let p = problemsOf(await check(dir)).join("\n");
  assert.match(p, /src\/items\.js:1: duplicate: hand-written client of \/api\/items\/\{\}/);
  assert.match(p, /src\/copy\.mjs:1: duplicate: a copy of a generated SDK file/);
  assert.doesNotMatch(p, /probe\.js/);
  const cfg = JSON.parse(readFileSync(join(dir, "kit.sdk.json"), "utf8"));
  cfg.allow = [
    { file: "src/items.js", path: "/api/items/{}", reason: "reviewed: a script served as a static asset, with no module loader" },
    { file: "src/gone.js", path: "/api/health", reason: "reviewed: a file that no longer exists in the tree" },
  ];
  writeFileSync(join(dir, "kit.sdk.json"), JSON.stringify(cfg));
  p = problemsOf(await check(dir)).join("\n");
  assert.doesNotMatch(p, /src\/items\.js/);
  assert.match(p, /stale allow entry \(matches nothing; remove it\): src\/gone\.js/);
  assert.match(p, /src\/copy\.mjs:1: duplicate: a copy of a generated SDK file/, "a copy cannot be allowed");
  cfg.allow.push({ file: "src/copy.mjs", path: "*", reason: "a wildcard is refused by the schema", until: "2999-01-01" });
  writeFileSync(join(dir, "kit.sdk.json"), JSON.stringify(cfg));
  p = problemsOf(await check(dir)).join("\n");
  assert.match(p, /allow\/2\/path: must match/);
  assert.match(p, /allow\/2\/until: unknown property "until"/);
});

test("kit check sdk: naming — a target or CLI outside the project's own prefix fails", async (t) => {
  const dir = await generated(t);
  const cfg = JSON.parse(readFileSync(join(dir, "kit.sdk.json"), "utf8"));
  cfg.targets[0].cli = "sr";
  cfg.targets[0].name = "openfinance";
  writeFileSync(join(dir, "kit.sdk.json"), JSON.stringify(cfg));
  const p = problemsOf(await check(dir)).join("\n");
  assert.match(p, /target openfinance: not saasreport's own prefix/);
  assert.match(p, /CLI sr is not saasreport's own prefix/);
});

test("naming: SaasReport has NO short form: saasreport-api is its SDK name; sr-api and a bare sr are refused", () => {
  const reg = kitSchemas.registry;
  const names = ownNames("saasreport", reg);
  assert.deepEqual(names, ["saasreport"], "key and full prefix are one name, no short");
  for (const ok of ["saasreport", "saasreport-api", "saasreport-web-client"]) assert.equal(ownedBy(ok, names), true, ok);
  for (const bad of ["sr", "sr-api", "saas-report-api", "other-api"]) assert.equal(ownedBy(bad, names), false, bad);
  // a registry with a project that has a short form: its names are its key, its full prefix and its short, each once; another project's names are refused
  const many = { projects: [{ key: "alpha", name: "Alpha", domain: "alpha.example", prefix: "alpha-", short: "al-" }, { key: "beta", name: "Beta", domain: "beta.example", prefix: "beta-", short: null }] };
  for (const p of [...reg.projects, ...many.projects]) {
    const r = reg.projects.includes(p) ? reg : many, own = ownNames(p.key, r);
    assert.equal(new Set(own).size, own.length, `${p.key}: ownNames lists a name twice (${own})`);
    assert.ok(own.includes(p.key) && (!p.short || own.includes(p.short.replace(/-$/, ""))), p.key);
    for (const q of r.projects.filter((x) => x.key !== p.key)) assert.equal(ownedBy(`${q.key}-api`, own), false, `${p.key} must not own ${q.key}-api`);
  }
  assert.deepEqual(ownNames("alpha", many), ["alpha", "al"]);
  assert.equal(ownedBy("al-api", ownNames("alpha", many)), true);
  assert.deepEqual(ownNames("kit", reg), ["kit"]);
  assert.deepEqual(ownNames("nope", reg), []);
});

test("kit check sdk: a target of a project with no short form is refused under sr- and accepted under saasreport-", async (t) => {
  const dir = await generated(t);
  const cfg = JSON.parse(readFileSync(join(dir, "kit.sdk.json"), "utf8"));
  const naming = async (name, cli) => {
    cfg.targets[0].name = name; if (cli) cfg.targets[0].cli = cli; else delete cfg.targets[0].cli;
    writeFileSync(join(dir, "kit.sdk.json"), JSON.stringify(cfg));
    const canon = { ...canonOf(dir), project: "saasreport" };
    return problemsOf(await checkSdk(dir, { canon, registry: kitSchemas.registry, validate })).filter((x) => /own prefix/.test(x)).join("\n");
  };
  assert.match(await naming("sr-api"), /target sr-api: not saasreport's own prefix \(saasreport\)/);
  assert.match(await naming("sr-api", "sr"), /CLI sr is not saasreport's own prefix/);
  assert.equal(await naming("saasreport-api", "saasreport"), "", "the full name is accepted");
});

test("fetchCalls: literal, template and absolute URLs; other paths ignored", () => {
  const hits = fetchCalls("fetch(\"/api/health\");\nawait fetch(`${base}/api/items/${id}?x=1`)\nfetch('/elsewhere')\nfetch(new URL('/api/health', origin))", ["/api/health", "/api/items/{}"]);
  assert.deepEqual(hits.map((h) => [h.line, h.path]), [[1, "/api/health"], [2, "/api/items/{}"], [4, "/api/health"]]);
});

test("kit sdk generate / kit check sdk (CLI): writes the SDK, then the check passes and catches an edit", async (t) => {
  const dir = repo(t);
  const out = [], err = [];
  const io = { cwd: dir, out: (s) => out.push(s), err: (s) => err.push(s) };
  assert.equal(await kit(["sdk", "generate"], io), 0, err.join("\n"));
  assert.match(out.join("\n"), /saasreport: 4 operations from contracts\/openapi\.json → sdk\/saasreport \(9 files; @saasreport\/forge [0-9.]+, origin [0-9a-f]{12}\)/);
  assert.equal(await kit(["sdk", "check"], io), 0, err.join("\n"));
  writeFileSync(join(dir, target.out, "cli.mjs"), "// mine\n");
  assert.equal(await kit(["check", "sdk"], io), 1);
  assert.match(err.join("\n"), /cli\.mjs: hand-edited/);
});

test("a required body whose schema is a bare object (Forge calls it empty) is kept, typed, sent, and required by the CLI", async (t) => {
  const dir = repo(t);
  const file = join(dir, target.contract);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.paths["/api/forms/{form}"] = { post: {
    operationId: "submitForm", tags: ["forms"], summary: "A lead form",
    parameters: [{ name: "form", in: "path", required: true, schema: { type: "string" } }],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
    responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
  } };
  writeFileSync(file, JSON.stringify(doc));
  const g = await generateTarget(dir, target);
  assert.deepEqual(g.problems, []);
  writeTarget(dir, target, g.files);
  const out = join(dir, target.out);
  assert.match(readFileSync(join(out, "index.d.ts"), "utf8"), /export type SubmitFormParams = \{\n  form: string;\n  \/\*\* Request body \(application\/json\) \*\/\n  body: Record<string, unknown>;\n\};/);
  const { createClient, OPERATIONS } = await import(pathToFileURL(join(out, "index.mjs")).href);
  assert.deepEqual(OPERATIONS.submitForm.body, { required: true, contentTypes: ["application/json"] });
  let sent;
  const api = createClient({ baseUrl: "https://h.test", fetch: async (url, init) => { sent = [url, init.body, init.headers["content-type"]]; return new Response("{}", { headers: { "content-type": "application/json" } }); } });
  await api.forms.submitForm({ form: "contact", body: { name: "N" } });
  assert.deepEqual(sent, ["https://h.test/api/forms/contact", '{"name":"N"}', "application/json"]);
  await assert.rejects(api.forms.submitForm({ form: "contact" }), /missing required body/);

  const { main } = await import(pathToFileURL(join(out, "cli.mjs")).href);
  const lines = [];
  const log = console.log, error = console.error, f = globalThis.fetch;
  console.log = (s) => lines.push(String(s)); console.error = (s) => lines.push(String(s));
  globalThis.fetch = async (url, init) => new Response(JSON.stringify({ url, body: init.body }), { headers: { "content-type": "application/json" } });
  try {
    assert.equal(await main(["forms", "submit-form", "--form", "contact", "--body", '{"a":1}', "--base-url", "https://x.test"], {}), 0);
    assert.deepEqual(JSON.parse(lines.join("")), { url: "https://x.test/api/forms/contact", body: '{"a":1}' });
    lines.length = 0;
    assert.equal(await main(["forms", "submit-form", "--form", "contact"], {}), 2, "a required body is missing");
    assert.match(lines.join("\n"), /needs a request body: --body <json>/);
    lines.length = 0;
    assert.equal(await main(["items", "get-item", "--id", "7", "--expnad", "true"], {}), 2, "a mistyped flag is refused");
    assert.match(lines.join("\n"), /unknown option --expnad for "items get-item"\n  saasreport items get-item --id <string> \[--expand <boolean>\]/);
  } finally { console.log = log; console.error = error; globalThis.fetch = f; }
});

test("regression: a POST with path-level parameters keeps its required body; a 2xx without content is typed undefined; no 2xx at all is refused", async (t) => {
  const dir = repo(t);
  const file = join(dir, target.contract);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.paths["/api/runs/{run}"] = {
    parameters: [{ name: "run", in: "path", required: true, schema: { type: "string" } }],
    post: {
      operationId: "startRun", tags: ["runs"], summary: "Start a run",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["date"], properties: { date: { type: "string" } } } } } },
      responses: { 202: { description: "accepted" } },
    },
  };
  writeFileSync(file, JSON.stringify(doc));
  const g = await generateTarget(dir, target);
  assert.deepEqual(g.problems, []);
  writeTarget(dir, target, g.files);
  const { createClient, OPERATIONS } = await import(pathToFileURL(join(dir, target.out, "index.mjs")).href);
  assert.deepEqual(OPERATIONS.startRun.body, { required: true, contentTypes: ["application/json"] });
  assert.deepEqual(OPERATIONS.startRun.params.map((p) => [p.name, p.in, p.required]), [["run", "path", true]]);
  let sent;
  await createClient({ baseUrl: "", fetch: async (url, init) => { sent = [url, init.method, init.body]; return new Response(null, { status: 202 }); } }).runs.startRun({ run: "r1", body: { date: "2026-10-06" } });
  assert.deepEqual(sent, ["/api/runs/r1", "POST", '{"date":"2026-10-06"}']);
  doc.paths["/api/health"].get.responses = { 200: { description: "ok" } };
  doc.paths["/api/feed.ics"].get.responses = { 404: { description: "none" } };
  writeFileSync(file, JSON.stringify(doc));
  const p = (await generateTarget(dir, target)).problems.join("\n");
  assert.doesNotMatch(p, /health/, "a 200 without content generates");
  assert.match(p, /GET \/api\/feed\.ics \(feed\) declares no 2xx response/);
  doc.paths["/api/feed.ics"].get.responses = { 200: { description: "ok", content: { "application/json": {} } } };
  writeFileSync(file, JSON.stringify(doc));
  const g2 = await generateTarget(dir, target);
  assert.deepEqual(g2.problems, []);
  const dts = g2.files.find((f) => f.path === "index.d.ts").content;
  assert.match(dts, /export type HealthResponse = undefined;/);
  assert.match(dts, /export type FeedResponse = unknown;/, "JSON without a schema: any value");
  assert.match(dts, /export type StartRunResponse = undefined;/);
});

test("kit check sdk covers the Python target byte for byte: an edit is caught, Python's __pycache__ is not a hand-added file", async (t) => {
  const dir = await generated(t);
  const out = join(dir, target.out);
  const mod = join(out, "python/saasreport_sdk/__init__.py");
  mkdirSync(join(out, "python/saasreport_sdk/__pycache__"));
  writeFileSync(join(out, "python/saasreport_sdk/__pycache__/__init__.cpython-312.pyc"), "x");
  assert.deepEqual(problemsOf(await check(dir)), [], "a bytecode cache is ignored");
  writeFileSync(mod, readFileSync(mod, "utf8").replace("class Client:", "class Client:  # patched"));
  assert.match(problemsOf(await check(dir)).join("\n"), /python\/saasreport_sdk\/__init__\.py: hand-edited/);
});

test("languages: a target may generate a subset; the manifest records it and the check holds it", async (t) => {
  const dir = repo(t);
  const cfg = JSON.parse(readFileSync(join(dir, "kit.sdk.json"), "utf8"));
  cfg.targets[0].languages = ["python"];
  writeFileSync(join(dir, "kit.sdk.json"), JSON.stringify(cfg));
  const tg = cfg.targets[0];
  const g = await generateTarget(dir, tg);
  assert.deepEqual(g.files.map((f) => f.path), ["python/pyproject.toml", "python/saasreport_sdk/__init__.py", "python/saasreport_sdk/py.typed", "README.md", MANIFEST_FILE]);
  assert.deepEqual(g.manifest.generator.forge.targets, ["python"]);
  writeTarget(dir, tg, g.files);
  assert.deepEqual(problemsOf(await check(dir)), []);
});
