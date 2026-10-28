// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance.
// @saasreport/forge: what the port fixed at the source (every method, derived operationIds, bodies as declared, every
// parameter with its serialization, 2xx without a schema, groups from tags), per-instance resolver state, the
// provenance of every ported file, and deterministic generation for every target.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Forge, createResolver, generate, initFromOpenApi, operationIdOf, ORIGIN, PACKAGE, TARGETS, buildModel } from "../src/index.js";
import { bundled } from "../../cli/src/canon/index.js";
import { formatProblems } from "@saasreport/core/schema";
import { tempDir } from "../../core/test/support/temp.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ok = (description = "ok") => ({ 200: { description, content: { "application/json": { schema: { type: "object" } } } } });
const doc = (paths, extra = {}) => ({ openapi: "3.1.0", info: { title: "T", version: "1.0.0" }, paths, ...extra });

test("every OpenAPI method is an operation, HEAD, OPTIONS and TRACE included", () => {
  const forge = initFromOpenApi(doc({
    "/r": Object.fromEntries(["get", "put", "post", "delete", "options", "head", "patch", "trace"].map((m) => [m, { operationId: `${m}R`, tags: ["r"], summary: m, responses: ok() }])),
  }));
  assert.deepEqual(forge.getOperationIds(), ["deleteR", "getR", "headR", "optionsR", "patchR", "postR", "putR", "traceR"]);
  assert.equal(forge.resolveOperation("headR").method, "head");
  assert.equal(forge.getVerbPath("optionsR"), "OPTIONS /r");
  assert.deepEqual(forge.methodMap(), [{ r: ["deleteR", "getR", "headR", "optionsR", "patchR", "postR", "putR", "traceR"] }]);
});

test("an operation without an operationId gets one from its method and path, used everywhere", () => {
  assert.deepEqual(operationIdOf("get", "/api/items/{item_id}/feed.ics"), { operationId: "getApiItemsByItemIdFeedIcs", derived: true });
  assert.deepEqual(operationIdOf("post", "/"), { operationId: "postRoot", derived: true });
  assert.deepEqual(operationIdOf("get", "/x", { operationId: "it's" }), { operationId: "its", derived: false });
  const forge = initFromOpenApi(doc({ "/api/items/{id}": { get: { tags: ["items"], summary: "One", responses: ok() } } }));
  const info = forge.resolveOperation("getApiItemsById");
  assert.equal(info.operationIdDerived, true);
  assert.deepEqual(forge.methodMap(), [{ items: ["getApiItemsById"] }]);
  // a derived id that collides with a declared one is a duplicate, named with both routes
  assert.throws(() => initFromOpenApi(doc({
    "/a": { get: { tags: ["t"], summary: "a", responses: ok() } },
    "/b": { get: { operationId: "getA", tags: ["t"], summary: "b", responses: ok() } },
  })), /Duplicate operation ids found: getA \(GET \/a, GET \/b\)/);
});

test("groups: x-fern-sdk-group-name, else the first tag (as an identifier), else the first path segment", () => {
  const forge = initFromOpenApi(doc({
    "/api/v1/forms/{id}": { get: { operationId: "f", summary: "f", responses: ok() } },
    "/api/x": { get: { operationId: "x", tags: ["Calendar events", "other"], summary: "x", responses: ok() } },
    "/api/y": { get: { operationId: "y", "x-fern-sdk-group-name": "a.b", summary: "y", responses: ok() } },
    "/": { get: { operationId: "root", summary: "r", responses: ok() } },
  }));
  assert.deepEqual(forge.methodMap(), [{ a: [{ b: ["y"] }] }, { calendarEvents: ["x"] }, { default: ["root"] }, { forms: ["f"] }]);
});

test("a declared request body is a body: a bare { type: object } included; required, media type and schema as declared", () => {
  const r = createResolver(doc({
    "/a": { post: { operationId: "a", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: ok() } },
    "/b": { post: { operationId: "b", requestBody: { content: { "text/plain": { schema: { type: "string" } }, "application/merge-patch+json": { schema: { $ref: "#/components/schemas/P" } } } }, responses: ok() } },
    "/c": { post: { operationId: "c", requestBody: { content: {} }, responses: ok() } },
    "/d": { post: { operationId: "d", requestBody: { $ref: "#/components/requestBodies/D" }, responses: ok() } },
  }, { components: { schemas: { P: { type: "object" } }, requestBodies: { D: { required: true, content: { "application/json": { schema: { type: "object" } } } } } } }));
  const a = r.resolveOperation("a");
  assert.deepEqual([a.hasRequestBody, a.requestBodyIsRequired, a.requestBodyMediaType, a.requestBodySchema], [true, true, "application/json", { type: "object" }]);
  const b = r.resolveOperation("b");
  assert.deepEqual([b.hasRequestBody, b.requestBodyIsRequired, b.requestBodyMediaType, b.requestBodySchema], [true, false, "application/merge-patch+json", { $ref: "#/components/schemas/P" }]);
  assert.equal(r.resolveOperation("c").hasRequestBody, false, "content {} declares no media type");
  assert.equal(r.resolveOperation("d").requestBodyIsRequired, true, "a $ref'd body is resolved");
});

test("parameters: every location, cookie included, with style, explode, allowReserved and JSON content", () => {
  const r = createResolver(doc({
    "/p/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "p",
        parameters: [
          { $ref: "#/components/parameters/Q" },
          { name: "s", in: "cookie", schema: { type: "string" } },
          { name: "f", in: "query", content: { "application/json": { schema: { type: "object" } } } },
          { name: "X-T", in: "header", deprecated: true, schema: { type: "array", items: { type: "string" } } },
        ],
        responses: ok(),
      },
    },
  }, { components: { parameters: { Q: { name: "q", in: "query", style: "pipeDelimited", explode: false, allowReserved: true, schema: { type: "array" } } } } }));
  const op = r.resolveOperation("p");
  assert.deepEqual(op.parameters.map((p) => [p.name, p.in, p.required, p.style, p.explode, p.allowReserved, p.deprecated, p.content?.mediaType]), [
    ["id", "path", true, undefined, undefined, false, false, undefined],
    ["q", "query", false, "pipeDelimited", false, true, false, undefined],
    ["s", "cookie", false, undefined, undefined, false, false, undefined],
    ["f", "query", false, undefined, undefined, false, false, "application/json"],
    ["X-T", "header", false, undefined, undefined, false, true, undefined],
  ]);
  assert.deepEqual(op.cookieParams, [{ name: "s", required: false, type: "string" }]);
});

test("responses: every 2xx as declared, without content or without a schema included; no Cloudflare envelope", () => {
  const r = createResolver(doc({
    "/r": { get: { operationId: "r", responses: {
      200: { description: "ok", content: { "application/json": {}, "text/csv": { schema: { type: "string" } } } },
      204: { description: "none" },
      "2XX": { $ref: "#/components/responses/R" },
      404: { description: "no" },
    } } },
  }, { components: { responses: { R: { description: "any", content: { "application/json": { schema: { $ref: "#/components/schemas/I" } } } } }, schemas: { I: { type: "object" } } } }));
  const op = r.resolveOperation("r");
  assert.deepEqual(op.success, [
    { status: "200", description: "ok", content: [{ mediaType: "application/json" }, { mediaType: "text/csv", schema: { type: "string" } }] },
    { status: "204", description: "none", content: [] },
    { status: "2XX", description: "any", content: [{ mediaType: "application/json", schema: { $ref: "#/components/schemas/I" } }] },
  ]);
  for (const k of ["responseRef", "responseIsArray", "resultRef"]) assert.equal(k in op, false, `${k} (the { success, result } envelope) is not ported`);
});

test("each Forge instance resolves its own document (no shared module state between contracts)", () => {
  const a = initFromOpenApi(doc({ "/a": { get: { operationId: "a", tags: ["t"], summary: "a", responses: ok() } } }));
  const b = initFromOpenApi(doc({ "/b": { get: { operationId: "b", tags: ["t"], summary: "b", responses: ok() } } }));
  assert.equal(a.resolveOperation("a")?.path, "/a");
  assert.equal(a.resolveOperation("b"), undefined);
  assert.equal(b.resolveOperation("b")?.path, "/b");
  assert.ok(new Forge({ paths: {} }), "a document without components is accepted");
});

test("deprecated: true marks the method deprecated; x-fern-availability still wins", () => {
  const forge = initFromOpenApi(doc({
    "/a": { get: { operationId: "a", tags: ["t"], summary: "a", deprecated: true, responses: ok() } },
    "/b": { get: { operationId: "b", tags: ["t"], summary: "b", deprecated: true, "x-fern-availability": "beta", responses: ok() } },
  }));
  assert.deepEqual(forge.commands.get("t").methods.map((m) => [m.name, m.status]), [["a", "deprecated"], ["b", "beta"]]);
});

test("finalize: refuses a path outside the directory, including a sibling that only shares its prefix", async (t) => {
  const dir = tempDir(t, "forge-out-");
  const forge = new Forge({ paths: {} });
  const files = await forge.transform((f) => { f.emit("a/b.txt", "x"); });
  await forge.finalize(join(dir, "out"), files);
  assert.equal(readFileSync(join(dir, "out/a/b.txt"), "utf8"), "x");
  const evil = await forge.transform((f) => { f.emit("../out-evil/x.txt", "x"); });
  await assert.rejects(forge.finalize(join(dir, "out"), evil), /Path traversal detected/);
  assert.equal(existsSync(join(dir, "out-evil")), false);
});

test("generate: every target, deterministic bytes; a subset of targets; an unknown target is refused", async () => {
  const d = doc({ "/api/items/{id}": { get: { tags: ["items"], summary: "One", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok() } } });
  const t = { name: "demo" };
  const a = await generate(d, t, { mark: "test" });
  const b = await generate(structuredClone(d), t, { mark: "test" });
  assert.deepEqual(a.problems, []);
  assert.deepEqual(a.files, b.files, "same contract, same bytes, every target");
  assert.deepEqual(a.files.map((f) => f.path), ["cli.mjs", "index.d.ts", "index.mjs", "package.json", "python/demo_sdk/__init__.py", "python/demo_sdk/py.typed", "python/pyproject.toml"]);
  assert.deepEqual(TARGETS, ["javascript", "python"]);
  assert.deepEqual((await generate(d, t, { mark: "test", languages: ["python"] })).files.map((f) => f.path), ["python/demo_sdk/__init__.py", "python/demo_sdk/py.typed", "python/pyproject.toml"]);
  assert.match((await generate(d, t, { mark: "test", languages: ["go"] })).problems.join(), /unknown target language go/);
  // every file that can carry a comment carries the header (package.json says it in its description)
  for (const f of a.files.filter((x) => x.content && !x.path.endsWith(".json"))) assert.match(f.content, /Generated by test transformer/, f.path);
});

test("model: a parameter name used in two locations, or named body, stops generation", () => {
  const m = buildModel(doc({ "/x/{id}": { get: { operationId: "x", tags: ["t"], summary: "x", parameters: [
    { name: "id", in: "path", required: true, schema: { type: "string" } },
    { name: "id", in: "query", schema: { type: "string" } },
    { name: "body", in: "header", schema: { type: "string" } },
  ], responses: ok() } } }), { name: "t" });
  assert.match(m.problems.join("\n"), /parameter "id" is declared in path and query/);
  assert.match(m.problems.join("\n"), /header parameter "body": the name is reserved/);
});

test("provenance: ORIGIN.json is schema-valid and accounts for every ported file; every port names its upstream file", () => {
  const kit = bundled();
  assert.deepEqual(formatProblems(kit.validator.validate(ORIGIN, kit.byName("forge-origin"))), []);
  assert.equal(ORIGIN.license, "Apache-2.0");
  for (const f of ORIGIN.ported) {
    assert.ok(existsSync(join(ROOT, f.port)), `${f.port} exists`);
    if (f.port.endsWith(".json")) continue;
    const head = readFileSync(join(ROOT, f.port), "utf8").split("\n").slice(0, 4).join("\n");
    assert.match(head, /SPDX-License-Identifier: Apache-2\.0/, f.port);
    if (f.upstream !== "index.ts") assert.ok(head.includes(`Ported from Cloudflare Forge, packages/forge/${f.upstream}`), `${f.port} names ${f.upstream}`);
  }
  const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
  assert.match(notice, /Copyright Cloudflare, Inc\./);
  assert.ok(notice.includes(ORIGIN.origin.commit), "NOTICE records the origin commit");
  assert.equal(PACKAGE.license, "Apache-2.0");
});

test("no dependencies: every source imports only node: built-ins and the package's own files", () => {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(join(ROOT, "src")).filter((x) => x.endsWith(".js"))) {
    for (const m of readFileSync(f, "utf8").matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.ok(m[1].startsWith("node:") || m[1].startsWith("."), `${f} imports ${m[1]}`);
    }
  }
  assert.equal(PACKAGE.dependencies, undefined);
});

test("the JavaScript client: HEAD and OPTIONS operations, a derived operationId, a 2xx without content", async (t) => {
  const d = doc({ "/items/{id}": {
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    head: { tags: ["items"], summary: "Exists?", responses: { 200: { description: "yes" } } },
    options: { operationId: "allow", tags: ["items"], summary: "Allowed", responses: { 204: { description: "none" } } },
  } });
  const g = await generate(d, { name: "demo" }, { mark: "test", languages: ["javascript"] });
  assert.deepEqual(g.problems, []);
  const dts = g.files.find((f) => f.path === "index.d.ts").content;
  assert.match(dts, /export type HeadItemsByIdResponse = undefined;/);
  assert.match(dts, /headItemsById\(params: HeadItemsByIdParams/);
  const dir = tempDir(t, "forge-js-");
  const file = join(dir, "index.mjs");
  writeFileSync(file, g.files.find((f) => f.path === "index.mjs").content);
  const { createClient } = await import(new URL(`file://${file}`).href);
  const seen = [];
  const api = createClient({ baseUrl: "https://h.test", fetch: async (url, init) => { seen.push([init.method, url]); return new Response(null, { status: 200, headers: { "content-type": "application/json" } }); } });
  assert.equal(await api.items.headItemsById({ id: "a" }), undefined, "HEAD never reads a body");
  assert.equal(await api.items.allow({ id: "a" }), undefined);
  assert.deepEqual(seen, [["HEAD", "https://h.test/items/a"], ["OPTIONS", "https://h.test/items/a"]]);
});

test("the JavaScript client: a JSON reply that does not parse is an ApiError, never undefined; an empty one is no content", async (t) => {
  const d = doc({ "/items": { get: { operationId: "listItems", tags: ["items"], summary: "List", responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "array" } } } } } } } });
  const g = await generate(d, { name: "demo" }, { mark: "test", languages: ["javascript"] });
  const dir = tempDir(t, "forge-js-");
  const file = join(dir, "index.mjs");
  writeFileSync(file, g.files.find((f) => f.path === "index.mjs").content);
  const { createClient, ApiError } = await import(new URL(`file://${file}`).href);
  const reply = (body) => createClient({ baseUrl: "https://h.test", fetch: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(reply("<html>").items.listItems(), (e) => e instanceof ApiError && e.status === 200 && e.body?.error === "invalid_json");
  assert.equal(await reply("").items.listItems(), undefined);
  assert.deepEqual(await reply("[1]").items.listItems(), [1]);
});

test("the JavaScript client sends bodies by their declared media type, against a real local server", async (t) => {
  const { createServer } = await import("node:http");
  const ok200 = { 200: { description: "ok", content: { "application/json": {} } } };
  const d = doc({
    "/notes": {
      post: { operationId: "postNote", tags: ["notes"], summary: "A JSON string", requestBody: { required: true, content: { "application/json": { schema: { type: "string" } } } }, responses: ok200 },
      patch: { operationId: "patchNullable", tags: ["notes"], summary: "Optional, admits null", requestBody: { content: { "application/json": { schema: { type: ["object", "null"] } } } }, responses: ok200 },
    },
    "/text": { post: { operationId: "postText", tags: ["notes"], summary: "Plain text", requestBody: { required: true, content: { "text/plain": { schema: { type: "string" } } } }, responses: ok200 } },
  });
  const g = await generate(d, { name: "demo" }, { mark: "test", languages: ["javascript"] });
  assert.deepEqual(g.problems, []);
  const dir = tempDir(t, "forge-js-");
  const file = join(dir, "index.mjs");
  writeFileSync(file, g.files.find((f) => f.path === "index.mjs").content);
  const { createClient, OPERATIONS } = await import(new URL(`file://${file}`).href);
  assert.equal(OPERATIONS.patchNullable.body.nullable, true, "the operation table records a body that admits null");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: req.headers["content-type"] ?? null, body: body || null }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const api = createClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(await api.notes.postNote({ body: "hello" }), { type: "application/json", body: '"hello"' }, "a JSON string body is JSON-encoded and typed");
    assert.deepEqual(await api.notes.patchNullable({ body: null }), { type: "application/json", body: "null" }, "null is JSON null");
    assert.deepEqual(await api.notes.patchNullable({}), { type: null, body: null }, "an omitted optional body sends nothing");
    assert.deepEqual(await api.notes.postText({ body: "hello" }), { type: "text/plain", body: "hello" }, "text/plain is sent as it is, with its type");
    await assert.rejects(api.notes.postText({ body: { a: 1 } }), /a text\/plain body is a string or bytes, not an object/);
  } finally {
    server.close();
  }
});
