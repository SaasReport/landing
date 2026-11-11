// OpenAPI 3.1 parameter serialization in the generated client (@saasreport/forge src/runtime/params.js, inlined into index.mjs) against
// the specification's style examples (§4.8.12.4: color = "blue" / ["blue","black","brown"] / {R:100,G:200,B:150}),
// the refusal of undefined combinations at generation time (paramSpec), and the guarded output directory.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializeParam, serializeParams, encodeValue } from "../../forge/src/runtime/params.js";
import { paramSpec } from "../../forge/src/index.js";
import { outDir, generateTarget, writeTarget } from "../src/generate.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const P = "blue", A = ["blue", "black", "brown"], O = { R: 100, G: 200, B: 150 };
const s = (where, style, explode, v, extra = {}) => {
  const r = serializeParam({ name: "color", in: where, style, explode, ...extra }, v);
  return r.path ?? r.header ?? r.cookie ?? r.query.join("&");
};

test("path: simple, label, matrix × primitive, array, object × explode", () => {
  const rows = [
    ["simple", false, ["blue", "blue,black,brown", "R,100,G,200,B,150"]],
    ["simple", true, ["blue", "blue,black,brown", "R=100,G=200,B=150"]],
    ["label", false, [".blue", ".blue,black,brown", ".R,100,G,200,B,150"]],
    ["label", true, [".blue", ".blue.black.brown", ".R=100.G=200.B=150"]],
    ["matrix", false, [";color=blue", ";color=blue,black,brown", ";color=R,100,G,200,B,150"]],
    ["matrix", true, [";color=blue", ";color=blue;color=black;color=brown", ";R=100;G=200;B=150"]],
  ];
  for (const [style, explode, want] of rows) assert.deepEqual([P, A, O].map((v) => s("path", style, explode, v)), want, `${style} explode=${explode}`);
  assert.equal(s("path", "simple", false, "a/b c"), "a%2Fb%20c", "path values are percent-encoded");
});

test("query: form, spaceDelimited, pipeDelimited, deepObject; allowReserved", () => {
  assert.deepEqual([P, A, O].map((v) => s("query", "form", true, v)), ["color=blue", "color=blue&color=black&color=brown", "R=100&G=200&B=150"]);
  assert.deepEqual([P, A, O].map((v) => s("query", "form", false, v)), ["color=blue", "color=blue,black,brown", "color=R,100,G,200,B,150"]);
  assert.deepEqual([A, O].map((v) => s("query", "spaceDelimited", false, v)), ["color=blue%20black%20brown", "color=R%20100%20G%20200%20B%20150"]);
  assert.deepEqual([A, O].map((v) => s("query", "pipeDelimited", false, v)), ["color=blue%7Cblack%7Cbrown", "color=R%7C100%7CG%7C200%7CB%7C150"]);
  assert.equal(s("query", "deepObject", true, O), "color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150");
  assert.equal(s("query", "form", true, "a/b?c&d"), "color=a%2Fb%3Fc%26d");
  assert.equal(s("query", "form", true, "a/b?c d", { allowReserved: true }), "color=a/b?c%20d");
  assert.equal(encodeValue("it's (x)*"), "it%27s%20%28x%29%2A");
});

test("header (simple) and cookie (form), JSON content parameters", () => {
  assert.deepEqual([P, A, O].map((v) => s("header", "simple", false, v)), ["blue", "blue,black,brown", "R,100,G,200,B,150"]);
  assert.equal(s("header", "simple", true, O), "R=100,G=200,B=150");
  assert.equal(s("cookie", "form", true, "a b"), "color=a%20b");
  assert.equal(s("cookie", "form", false, A), "color=blue,black,brown");
  assert.equal(s("query", "form", true, { a: [1] }, { json: true }), "color=%7B%22a%22%3A%5B1%5D%7D");
  const op = { path: "/x/{id}", params: [
    { name: "id", in: "path", required: true, style: "label", explode: false },
    { name: "f", in: "query", style: "deepObject", explode: true },
    { name: "X-T", in: "header", style: "simple", explode: false },
    { name: "s", in: "cookie", style: "form", explode: true },
    { name: "t", in: "cookie", style: "form", explode: true },
  ] };
  assert.deepEqual(serializeParams("x", op, { id: 7, f: { a: 1 }, "X-T": ["p", "q"], s: "1", t: "2" }), { path: "/x/.7", query: "f%5Ba%5D=1", headers: { "X-T": "p,q" }, cookie: "s=1; t=2" });
  assert.throws(() => serializeParams("x", op, {}), /missing required path parameter "id"/);
});

test("generation refuses combinations the specification leaves undefined, naming the parameter", () => {
  const spec = (p) => paramSpec(p, "GET /x (op)");
  assert.equal(spec({ name: "a", in: "query", schema: { type: "object" } }).param.explode, true, "form explodes by default");
  assert.equal(spec({ name: "a", in: "path", schema: { type: "array" } }).param.explode, false);
  const refused = [
    [{ name: "f", in: "query", style: "deepObject", schema: { type: "object" } }, /deepObject is only defined with explode: true/],
    [{ name: "f", in: "query", style: "deepObject", explode: true, schema: { type: "array" } }, /deepObject is only defined for objects/],
    [{ name: "c", in: "cookie", schema: { type: "array" } }, /list or object cookie is only defined with explode: false/],
    [{ name: "m", in: "query", style: "matrix", schema: { type: "string" } }, /style matrix is not defined for query parameters/],
    [{ name: "h", in: "header", style: "form", schema: { type: "string" } }, /style form is not defined for header/],
    [{ name: "p", in: "query", style: "pipeDelimited", schema: { type: "string" } }, /pipeDelimited is only defined for arrays and objects/],
    [{ name: "x", in: "query", content: { "application/xml": { schema: {} } } }, /content application\/xml is not supported/],
  ];
  for (const [p, re] of refused) assert.match(spec(p).problem ?? "", re, JSON.stringify(p));
  assert.match(spec(refused[0][0]).problem, /^GET \/x \(op\): query parameter "f": /);
  assert.equal(spec({ name: "j", in: "query", content: { "application/json": { schema: { type: "object" } } } }).param.json, true);
});

const FIXTURE = fileURLToPath(new URL("./fixture/", import.meta.url));
const repo = (t) => { const d = tempDir(t, "kit-sdk-out-"); cpSync(FIXTURE, d, { recursive: true }); return d; };
const T = (out, extra = {}) => ({ name: "saasreport", contract: "contracts/openapi.json", out, ...extra });

test("out: only a subdirectory of sdk/, never ., .., a source directory, the contract or another target", (t) => {
  const dir = repo(t);
  for (const bad of [".", "..", "src", "sdk", "sdk/", "sdk/../src", "sdk/./x", "/tmp/x", "contracts", "", "sdk//x"]) {
    assert.ok(outDir(dir, T(bad)).problem, `refused: "${bad}"`);
  }
  assert.ok(outDir(dir, T("sdk/saasreport")).dir);
  assert.match(outDir(dir, T("sdk/a"), [T("sdk/a"), T("sdk/a/b", { name: "saasreport-b" })]).problem, /overlaps target saasreport-b/);
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "src"), join(dir, "sdk-link"));
  mkdirSync(join(dir, "sdk"));
  symlinkSync(tmpdir(), join(dir, "sdk", "out"));
  assert.match(outDir(dir, T("sdk/out/x")).problem, /symlink outside the repository/);
});

test("writeTarget deletes only what kit sdk generate wrote: a foreign or hand-filled directory is left alone", async (t) => {
  const dir = repo(t);
  const tg = T("sdk/saasreport");
  const g = await generateTarget(dir, tg);
  assert.deepEqual(g.problems, []);
  mkdirSync(join(dir, "sdk/saasreport"), { recursive: true });
  writeFileSync(join(dir, "sdk/saasreport/notes.md"), "mine\n");
  assert.throws(() => writeTarget(dir, tg, g.files), /was not written by kit sdk generate .* refusing to delete it/);
  assert.ok(existsSync(join(dir, "sdk/saasreport/notes.md")), "nothing deleted");
  rmSync(join(dir, "sdk/saasreport/notes.md"));
  writeTarget(dir, tg, g.files);
  writeFileSync(join(dir, "sdk/saasreport/extra.js"), "x\n");
  assert.throws(() => writeTarget(dir, tg, g.files), /holds files kit sdk generate did not write \(extra\.js\)/);
  assert.ok(existsSync(join(dir, "sdk/saasreport/index.mjs")), "nothing deleted");
  rmSync(join(dir, "sdk/saasreport/extra.js"));
  writeTarget(dir, tg, g.files);   // a generated directory is replaced
  assert.throws(() => writeTarget(dir, T("src"), g.files), /must be a subdirectory of sdk\//);
  assert.ok(existsSync(join(dir, "src/app.js")), "src untouched");
  assert.match((await generateTarget(dir, T("."))).problems.join(), /out "\." must be a relative path/);
});

test("generated client: cookie, deepObject and label parameters end to end", async (t) => {
  const dir = repo(t);
  const file = join(dir, "contracts/openapi.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.paths["/api/search/{scope}"] = { get: {
    operationId: "search", tags: ["items"], summary: "Search",
    parameters: [
      { name: "scope", in: "path", required: true, style: "label", schema: { type: "array", items: { type: "string" } } },
      { name: "filter", in: "query", style: "deepObject", explode: true, schema: { type: "object" } },
      { name: "session", in: "cookie", required: true, schema: { type: "string" } },
    ],
    responses: { 200: { description: "ok", content: { "application/json": { schema: {} } } } },
  } };
  writeFileSync(file, JSON.stringify(doc));
  const tg = T("sdk/saasreport");
  const g = await generateTarget(dir, tg);
  assert.deepEqual(g.problems, []);
  writeTarget(dir, tg, g.files);
  const { createClient } = await import(pathToFileURL(join(dir, "sdk/saasreport/index.mjs")).href);
  let seen;
  const api = createClient({ baseUrl: "https://h.test", fetch: async (url, init) => { seen = [url, init.headers.cookie]; return new Response("{}", { headers: { "content-type": "application/json" } }); } });
  await api.items.search({ scope: ["a", "b"], filter: { kind: "x", n: 2 }, session: "s 1" });
  assert.deepEqual(seen, ["https://h.test/api/search/.a,b?filter%5Bkind%5D=x&filter%5Bn%5D=2", "session=s%201"]);
  await assert.rejects(api.items.search({ scope: ["a"] }), /missing required cookie parameter "session"/);
  doc.paths["/api/search/{scope}"].get.parameters[1].explode = false;
  writeFileSync(file, JSON.stringify(doc));
  assert.match((await generateTarget(dir, tg)).problems.join("\n"), /GET \/api\/search\/\{scope\} \(search\): query parameter "filter": style deepObject is only defined with explode: true/);
});
