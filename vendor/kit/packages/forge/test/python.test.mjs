// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance.
// The Python target: runtime/params.py held to runtime/params.js case for case, and a generated client driven end to
// end against a real HTTP server (Python's http.server) with the standard library only. Needs python3 ≥ 3.11 on PATH
// (CI's ubuntu-24.04 has 3.12); skipped, with the reason, where there is none.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, pyArgNames } from "../src/index.js";
import { encodeBody, serializeParam } from "../src/runtime/params.js";
import { tempDir } from "../../core/test/support/temp.mjs";

const PYTHON = process.env.KIT_PYTHON || "python3";
const probe = spawnSync(PYTHON, ["-c", "import sys; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
const skip = probe.status === 0 && probe.stdout.trim() === "True" ? false : `needs ${PYTHON} ≥ 3.11 (set KIT_PYTHON)`;
const py = (script, input = "", cwd) => {
  const r = spawnSync(PYTHON, ["-I", "-c", script], { input, encoding: "utf8", cwd, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const PARAMS_PY = fileURLToPath(new URL("../src/runtime/params.py", import.meta.url));

test("params.py serializes every style × explode × value exactly as params.js", { skip }, () => {
  const values = ["blue", ["blue", "black", "brown"], { R: 100, G: 200, B: 150 }, "a/b c?&=;,", true, 2.5, 7, ["x y", false], { "k k": "v/v", n: null }, "é ü"];
  const cases = [];
  const combos = { path: ["simple", "label", "matrix"], query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"], header: ["simple"], cookie: ["form"] };
  for (const [where, styles] of Object.entries(combos)) {
    for (const style of styles) {
      for (const explode of [false, true]) {
        for (const v of values) {
          if (style === "deepObject" && (!explode || Array.isArray(v) || typeof v !== "object")) continue;
          cases.push({ p: { name: "color", in: where, style, explode }, v });
        }
      }
    }
  }
  for (const v of values) cases.push({ p: { name: "c c", in: "query", style: "form", explode: true, allowReserved: true }, v });
  for (const v of values) cases.push({ p: { name: "j", in: "query", style: "form", explode: true, json: true }, v });
  const want = cases.map(({ p, v }) => serializeParam(p, v));
  const script = `import json, re, sys, urllib.parse\nfrom typing import Any, Mapping\nexec(open(${JSON.stringify(PARAMS_PY)}).read())\nprint(json.dumps([_serialize_param(c["p"], c["v"]) for c in json.load(sys.stdin)]))`;
  const got = JSON.parse(py(script, JSON.stringify(cases)));
  assert.equal(got.length, cases.length);
  for (let i = 0; i < cases.length; i++) assert.deepEqual(got[i], want[i], JSON.stringify(cases[i]));
  assert.ok(cases.length > 150, `${cases.length} cases`);
});

test("_encode_body in params.py encodes every body as encodeBody in params.js: by media type, strings JSON-encoded", { skip }, () => {
  const specs = [
    { required: true, contentTypes: ["application/json"] },
    { required: false, contentTypes: ["application/json"], nullable: true },
    { required: true, contentTypes: ["application/problem+json", "text/plain"] },
    { required: true, contentTypes: [] },
    { required: true, contentTypes: ["text/plain"] },
    { required: false, contentTypes: ["application/octet-stream"] },
    { required: true, contentTypes: ["application/x-www-form-urlencoded"] },
  ];
  const bodies = ["hello", "", "é \"q\"", { a: 1, b: "x y" }, [1, "x", null], 5, true];
  const cases = [];
  for (const spec of specs) for (const b of bodies) if (!(spec.contentTypes[0] === "application/x-www-form-urlencoded" && Array.isArray(b))) cases.push({ spec, b });
  cases.push({ spec: specs[1], b: null }, { spec: specs[1] });
  const want = cases.map(({ spec, b }) => {
    try { const r = encodeBody("op", spec, b); return [r.body === undefined ? null : String(r.body), r.contentType ?? null]; }
    catch (e) { return ["error", e.message]; }
  });
  const script = `import json, re, sys, urllib.parse\nfrom typing import Any, Mapping\nexec(open(${JSON.stringify(PARAMS_PY)}).read())\nout = []\nfor c in json.load(sys.stdin):\n    try:\n        d, t = _encode_body("op", c["spec"], c["b"] if "b" in c else OMITTED)\n        out.append([None if d is None else d.decode("utf-8"), t])\n    except TypeError as e:\n        out.append(["error", str(e)])\nprint(json.dumps(out))`;
  const got = JSON.parse(py(script, JSON.stringify(cases)));
  for (let i = 0; i < cases.length; i++) assert.deepEqual(got[i], want[i], JSON.stringify(cases[i]));
  // the two findings: a JSON string is quoted and typed; null is sent when the schema admits it, omitted otherwise
  assert.deepEqual(want[0], ['"hello"', "application/json"]);
  assert.deepEqual(want.at(-2), ["null", "application/json"]);
  assert.deepEqual(want.at(-1), [null, null]);
  const text = cases.findIndex((c) => c.spec === specs[4] && c.b === "hello");
  assert.deepEqual(want[text], ["hello", "text/plain"], "text/* is sent as it is, with its type");
  assert.ok(want.some((w) => w[0] === "error" && /a text\/plain body is a string or bytes, not an object/.test(w[1])), "an object on text/plain is refused in both");
  const py2 = (code) => py(`import json, re, sys, urllib.parse\nfrom typing import Any, Mapping\nexec(open(${JSON.stringify(PARAMS_PY)}).read())\n${code}`).trim();
  assert.equal(py2(`print(_encode_body("op", {"required": False, "contentTypes": ["application/json"]}, None))`), "(None, None)", "None on a body that does not admit null: left out");
  assert.match(py2(`try:\n    _encode_body("op", {"required": True, "contentTypes": ["application/json"]}, OMITTED)\nexcept TypeError as e:\n    print(e)`), /op: missing required body/);
});

const CONTRACT = {
  openapi: "3.1.0",
  info: { title: "Demo", version: "2.0.0" },
  servers: [{ url: "https://unused.test" }],
  components: {
    schemas: {
      Item: { type: "object", required: ["id"], properties: { id: { type: "string" }, from: { type: "string" }, "x-y": { type: "integer" }, parent: { $ref: "#/components/schemas/Item" } } },
      Client: { type: "string", enum: ["a", "b"] },
      Items: { type: "array", items: { $ref: "#/components/schemas/Item" } },
    },
  },
  paths: {
    "/items/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "getItem", tags: ["items"], summary: "One item",
        parameters: [
          { name: "from", in: "query", schema: { type: "string" } },
          { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
          { name: "filter", in: "query", style: "deepObject", explode: true, schema: { type: "object" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
          { name: "session", in: "cookie", schema: { type: "string" } },
        ],
        responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } } },
      },
      put: { tags: ["items"], summary: "Replace", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } }, responses: { 204: { description: "done" } } },
      head: { operationId: "itemExists", tags: ["items"], summary: "Exists?", responses: { 200: { description: "yes" } } },
      options: { operationId: "itemOptions", tags: ["items"], summary: "Allowed methods", responses: { 200: { description: "ok" } } },
    },
    "/feed": { get: { operationId: "feed", tags: ["feeds"], summary: "Text", responses: { 200: { description: "ok", content: { "text/calendar": { schema: { type: "string" } } } } } } },
    "/blob": { get: { operationId: "blob", tags: ["feeds"], summary: "Bytes", responses: { 200: { description: "ok", content: { "application/pdf": {} } } } } },
    "/notes": {
      post: { operationId: "postNote", tags: ["notes"], summary: "A JSON string", requestBody: { required: true, content: { "application/json": { schema: { type: "string" } } } }, responses: { 200: { description: "ok", content: { "application/json": {} } } } },
      patch: { operationId: "patchNullable", tags: ["notes"], summary: "Optional, admits null", requestBody: { content: { "application/json": { schema: { anyOf: [{ type: "object" }, { type: "null" }] } } } }, responses: { 200: { description: "ok", content: { "application/json": {} } } } },
    },
    "/nullable": { post: { operationId: "putNullable", tags: ["notes"], summary: "Required, admits null", requestBody: { required: true, content: { "application/json": { schema: { type: ["object", "null"] } } } }, responses: { 200: { description: "ok", content: { "application/json": {} } } } } },
    "/text": { post: { operationId: "postText", tags: ["notes"], summary: "Plain text", requestBody: { required: true, content: { "text/plain": { schema: { type: "string" } } } }, responses: { 200: { description: "ok", content: { "application/json": {} } } } } },
    "/forms": { post: { operationId: "submit", tags: ["forms"], summary: "Form", requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } } }, responses: { 200: { description: "ok", content: { "application/json": {} } } } } },
  },
};

const SERVER = `
import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, "python")
import demo_sdk as sdk

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _send(self, status, ctype, data):
        self.send_response(status)
        if ctype:
            self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
    def _echo(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n).decode() if n else None
        if self.path.startswith("/items/missing"):
            return self._send(404, "application/json", b'{"error":"none"}')
        if self.path == "/feed":
            return self._send(200, "text/calendar", b"BEGIN:VCALENDAR")
        if self.path == "/blob":
            return self._send(200, "application/pdf", b"%PDF\\x00\\x01")
        if self.command == "PUT":
            return self._send(204, None, b"")
        out = {"method": self.command, "path": self.path, "trace": self.headers.get("x-trace"), "cookie": self.headers.get("cookie"), "type": self.headers.get("content-type"), "body": body, "id": "x"}
        self._send(200, "application/json", json.dumps(out).encode())
    do_GET = do_PUT = do_POST = do_PATCH = do_HEAD = do_OPTIONS = _echo

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
api = sdk.Client(f"http://127.0.0.1:{srv.server_address[1]}/", headers={"authorization": "Bearer t"})
r = {}
r["get"] = api.items.get_item(id="a b", from_="2026-10-06", tags=["p", "q"], filter={"kind": "x"}, x_trace="t1", session="s 1")
r["put"] = api.items.put_items_by_id(id="x", body={"id": "x", "from": "y"})
r["head"] = api.items.item_exists(id="x")
r["options"] = api.items.item_options(id="x")
r["feed"] = api.feeds.feed()
r["blob"] = list(api.feeds.blob())
r["form"] = api.forms.submit(body={"a": "1 2"})
r["str_json"] = api.notes.post_note(body="hello")
r["null_required"] = api.notes.put_nullable(body=None)
r["null_optional"] = api.notes.patch_nullable(body=None)
r["omitted_optional"] = api.notes.patch_nullable()
r["text"] = api.notes.post_text(body="hello")
try:
    api.items.get_item(id="missing")
except sdk.ApiError as e:
    r["error"] = [e.operation_id, e.status, e.body]
try:
    api.items.put_items_by_id(id="x", body=None)
except TypeError as e:
    r["missing"] = str(e)
import typing
r["hints"] = sorted(typing.get_type_hints(sdk.Item).keys())
r["required"] = sorted(sdk.Item.__required_keys__)
r["enum"] = repr(sdk.ClientSchema)
srv.shutdown()
print(json.dumps(r))
`;

test("a generated Python client against a real HTTP server: every parameter location, bodies, HEAD, OPTIONS, text, bytes, errors", { skip }, async (t) => {
  const g = await generate(CONTRACT, { name: "demo" }, { mark: "test", languages: ["python"] });
  assert.deepEqual(g.problems, []);
  const dir = tempDir(t, "forge-py-");
  for (const f of g.files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  py("import py_compile, sys; py_compile.compile('python/demo_sdk/__init__.py', doraise=True)", "", dir);
  const r = JSON.parse(py(SERVER, "", dir));
  assert.deepEqual(r.get, { method: "GET", path: "/items/a%20b?from=2026-10-06&tags=p&tags=q&filter%5Bkind%5D=x", trace: "t1", cookie: "session=s%201", type: null, body: null, id: "x" });
  assert.equal(r.put, null, "204: None");
  assert.equal(r.head, null, "HEAD: None");
  assert.equal(r.options.method, "OPTIONS");
  assert.equal(r.feed, "BEGIN:VCALENDAR");
  assert.deepEqual(r.blob, [37, 80, 68, 70, 0, 1]);
  assert.deepEqual([r.form.type, r.form.body], ["application/x-www-form-urlencoded", "a=1+2"]);
  assert.deepEqual([r.str_json.type, r.str_json.body], ["application/json", '"hello"'], "a JSON string body is JSON-encoded");
  assert.deepEqual([r.null_required.type, r.null_required.body], ["application/json", "null"], "None is JSON null when the schema admits it");
  assert.deepEqual([r.null_optional.type, r.null_optional.body], ["application/json", "null"]);
  assert.deepEqual([r.omitted_optional.type, r.omitted_optional.body], [null, null], "an omitted optional body sends nothing");
  assert.deepEqual([r.text.type, r.text.body], ["text/plain", "hello"], "text/plain is sent as it is, with its type");
  assert.deepEqual(r.error, ["getItem", 404, { error: "none" }]);
  assert.equal(r.missing, "putItemsById: missing required body");
  assert.deepEqual(r.hints, ["from", "id", "parent", "x-y"], "a TypedDict with non-identifier keys resolves");
  assert.deepEqual(r.required, ["id"]);
  assert.equal(r.enum, "typing.Literal['a', 'b']", "a schema named Client does not shadow the Client class");
});

test("python names: keywords and reserved argument names are escaped, wire names kept", () => {
  const op = { params: [{ name: "from", in: "query" }, { name: "headers", in: "header" }, { name: "pageSize", in: "query" }, { name: "page_size", in: "header" }] };
  assert.deepEqual(pyArgNames(op), { from: "from_", headers: "headers_header", pageSize: "page_size", page_size: "page_size_header" });
});

test("the Python client: a JSON reply that does not parse is an ApiError, never None; an empty one is no content", { skip }, async (t) => {
  const d = { openapi: "3.1.0", info: { title: "Demo", version: "1" }, servers: [{ url: "https://h.test" }], paths: { "/items": { get: { operationId: "listItems", tags: ["items"], summary: "List", responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "array" } } } } } } } } };
  const g = await generate(d, { name: "demo" }, { mark: "test", languages: ["python"] });
  const dir = tempDir(t, "forge-py-json-");
  for (const f of g.files) { mkdirSync(dirname(join(dir, f.path)), { recursive: true }); writeFileSync(join(dir, f.path), f.content); }
  const out = py(`import sys, json
sys.path.insert(0, "python")
from demo_sdk import Client, ApiError
def reply(body):
    return Client(transport=lambda m, u, h, b, t: (200, {"content-type": "application/json"}, body))
try:
    reply(b"<html>").request("listItems")
    print("no error")
except ApiError as e:
    print(json.dumps({"status": e.status, "error": e.body["error"]}))
print(json.dumps([reply(b"").request("listItems"), reply(b"[1]").request("listItems")]))`, "", dir);
  assert.deepEqual(out.trim().split("\n").map((l) => JSON.parse(l)), [{ status: 200, error: "invalid_json" }, [null, [1]]]);
});
