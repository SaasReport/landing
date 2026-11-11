// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance. Not derived from upstream Forge (whose Python SDK is Cloudflare's Fern configuration
// run in Docker): a native target, plain string emission, no Docker, no Python packages beyond the standard library.
/**
 * The Python target: a typed client package, Python ≥ 3.11, standard library only (urllib, json, typing).
 *
 *   python/<module>/__init__.py   TypedDicts for the component schemas, Client with one method per operation,
 *                                 grouped as Forge groups them: Client(base_url).items.get_item(id="7")
 *   python/<module>/py.typed      PEP 561 marker
 *   python/pyproject.toml         the package (setuptools metadata, no dependencies)
 *
 * Parameters are keyword-only, by their snake_case names (wire names in OPERATIONS); serialization follows the same
 * OpenAPI 3.1 rules as the JavaScript client (runtime/params.py, held to params.js by the tests).
 */
import { readFileSync } from "node:fs";
import { toSnakeCase } from "../naming.js";
import { isJsonMediaType } from "../openapi-resolver.js";
import { responseKinds } from "../model.js";
import { operationTable, packageVersion } from "./javascript.js";
import { PY_RESERVED, isPyIdentifier, pyDefinition, pySchemaNames, pyType } from "./py-types.js";

/** runtime/params.py, inlined into every generated module (its licence header dropped; the module carries one). */
export const PY_PARAMS_RUNTIME = readFileSync(new URL("../runtime/params.py", import.meta.url), "utf8").replace(/^# SPDX-License-Identifier:.*\n# Copyright.*\n/, "").trim();

/** The Python module name of a target: "saasreport" → "saasreport_sdk". */
export const pyModuleName = (target) => `${toSnakeCase(target.name).replace(/[^a-z0-9_]/g, "_")}_sdk`;

/** A name as a Python identifier: snake_case, never a keyword ("from" → "from_", "2fa" → "_2fa"). */
export function pyName(s) {
  let n = toSnakeCase(String(s)).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "value";
  if (/^\d/.test(n)) n = `_${n}`;
  return PY_RESERVED.has(n) ? `${n}_` : n;
}

/** A value as a Python literal (dicts and lists indented like JSON.stringify(v, null, 4)). */
export function pyLiteral(v, depth = 0) {
  const pad = "    ".repeat(depth + 1);
  const end = "    ".repeat(depth);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "None";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${pad}${pyLiteral(x, depth + 1)}`).join(",\n")},\n${end}]` : "[]";
  const e = Object.entries(v);
  return e.length ? `{\n${e.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pyLiteral(x, depth + 1)}`).join(",\n")},\n${end}}` : "{}";
}

const docstring = (lines, indent) => {
  const esc = (l) => l.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
  const body = lines.map(esc);
  return body.length === 1 ? `${indent}"""${body[0]}"""` : `${indent}"""${body[0]}\n${body.slice(1).map((l) => (l ? `${indent}${l}` : "")).join("\n")}\n${indent}"""`;
};

/** A union of Python type expressions (Any absorbs everything; None makes it Optional). */
function pyUnion(parts) {
  const u = [...new Set(parts)];
  if (u.includes("Any") || !u.length) return "Any";
  const rest = u.filter((p) => p !== "None");
  if (rest.length === u.length) return u.length === 1 ? u[0] : `Union[${u.join(", ")}]`;
  if (!rest.length) return "None";
  return `Optional[${rest.length === 1 ? rest[0] : `Union[${rest.join(", ")}]`}]`;
}

function returnType(op, ctx) {
  return pyUnion(responseKinds(op).map((r) => {
    if (r.kind === "unknown") return "Any";
    if (r.kind === "none") return "None";
    if (r.kind === "json") return r.schema === undefined ? "Any" : pyType(r.schema, ctx);
    if (r.kind === "text") return "str";
    return "bytes";
  }));
}

/** Keyword argument names of an operation: { wire name → python name }, unique, never self/body/headers/timeout. */
export function pyArgNames(op) {
  const taken = new Set(["self", "body", "headers", "timeout"]);
  const out = {};
  for (const p of op.params) {
    let n = pyName(p.name);
    if (taken.has(n)) n = `${n}_${p.in}`;
    for (let i = 2; taken.has(n); i++) n = `${pyName(p.name)}_${p.in}${i}`;
    taken.add(n);
    out[p.name] = n;
  }
  return out;
}

function method(name, op, ctx) {
  const args = pyArgNames(op);
  const sig = ["self", "*"];
  const params = [...op.params].sort((a, b) => Number(b.required) - Number(a.required));
  for (const p of params) {
    const t = pyType(p.schema, ctx);
    sig.push(p.required ? `${args[p.name]}: ${t}` : `${args[p.name]}: ${pyUnion([t, "None"])} = None`);
  }
  if (op.body) {
    let t = pyType(op.body.schema, ctx);
    if (!op.body.contentTypes.some(isJsonMediaType)) t = pyUnion([t, "bytes", "str"]);
    // a required body is passed as given (None is JSON null when the schema admits it); an optional one defaults to
    // OMITTED, so leaving it out and sending null stay distinct
    sig.splice(op.body.required ? 2 + params.filter((p) => p.required).length : sig.length, 0, op.body.required ? `body: ${t}` : `body: ${pyUnion([t, "None", "Omitted"])} = OMITTED`);
  }
  sig.push("headers: Optional[Mapping[str, str]] = None", "timeout: Optional[float] = None");
  const text = [op.summary, op.description && op.description !== op.summary ? op.description : ""].filter(Boolean).join("\n\n");
  const doc = [...(text ? text.split("\n").map((l) => l.trimEnd()) : [op.id]), "", `${op.method} ${op.path}`, ...(op.deprecated ? ["", "Deprecated."] : [])];
  const values = op.params.map((p) => `${JSON.stringify(p.name)}: ${args[p.name]}`).join(", ");
  return [
    `    def ${name}(`,
    ...sig.map((s) => `        ${s},`),
    `    ) -> ${returnType(op, ctx)}:`,
    docstring(doc, "        "),
    `        return self._client.request(${JSON.stringify(op.id)}, {${values}}, ${op.body ? "body" : "OMITTED"}, headers, timeout)`,
  ].join("\n");
}

/**
 * __init__.py
 * @param {ReturnType<typeof import("../model.js").buildModel>} m
 * @param {object} doc the contract (component schemas)
 * @param {string} header the generated-file header with "#" comments
 */
export function emitPythonModule(m, doc, header) {
  const schemas = Object.entries(doc.components?.schemas || {}).sort(([a], [b]) => a.localeCompare(b));
  const names = pySchemaNames(schemas.map(([k]) => k));
  const ctx = { doc, names };
  const title = `${m.info.title || m.target.name} ${m.info.version || ""}`.trim();
  // one class per group node, depth first; attribute and method names unique within a node
  const classes = [];
  const usedClass = new Set();
  const groupClass = (path, node) => {
    let cls = `_${path.map((s) => pyName(s)).join("_")}`.replace(/__+/g, "_");
    for (let i = 2; usedClass.has(cls); i++) cls = `_${path.map((s) => pyName(s)).join("_")}${i}`;
    usedClass.add(cls);
    const members = [];
    const children = [];
    const used = new Set(["request"]);
    const unique = (n) => {
      let x = n;
      for (let i = 2; used.has(x); i++) x = `${n}_${i}`;
      used.add(x);
      return x;
    };
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") members.push([unique(pyName(k)), v]);
      else children.push([unique(pyName(k)), groupClass([...path, k], v)]);
    }
    const body = [`class ${cls}:`, docstring([`Operations of ${path.join(".")}.`], "    "), "", "    def __init__(self, client: Client) -> None:", "        self._client = client"];
    for (const [attr, c] of children) body.push(`        self.${attr} = ${c}(client)`);
    for (const [n, id] of members) body.push("", method(n, m.ops[id], ctx));
    classes.push(body.join("\n"));
    return cls;
  };
  const top = Object.entries(m.tree).map(([k, v]) => [k, groupClass([k], v)]);
  const used = new Set(["request", "base_url", "headers", "timeout", "transport"]);
  const attrs = top.map(([k, cls]) => {
    let a = pyName(k);
    for (let i = 2; used.has(a); i++) a = `${pyName(k)}_${i}`;
    used.add(a);
    return [a, cls];
  });
  const all = ["ApiError", "Client", "OMITTED", "OPERATIONS", "Omitted", "SERVERS", "Transport", "urllib_transport", ...Object.values(names)].sort();
  return `${header.trimEnd()}
${docstring([`${title}: a typed client for every operation of the contract.`, "", "Python 3.11 or later, standard library only. Generated from the OpenAPI contract: never edit by hand."], "")}

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Literal, Mapping, NotRequired, Optional, TypeAlias, TypedDict, Union

__all__ = ${pyLiteral(all)}

SERVERS: list[str] = ${pyLiteral(m.servers)}

OPERATIONS: dict[str, Any] = ${pyLiteral(operationTable(m))}


# Component schemas (components.schemas)
${schemas.length ? schemas.map(([k, s]) => pyDefinition(names[k], s, ctx)).join("\n\n\n") : "# (none)"}


class ApiError(Exception):
    """A response outside 2xx: the operation, the HTTP status and the decoded body."""

    def __init__(self, operation_id: str, status: int, body: Any) -> None:
        super().__init__(f"{operation_id}: HTTP {status}")
        self.operation_id = operation_id
        self.status = status
        self.body = body


Transport = Callable[[str, str, dict[str, str], Optional[bytes], Optional[float]], tuple[int, dict[str, str], bytes]]
"""(method, url, headers, body, timeout) → (status, headers with lower-case names, body)."""


def urllib_transport(method: str, url: str, headers: dict[str, str], body: Optional[bytes], timeout: Optional[float]) -> tuple[int, dict[str, str], bytes]:
    """The default transport: urllib.request (an HTTP error status is returned, not raised)."""
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, {k.lower(): v for k, v in res.headers.items()}, res.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


${PY_PARAMS_RUNTIME}


class Client:
${docstring([`${title} client.`, "", `client = Client(${JSON.stringify(m.servers[0] || "https://…")}, headers={"authorization": "Bearer …"})`, `client.${attrs[0]?.[0] ?? "group"}.<method>(…)`], "    ")}

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = 30.0,
        transport: Optional[Transport] = None,
    ) -> None:
        self.base_url = (base_url if base_url is not None else (SERVERS[0] if SERVERS else "")).rstrip("/")
        self.headers = dict(headers or {})
        self.timeout = timeout
        self.transport = transport or urllib_transport
${attrs.map(([a, cls]) => `        self.${a} = ${cls}(self)`).join("\n")}

    def request(
        self,
        operation_id: str,
        params: Optional[Mapping[str, Any]] = None,
        body: Any = OMITTED,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """One request: parameters by their contract names, the body (OMITTED: none), per-call headers; ApiError outside 2xx."""
        op = OPERATIONS.get(operation_id)
        if op is None:
            raise TypeError(f"unknown operation {operation_id}")
        path, query, param_headers, cookie = _serialize_params(operation_id, op, params or {})
        sent = {**self.headers, **(headers or {}), **param_headers}
        if cookie:
            sent["cookie"] = f"{sent['cookie']}; {cookie}" if sent.get("cookie") else cookie
        data: Optional[bytes] = None
        if op["body"] is not None:
            data, content_type = _encode_body(operation_id, op["body"], body)
            if data is not None and content_type:
                sent.setdefault("content-type", content_type)
        url = f"{self.base_url}{path}" + (f"?{query}" if query else "")
        status, res_headers, raw = self.transport(op["method"], url, sent, data, self.timeout if timeout is None else timeout)
        ct = res_headers.get("content-type", "")
        value: Any
        if op["method"] == "HEAD" or status in (204, 205):
            value = None
        elif _is_json(ct):
            try:
                value = json.loads(raw) if raw else None
            except ValueError as e:
                raise ApiError(operation_id, status, {"error": "invalid_json", "message": str(e)}) from e
        elif not ct or ct.startswith("text/") or "xml" in ct:
            value = raw.decode("utf-8")
        else:
            value = bytes(raw)
        if not 200 <= status < 300:
            raise ApiError(operation_id, status, value)
        return value


${classes.join("\n\n\n")}
`;
}

/**
 * pyproject.toml
 * @param {ReturnType<typeof import("../model.js").buildModel>} m
 * @param {string} description
 * @param {string} header
 */
export function emitPyproject(m, description, header) {
  const mod = pyModuleName(m.target);
  const toml = (s) => JSON.stringify(s);
  return `${header.trimEnd()}
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = ${toml(`${m.target.name}-sdk`)}
version = ${toml(packageVersion(m.info.version))}
description = ${toml(description)}
requires-python = ">=3.11"
dependencies = []

[tool.setuptools]
packages = [${toml(mod)}]

[tool.setuptools.package-data]
${mod} = ["py.typed"]
`;
}

/** Whether every generated Python name is an identifier (a guard for the tests). */
export const checkPyIdentifier = isPyIdentifier;
