// @saasreport/cloudflare/csp: the policy file is validated against schema/csp.schema.json, the header is built from it with
// a fresh nonce per HTML response, every <script> gets that nonce, older CSP headers and validators are dropped, and
// violation reports in both formats are normalised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CSP_SCHEMA, validateCsp, defineCsp, cspHeader, createNonce, addNonce, withCsp, nonceOf, readCspReports } from "../src/csp.js";

const CONFIG = {
  report: { path: "/api/csp-report", group: "csp" },
  policies: {
    site: { nonce: ["script-src"], directives: { "default-src": ["'self'"], "script-src": ["'self'", "https://static.example.net"], "style-src": ["'self'", "'unsafe-inline'"], "frame-ancestors": ["'none'"], "upgrade-insecure-requests": [] } },
    app: { directives: { "default-src": ["'self'"], "script-src": ["'self'"] } },
  },
};

test("the schema is JSON Schema 2020-12 with an $id", () => {
  assert.equal(CSP_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(CSP_SCHEMA.$id, "urn:kit:schema:csp:v1");
  assert.deepEqual(validateCsp(CONFIG), []);
});

test("invalid policy files are refused with a path per problem", () => {
  const bad = (mut) => { const c = structuredClone(CONFIG); mut(c); return validateCsp(c).map((p) => p.path); };
  assert.deepEqual(bad((c) => c.policies.site.directives["script-src"].push("'unsafe-inline'")), ["/policies/site/directives/script-src/2"]);
  assert.deepEqual(bad((c) => c.policies.site.directives["default-src"].push("'unsafe-eval'")), ["/policies/site/directives/default-src/1"]);
  assert.deepEqual(bad((c) => c.policies.site.directives["script-src-elem"] = ["*"]), ["/policies/site/directives/script-src-elem/0"]);
  assert.deepEqual(bad((c) => delete c.policies.app.directives["script-src"]), ["/policies/app/directives"]);
  assert.deepEqual(bad((c) => c.policies.site.directives["img-src"] = ["'self'; script-src *"]), ["/policies/site/directives/img-src/0"]);
  assert.deepEqual(bad((c) => c.policies.site.nonce = ["img-src"]), ["/policies/site/nonce/0"]);
  assert.deepEqual(bad((c) => c.policies.Site = c.policies.site), ["/policies/Site"]);
  assert.deepEqual(bad((c) => c.extra = 1), ["/extra"]);
  assert.deepEqual(bad((c) => c.report.path = "https://elsewhere.example/r"), ["/report/path"]);
  assert.deepEqual(bad((c) => c.policies = {}), ["/policies"]);
  assert.throws(() => defineCsp({ policies: { site: { directives: { "default-src": ["'self'"], "script-src": ["'unsafe-inline'"] } } } }), /script-src\/0/);
});

test("the header follows the file, adds the nonce only where asked, and names the report endpoint", () => {
  const csp = defineCsp(CONFIG);
  assert.equal(cspHeader(csp, "site", { nonce: "abc" }), "default-src 'self'; script-src 'self' https://static.example.net 'nonce-abc'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /api/csp-report; report-to csp");
  assert.equal(cspHeader(csp, "app", { nonce: "abc" }), "default-src 'self'; script-src 'self'; report-uri /api/csp-report; report-to csp");
  assert.doesNotMatch(cspHeader(csp, "site"), /nonce/);
  assert.throws(() => cspHeader(csp, "nope"), /no CSP policy "nope"/);
});

test("nonces are 128-bit, base64 and never repeat", () => {
  const seen = new Set(Array.from({ length: 200 }, createNonce));
  assert.equal(seen.size, 200);
  for (const n of seen) assert.match(n, /^[A-Za-z0-9+/]{22}==$/);
});

test("addNonce sets the nonce on every script start tag and keeps an existing one", () => {
  const html = `<script>a()</script><SCRIPT src="/x.js" defer></SCRIPT><script type="application/ld+json">{}</script><script nonce="keep">b()</script><p>script</p>`;
  assert.equal(addNonce(html, "N"), `<script nonce="N">a()</script><script nonce="N" src="/x.js" defer></SCRIPT><script nonce="N" type="application/ld+json">{}</script><script nonce="keep">b()</script><p>script</p>`);
});

test("withCsp: HTML gets one fresh policy and the same nonce on every script; validators and old CSPs are dropped", async () => {
  const csp = defineCsp(CONFIG);
  const page = () => new Response(`<!doctype html><script src="/a.js"></script><script>go()</script>`, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src *", "content-security-policy-report-only": "x", etag: '"e"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT", "cache-control": "public, max-age=0" } });
  const a = withCsp(page(), csp, "site"), b = withCsp(page(), csp, "site");
  const n = nonceOf(a);
  assert.ok(n && n !== nonceOf(b), "a new nonce per response");
  assert.equal(a.headers.get("content-security-policy"), cspHeader(csp, "site", { nonce: n }));
  assert.equal(a.headers.get("content-security-policy-report-only"), null);
  assert.equal(a.headers.get("reporting-endpoints"), 'csp="/api/csp-report"');
  assert.equal(a.headers.get("etag"), null);
  assert.equal(a.headers.get("last-modified"), null);
  assert.equal(a.headers.get("cache-control"), "public, max-age=0");
  assert.equal(await a.text(), `<!doctype html><script nonce="${n}" src="/a.js"></script><script nonce="${n}">go()</script>`);
  assert.equal(withCsp(page(), csp, "site", { nonce: "fixed" }).headers.get("content-security-policy").includes("'nonce-fixed'"), true);
  const ro = withCsp(page(), csp, "site", { reportOnly: true });
  assert.equal(ro.headers.get("content-security-policy"), null);
  assert.match(ro.headers.get("content-security-policy-report-only"), /'nonce-/);
});

test("withCsp: other responses keep their body and validators and get the policy without a nonce", async () => {
  const csp = defineCsp(CONFIG);
  const r = withCsp(new Response("body{}", { status: 200, headers: { "content-type": "text/css", etag: '"e"' } }), csp, "site");
  assert.equal(await r.text(), "body{}");
  assert.equal(r.headers.get("etag"), '"e"');
  assert.doesNotMatch(r.headers.get("content-security-policy"), /nonce/);
  const nm = withCsp(new Response(null, { status: 304, headers: { "content-type": "text/html" } }), csp, "site");
  assert.equal(nm.status, 304);
  assert.doesNotMatch(nm.headers.get("content-security-policy"), /nonce/);
});

test("readCspReports normalises report-uri and Reporting API bodies, and ignores anything else", async () => {
  const post = (body, type = "application/csp-report") => { const text = typeof body === "string" ? body : JSON.stringify(body); return new Request("https://x.example/api/csp-report", { method: "POST", headers: { "content-type": type, "content-length": String(new TextEncoder().encode(text).length) }, body: text }); };
  const legacy = await readCspReports(post({ "csp-report": { "document-uri": "https://x.example/", "blocked-uri": "inline", "effective-directive": "script-src-elem", "source-file": "https://x.example/", "line-number": 12, "script-sample": "alert(1)" } }));
  assert.deepEqual(legacy, [{ documentURL: "https://x.example/", blockedURL: "inline", directive: "script-src-elem", disposition: "enforce", sourceFile: "https://x.example/", line: 12, column: null, sample: "alert(1)", statusCode: null }]);
  const modern = await readCspReports(post([{ type: "csp-violation", url: "https://x.example/p/", body: { documentURL: "https://x.example/p/", blockedURL: "https://evil.example/x.js", effectiveDirective: "script-src-elem", disposition: "report", lineNumber: 3, columnNumber: 9, statusCode: 200 } }, { type: "deprecation", body: {} }], "application/reports+json"));
  assert.equal(modern.length, 1);
  assert.equal(modern[0].blockedURL, "https://evil.example/x.js");
  assert.equal(modern[0].disposition, "report");
  assert.deepEqual(await readCspReports(post("not json")), []);
  assert.deepEqual(await readCspReports(post({ hello: 1 })), []);
  assert.deepEqual(await readCspReports(post("x".repeat(20000))), []);
  assert.deepEqual(await readCspReports(new Request("https://x.example/api/csp-report")), []);
  const many = await readCspReports(post(Array.from({ length: 50 }, () => ({ type: "csp-violation", body: { blockedURL: "inline" } }))), { maxBytes: 1e6 });
  assert.equal(many.length, 20);
});
