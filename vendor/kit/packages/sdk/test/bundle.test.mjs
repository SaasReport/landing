import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleExternalRefs, idPath, componentName } from "../src/bundle.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const ID = "https://github.com/Example/kit/blob/main/packages/core/schemas/thing.schema.json";
const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: ID, title: "kit.thing.v1", type: "object",
  required: ["a"], properties: { a: { type: "string" }, sub: { $ref: "#/$defs/sub" } },
  $defs: { sub: { type: "object", properties: { b: { const: 1 } } } },
};
const doc = (ref) => ({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths: { "/x": { post: { requestBody: { content: { "application/json": { schema: { $ref: ref } } } }, responses: { 200: { description: "ok" } } } } } });

function repo(t, { vendored = false } = {}) {
  const root = tempDir(t, "bundle-");
  const dir = join(root, ...(vendored ? ["vendor", "kit"] : []), "packages/core/schemas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "thing.schema.json"), JSON.stringify(SCHEMA));
  return root;
}

test("an external kit schema is bundled into components, with its $defs as siblings", (t) => {
  const { doc: out, problems, bundled } = bundleExternalRefs(doc(ID), repo(t));
  assert.deepEqual(problems, []);
  assert.deepEqual(bundled, ["KitThingV1"]);
  assert.equal(out.paths["/x"].post.requestBody.content["application/json"].schema.$ref, "#/components/schemas/KitThingV1");
  const c = out.components.schemas;
  assert.equal(c.KitThingV1.$id, undefined, "no $id/$schema inside a component");
  assert.equal(c.KitThingV1.properties.sub.$ref, "#/components/schemas/KitThingV1_sub");
  assert.deepEqual(c.KitThingV1_sub.properties.b, { const: 1 });
});

test("the vendored kit is found when the repository has no copy of its own; the input is not mutated", (t) => {
  const input = doc(ID);
  const { problems } = bundleExternalRefs(input, repo(t, { vendored: true }));
  assert.deepEqual(problems, []);
  assert.equal(input.paths["/x"].post.requestBody.content["application/json"].schema.$ref, ID);
});

test("an unresolvable external $ref is a problem, never a silent unknown", (t) => {
  const { problems } = bundleExternalRefs(doc("https://github.com/Example/kit/blob/main/nope.schema.json"), repo(t));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot be resolved/);
  assert.equal(bundleExternalRefs(doc("https://example.com/x.json"), repo(t)).problems.length, 1);
});

test("names and paths", () => {
  assert.equal(idPath(ID), "packages/core/schemas/thing.schema.json");
  assert.equal(idPath("https://example.com/x"), null);
  for (const bad of ["../../etc/passwd", "a/../b.json", "./a.json", "a//b.json", "a/%2e%2e/b.json", "a\\..\\b.json"]) {
    assert.equal(idPath(`https://github.com/Example/kit/blob/main/${bad}`), null, `refused: ${bad}`);
  }
  assert.equal(componentName({ title: "kit.broker-request.v1" }, ID), "KitBrokerRequestV1");
});

function repoWith(t, files) {
  const root = tempDir(t, "bundle-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}
const U = (p) => `https://github.com/Example/kit/blob/main/${p}`;

test("bundled $defs names never overwrite an existing component", (t) => {
  const input = doc(ID);
  input.components = { schemas: { KitThingV1_sub: { type: "string", description: "mine" } } };
  const { doc: out, problems } = bundleExternalRefs(input, repo(t));
  assert.deepEqual(problems, []);
  assert.equal(out.components.schemas.KitThingV1_sub.description, "mine", "the existing component is kept");
  const ref = out.components.schemas.KitThingV1.properties.sub.$ref;
  assert.notEqual(ref, "#/components/schemas/KitThingV1_sub");
  assert.ok(out.components.schemas[ref.split("/").pop()].properties.b, "the bundled def has its own name");
});

test("external refs inside existing components, parameters and responses are bundled too", (t) => {
  const input = doc(ID);
  input.components = { schemas: { C: { $ref: ID } }, responses: { R: { description: "r", content: { "application/json": { schema: { $ref: ID } } } } } };
  const { doc: out, problems } = bundleExternalRefs(input, repo(t));
  assert.deepEqual(problems, []);
  assert.equal(out.components.schemas.C.$ref, "#/components/schemas/KitThingV1");
  assert.equal(out.components.responses.R.content["application/json"].schema.$ref, "#/components/schemas/KitThingV1");
});

test("a fragment other than the schema or one of its $defs is a problem, not the whole schema", (t) => {
  assert.match(bundleExternalRefs(doc(`${ID}#/properties/a`), repo(t)).problems.join(), /only the schema itself or one of its \$defs/);
  assert.match(bundleExternalRefs(doc(`${ID}#/$defs/none`), repo(t)).problems.join(), /no such \$defs entry/);
  const ok = bundleExternalRefs(doc(`${ID}#/$defs/sub`), repo(t));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.doc.paths["/x"].post.requestBody.content["application/json"].schema.$ref, "#/components/schemas/KitThingV1_sub");
});

test("local refs inside a schema: # and nested $defs are bundled; other pointers are problems", (t) => {
  const root = repoWith(t, { "s/t.json": { title: "t", type: "object", properties: { self: { $ref: "#" }, deep: { $ref: "#/$defs/a/$defs/b" }, bad: { $ref: "#/properties/self" } }, $defs: { a: { $defs: { b: { const: 2 } } } } } });
  const { doc: out, problems } = bundleExternalRefs(doc(U("s/t.json")), root);
  const s = out.components.schemas.T;
  assert.equal(s.properties.self.$ref, "#/components/schemas/T");
  assert.deepEqual(out.components.schemas[s.properties.deep.$ref.split("/").pop()], { const: 2 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /only "#" or "#\/\$defs\/…"/);
});

test("cycles between external schemas terminate; bad JSON is a problem, not a crash", (t) => {
  const root = repoWith(t, { "s/a.json": { title: "a", properties: { b: { $ref: U("s/b.json") } } }, "s/b.json": { title: "b", properties: { a: { $ref: U("s/a.json") } } }, "s/bad.json": "{nope" });
  const r = bundleExternalRefs(doc(U("s/a.json")), root);
  assert.deepEqual(r.problems, []);
  assert.equal(r.doc.components.schemas.B.properties.a.$ref, "#/components/schemas/A");
  assert.match(bundleExternalRefs(doc(U("s/bad.json")), root).problems.join(), /not valid JSON/);
});

test("a schema file that is a symlink out of the repository is refused", async (t) => {
  const { symlinkSync } = await import("node:fs");
  const outside = repoWith(t, { "secret.json": { title: "secret" } });
  const root = repoWith(t, {});
  mkdirSync(join(root, "s"), { recursive: true });
  symlinkSync(join(outside, "secret.json"), join(root, "s", "link.json"));
  assert.match(bundleExternalRefs(doc(U("s/link.json")), root).problems.join(), /outside the repository/);
});

test("$ref and $defs are keywords only in schema positions, never in data or property names", (t) => {
  const root = repoWith(t, { "s/p.json": { title: "p", type: "object", properties: { $defs: { type: "string" }, $ref: { type: "number" } }, default: { $ref: "#/nowhere" }, examples: [{ $ref: "./other.json" }] } });
  const input = doc(U("s/p.json"));
  input.paths["/x"].post.requestBody.content["application/json"].example = { $ref: "https://example.com/not-a-schema" };
  const { doc: out, problems } = bundleExternalRefs(input, root);
  assert.deepEqual(problems, [], "data that looks like a reference is not a reference");
  const p = out.components.schemas.P;
  assert.deepEqual(p.properties.$defs, { type: "string" }, "a property named $defs is kept");
  assert.deepEqual(p.properties.$ref, { type: "number" });
  assert.deepEqual(p.default, { $ref: "#/nowhere" }, "values are copied verbatim");
  assert.deepEqual(out.paths["/x"].post.requestBody.content["application/json"].example, { $ref: "https://example.com/not-a-schema" });
});

test("the same schema file under two branch names is one component", (t) => {
  const input = doc(ID);
  input.components = { schemas: { C: { $ref: ID.replace("/blob/main/", "/blob/v1/") } } };
  const { doc: out, problems, bundled } = bundleExternalRefs(input, repo(t));
  assert.deepEqual(problems, []);
  assert.deepEqual(bundled, ["KitThingV1"]);
  assert.equal(out.components.schemas.C.$ref, "#/components/schemas/KitThingV1");
});

test("a response or component named default is document structure: its external refs are bundled", (t) => {
  const input = doc(ID);
  input.paths["/x"].post.responses.default = { description: "d", content: { "application/json": { schema: { $ref: ID } } } };
  input.components = { schemas: { default: { $ref: ID } }, examples: { default: { value: { $ref: "not-a-ref" } } } };
  const { doc: out, problems } = bundleExternalRefs(input, repo(t));
  assert.deepEqual(problems, []);
  assert.equal(out.paths["/x"].post.responses.default.content["application/json"].schema.$ref, "#/components/schemas/KitThingV1");
  assert.equal(out.components.schemas.default.$ref, "#/components/schemas/KitThingV1");
  assert.deepEqual(out.components.examples.default.value, { $ref: "not-a-ref" }, "an Example Object's value is data");
});

test("a kit schema referenced where a parameter or response is expected is a problem; component names are names", (t) => {
  const input = doc(ID);
  input.paths["/x"].post.parameters = [{ $ref: ID }];
  assert.match(bundleExternalRefs(input, repo(t)).problems.join(), /only be referenced where a schema is expected/);
  const ok = doc(ID);
  ok.components = { examples: { schema: { value: { $ref: "data" } }, example: { value: 1 } } };
  const r = bundleExternalRefs(ok, repo(t));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.doc.components.examples.schema.value, { $ref: "data" });
});
