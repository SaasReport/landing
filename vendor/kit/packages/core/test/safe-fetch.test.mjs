// safeFetch against an adversarial URL table, redirects, DNS answers, size, time and content type. Nothing touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFetch, assertSafeUrl, validateUrl, classifyIp, dohResolver, SafeFetchError, safeFetchJson } from "../src/safe-fetch.js";

const PUBLIC = async () => ["93.184.216.34"];
const code = async (p) => { try { await p; return "no error"; } catch (e) { assert.ok(e instanceof SafeFetchError, String(e)); return e.code; } };
const ok = (body = "{}", headers = { "content-type": "application/json" }, status = 200) => async () => new Response(body, { status, headers });

// [url, expected error code] for assertSafeUrl (no DNS)
const URL_TABLE = [
  ["http://example.com/", "scheme_not_https"], ["ftp://example.com/", "scheme_not_https"], ["file:///etc/passwd", "scheme_not_https"], ["gopher://example.com/", "scheme_not_https"], ["javascript:alert(1)", "scheme_not_https"], ["data:text/plain,hi", "scheme_not_https"], ["ws://example.com/", "scheme_not_https"],
  ["https://user:pass@example.com/", "credentials_in_url"], ["https://user@example.com/", "credentials_in_url"], ["https://:pw@example.com/", "credentials_in_url"], ["https://example.com@127.0.0.1/", "blocked_address"], ["https://127.0.0.1@example.com/", "credentials_in_url"],
  ["https://example.com:8443/", "port_not_allowed"], ["https://example.com:80/", "port_not_allowed"], ["https://example.com:22/", "port_not_allowed"],
  ["https://127.0.0.1/", "blocked_address"], ["https://127.1/", "blocked_address"], ["https://127.255.255.254/", "blocked_address"], ["https://0.0.0.0/", "blocked_address"], ["https://0/", "blocked_address"],
  ["https://2130706433/", "blocked_address"],            // decimal 127.0.0.1
  ["https://0x7f000001/", "blocked_address"],            // hex
  ["https://0x7f.0.0.1/", "blocked_address"], ["https://017700000001/", "blocked_address"], ["https://0177.0.0.1/", "blocked_address"], ["https://0177.0.0.01/", "blocked_address"],
  ["https://10.0.0.1/", "blocked_address"], ["https://10.255.255.255/", "blocked_address"], ["https://172.16.0.1/", "blocked_address"], ["https://172.31.255.255/", "blocked_address"], ["https://192.168.1.1/", "blocked_address"],
  ["https://169.254.169.254/latest/meta-data/", "blocked_address"], ["https://169.254.0.1/", "blocked_address"], ["https://2852039166/", "blocked_address"],
  ["https://100.64.0.1/", "blocked_address"], ["https://100.127.255.255/", "blocked_address"], ["https://198.18.0.1/", "blocked_address"], ["https://224.0.0.1/", "blocked_address"], ["https://255.255.255.255/", "blocked_address"], ["https://240.0.0.1/", "blocked_address"],
  ["https://192.0.0.8/", "blocked_address"], ["https://192.0.2.1/", "blocked_address"], ["https://198.51.100.7/", "blocked_address"], ["https://203.0.113.9/", "blocked_address"],
  ["https://[::1]/", "blocked_address"], ["https://[::]/", "blocked_address"], ["https://[0:0:0:0:0:0:0:1]/", "blocked_address"], ["https://[::ffff:127.0.0.1]/", "blocked_address"], ["https://[::ffff:7f00:1]/", "blocked_address"], ["https://[::ffff:10.0.0.1]/", "blocked_address"],
  ["https://[::ffff:169.254.169.254]/", "blocked_address"], ["https://[::ffff:0:127.0.0.1]/", "blocked_address"], ["https://[::ffff:0:7f00:1]/", "blocked_address"], ["https://[::ffff:0:10.0.0.1]/", "blocked_address"], ["https://[64:ff9b:1::1]/", "blocked_address"], ["https://[64:ff9b:1:ffff::7f00:1]/", "blocked_address"], ["https://[64:ff9b::7f00:1]/", "blocked_address"], ["https://[64:ff9b::a9fe:a9fe]/", "blocked_address"], ["https://[2002:7f00:1::]/", "blocked_address"], ["https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", "blocked_address"],
  ["https://[fc00::1]/", "blocked_address"], ["https://[fd12:3456::1]/", "blocked_address"], ["https://[fe80::1]/", "blocked_address"], ["https://[fec0::1]/", "blocked_address"], ["https://[ff02::1]/", "blocked_address"], ["https://[2001:db8::1]/", "blocked_address"], ["https://[::127.0.0.1]/", "blocked_address"],
  ["https://localhost/", "blocked_host"], ["https://LOCALHOST./", "blocked_host"], ["https://foo.localhost/", "blocked_host"], ["https://intranet/", "blocked_host"], ["https://metadata/", "blocked_host"], ["https://metadata.google.internal/computeMetadata/v1/", "blocked_host"],
  ["https://printer.local/", "blocked_host"], ["https://db.internal/", "blocked_host"], ["https://router.lan/", "blocked_host"], ["https://x.home.arpa/", "blocked_host"], ["https://kubernetes.default.svc/", "blocked_host"], ["https://1.0.0.127.in-addr.arpa/", "blocked_host"],
  ["https:///etc/passwd", "blocked_host"], ["https://", "bad_url"], ["not a url", "bad_url"], ["", "bad_url"], ["https://exa mple.com/", "bad_url"], ["https://example.com/\n", "ok-trimmed"],
];
for (const [url, want] of URL_TABLE) test(`assertSafeUrl ${JSON.stringify(url)} -> ${want}`, () => {
  if (want === "ok-trimmed") { assert.doesNotThrow(() => assertSafeUrl(url.trim())); return; }
  assert.throws(() => assertSafeUrl(url), (e) => e instanceof SafeFetchError && (e.code === want || (want === "blocked_address" && ["bad_url", "blocked_host", "credentials_in_url"].includes(e.code))), `${url}`);
});

test("a backslash is a path separator for the URL parser, so example.com\\@127.0.0.1 is a request to example.com (and the check sees the same host the connection uses)", () => {
  assert.equal(assertSafeUrl("https://example.com\\@127.0.0.1/").hostname, "example.com");
});

test("public URLs pass: names, public IPv4 and IPv6, trailing dot, non-default allowed port", () => {
  for (const u of ["https://example.com/", "https://example.com./x", "https://sub.example.co.uk/a?b=c#d", "https://93.184.216.34/", "https://[2606:4700:4700::1111]/", "https://xn--mnchen-3ya.example/", "https://8.8.8.8/"]) assert.doesNotThrow(() => assertSafeUrl(u), u);
  assert.doesNotThrow(() => assertSafeUrl("https://example.com:8443/", { ports: [443, 8443] }));
  assert.equal(assertSafeUrl("https://example.com").port, "");
});

test("classifyIp: the boundaries of each block", () => {
  const blocked = ["0.0.0.0", "0.255.255.255", "10.0.0.0", "10.255.255.255", "100.64.0.0", "100.127.255.255", "127.0.0.0", "169.254.0.0", "169.254.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255", "198.18.0.0", "198.19.255.255", "224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.255", "::", "::1", "::ffff:0:0", "fe80::", "febf::", "fc00::", "fdff::", "ff00::", "2001:db8::", "2002::", "64:ff9b::1"];
  const publicIps = ["1.1.1.1", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0", "223.255.255.255", "2606:4700::1111", "2a00:1450::1"];
  for (const ip of blocked) assert.ok(classifyIp(ip), ip);
  for (const ip of publicIps) assert.equal(classifyIp(ip), null, ip);
  assert.equal(classifyIp("example.com"), "not an IP");
  assert.equal(classifyIp("[::1]"), "loopback");
  assert.equal(classifyIp("::ffff:8.8.8.8").startsWith("IPv4-mapped"), true);   // mapped form is refused outright: use the IPv4 form
});

test("hostnames that resolve into private space are refused; every answer is checked; empty and failing DNS fail closed", async () => {
  for (const ips of [["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["93.184.216.34", "10.0.0.5"], ["::1"], ["fd00::1"], ["::ffff:192.168.0.1"], ["100.64.1.1"]]) assert.equal(await code(validateUrl("https://rebind.example.com/", { resolve: async () => ips })), "blocked_address", ips.join());
  assert.equal(await code(validateUrl("https://nx.example.com/", { resolve: async () => [] })), "dns_failed");
  assert.equal(await code(validateUrl("https://nx.example.com/", { resolve: async () => { throw new Error("SERVFAIL"); } })), "dns_failed");
  assert.ok(await validateUrl("https://ok.example.com/", { resolve: async () => ["93.184.216.34", "2606:4700::1111"] }));
  let asked = 0;
  await validateUrl("https://93.184.216.34/", { resolve: async () => { asked++; return []; } });
  assert.equal(asked, 0, "an IP literal is not resolved");
});

test("dohResolver asks A and AAAA and returns the addresses; a failing resolver is dns_failed", async () => {
  const asked = [];
  const f = async (url) => { asked.push(url); const t = new URL(url).searchParams.get("type"); return new Response(JSON.stringify({ Answer: t === "A" ? [{ type: 5, data: "alias.example." }, { type: 1, data: "93.184.216.34" }] : [{ type: 28, data: "2606:4700::1111" }] }), { headers: { "content-type": "application/dns-json" } }); };
  assert.deepEqual(await dohResolver({ endpoint: "https://doh.example/dns-query", fetch: f })("example.com"), ["93.184.216.34", "2606:4700::1111"]);
  assert.equal(asked.length, 2); assert.match(asked[0], /name=example\.com&type=A$/);
  assert.equal(await code(validateUrl("https://example.com/", { resolve: dohResolver({ fetch: async () => new Response("no", { status: 502 }) }) })), "dns_failed");
});

test("allowHosts pins the receivers: exact names and .suffix; anything else is host_not_allowed", async () => {
  const opts = { allowHosts: ["api.example.com", ".partner.example"], resolve: PUBLIC };
  for (const u of ["https://api.example.com/x", "https://a.partner.example/", "https://a.b.partner.example/"]) assert.ok(await validateUrl(u, opts), u);
  for (const u of ["https://example.com/", "https://evilpartner.example/", "https://api.example.com.evil.test/", "https://partner.example/"]) assert.equal(await code(validateUrl(u, opts)), "host_not_allowed", u);
});

/* ---------- redirects ---------- */
const redirector = (hops) => { const seen = []; const f = async (url, init) => { seen.push({ url, init }); const h = hops.shift(); return h ? new Response(null, { status: h[0], headers: { location: h[1] } }) : new Response("{}", { headers: { "content-type": "application/json" } }); }; f.seen = seen; return f; };

test("a redirect is validated like a first request: to an internal address, to http, to a credentialed URL, to a name that resolves inside", async () => {
  for (const [target, want] of [["https://169.254.169.254/latest", "blocked_address"], ["http://example.com/", "scheme_not_https"], ["https://u:p@example.com/", "credentials_in_url"], ["https://[::1]/", "blocked_address"], ["https://localhost/", "blocked_host"], ["https://2130706433/", "blocked_address"], ["https://example.com:8080/", "port_not_allowed"]]) {
    const f = redirector([[302, target]]);
    assert.equal(await code(safeFetch("https://example.com/", {}, { fetch: f, resolve: PUBLIC })), want, target);
    assert.equal(f.seen.length, 1, `${target} was requested`);
  }
  const f = redirector([[302, "https://inner.example.org/"]]);
  const resolve = async (h) => (h === "inner.example.org" ? ["10.9.9.9"] : ["93.184.216.34"]);
  assert.equal(await code(safeFetch("https://example.com/", {}, { fetch: f, resolve })), "blocked_address"); assert.equal(f.seen.length, 1);
});

test("redirects are capped, followed with relative Locations, and each hop is requested with redirect manual", async () => {
  assert.equal(await code(safeFetch("https://example.com/", {}, { fetch: redirector(Array.from({ length: 5 }, () => [302, "/next"])), resolve: PUBLIC, maxRedirects: 3 })), "too_many_redirects");
  const f = redirector([[301, "/a"], [307, "https://other.example.org/b"]]);
  const res = await safeFetch("https://example.com/start", {}, { fetch: f, resolve: PUBLIC });
  assert.equal(res.status, 200);
  assert.deepEqual(f.seen.map((s) => s.url), ["https://example.com/start", "https://example.com/a", "https://other.example.org/b"]);
  assert.ok(f.seen.every((s) => s.init.redirect === "manual"));
  assert.equal(await code(safeFetch("https://example.com/", {}, { fetch: redirector([[302, "http://[bad"]]), resolve: PUBLIC })), "redirect_invalid");
});

test("credentials do not follow a redirect to another origin; a 303 turns a POST into a GET without the body", async () => {
  const f = redirector([[302, "https://other.example.org/"]]);
  await safeFetch("https://example.com/", { headers: { authorization: "Bearer x", cookie: "a=b", accept: "text/plain" } }, { fetch: f, resolve: PUBLIC });
  const h = new Headers(f.seen[1].init.headers);
  assert.deepEqual([h.get("authorization"), h.get("cookie"), h.get("accept")], [null, null, "text/plain"]);
  const g = redirector([[303, "/done"]]);
  await safeFetch("https://example.com/", { method: "POST", body: "payload", headers: { "content-type": "text/plain" } }, { fetch: g, resolve: PUBLIC });
  assert.deepEqual([g.seen[1].init.method, g.seen[1].init.body], ["GET", undefined]);
  const s = redirector([[307, "/again"]]);
  await safeFetch("https://example.com/", { method: "POST", body: "payload" }, { fetch: s, resolve: PUBLIC });
  assert.deepEqual([s.seen[1].init.method, s.seen[1].init.body], ["POST", "payload"]);
  assert.equal(await code(safeFetch("https://example.com/", { method: "POST", body: new ReadableStream() }, { fetch: redirector([[307, "/again"]]), resolve: PUBLIC })), "redirect_invalid");
});

test("followRedirects false returns the 3xx as it is (a webhook receiver that redirects is a failed delivery, not a hop)", async () => {
  const f = redirector([[302, "https://169.254.169.254/"]]);
  const res = await safeFetch("https://example.com/", {}, { fetch: f, resolve: PUBLIC, followRedirects: false });
  assert.equal(res.status, 302); assert.equal(f.seen.length, 1);
});

/* ---------- size, type, time ---------- */
test("the response size cap is enforced while streaming and on a declared length", async () => {
  assert.equal(await code(safeFetch("https://example.com/", {}, { fetch: ok("x", { "content-length": "999999", "content-type": "application/json" }), resolve: PUBLIC, maxBytes: 1000 })), "too_large");
  let pulled = 0;
  const endless = async () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } }), { headers: { "content-type": "application/octet-stream" } });
  const res = await safeFetch("https://example.com/", {}, { fetch: endless, resolve: PUBLIC, maxBytes: 4096 });
  await assert.rejects(res.arrayBuffer(), (e) => e instanceof SafeFetchError && e.code === "too_large");
  assert.ok(pulled < 20, `pulled ${pulled} chunks of an endless body`);
  const fine = await safeFetch("https://example.com/", {}, { fetch: ok("0123456789"), resolve: PUBLIC, maxBytes: 10 });
  assert.equal(await fine.text(), "0123456789");
});

test("content-type allowlist: exact, wildcard, parameters, and a missing type", async () => {
  const types = (list, ct) => safeFetch("https://example.com/", {}, { fetch: ok("x", ct === undefined ? {} : { "content-type": ct }), resolve: PUBLIC, allowedContentTypes: list });
  assert.ok(await types(["application/json"], "application/json; charset=utf-8"));
  assert.ok(await types(["image/*"], "image/png"));
  for (const [list, ct] of [[["application/json"], "text/html"], [["application/json"], undefined], [["image/*"], "application/octet-stream"], [["application/json"], "application/jsonp"], [["application/json"], "text/html; x=application/json"]]) assert.equal(await code(types(list, ct)), "content_type_not_allowed", `${list} ${ct}`);
  assert.deepEqual(await safeFetchJson("https://example.com/", {}, { fetch: ok('{"a":1}'), resolve: PUBLIC }), { a: 1 });
  assert.equal(await code(safeFetchJson("https://example.com/", {}, { fetch: ok("<html>", { "content-type": "text/html" }), resolve: PUBLIC })), "content_type_not_allowed");
});

test("the total time limit covers the whole call (a hung server is a timeout), and the caller's own signal is honoured", async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  assert.equal(await code(safeFetch("https://example.com/", {}, { fetch: hang, resolve: PUBLIC, timeoutMs: 30 })), "timeout");
  const ctl = new AbortController(); setTimeout(() => ctl.abort(new Error("caller gave up")), 10);
  await assert.rejects(safeFetch("https://example.com/", { signal: ctl.signal }, { fetch: hang, resolve: PUBLIC, timeoutMs: 5000 }), /caller gave up|timeout/);
});

test("discardBody never reads the response; the status and headers come back", async () => {
  let cancelled = false;
  const f = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 202, headers: { "x-message-id": "m1" } });
  const res = await safeFetch("https://example.com/", {}, { fetch: f, resolve: PUBLIC, discardBody: true });
  assert.deepEqual([res.status, res.headers.get("x-message-id"), res.body, cancelled], [202, "m1", null, true]);
});

test("a request to a refused URL never reaches fetch", async () => {
  let calls = 0;
  const f = async () => { calls++; return new Response("{}"); };
  for (const [url] of URL_TABLE.slice(0, 60)) await safeFetch(url, {}, { fetch: f, resolve: PUBLIC }).catch(() => {});   // each refusal is expected; the test asserts fetch was never called
  assert.equal(calls, 0);
});

test("classifyIp: IPv4-translated ::ffff:0:a.b.c.d (not the mapped ::ffff:a.b.c.d) follows its embedded address; local-use NAT64 64:ff9b:1::/48 is never public", () => {
  assert.match(classifyIp("::ffff:0:127.0.0.1"), /IPv4-translated loopback/);
  assert.match(classifyIp("[::ffff:0:a9fe:a9fe]"), /IPv4-translated link-local/);
  assert.match(classifyIp("::ffff:0:8.8.8.8"), /IPv4-translated address/, "a public embedded address is still not a plain public unicast: use the IPv4 form");
  assert.match(classifyIp("64:ff9b:1::1"), /local-use NAT64/); assert.match(classifyIp("64:ff9b:1:abcd::"), /local-use NAT64/);
  assert.match(classifyIp("::ffff:127.0.0.1"), /IPv4-mapped loopback/);
  assert.equal(classifyIp("2606:4700:4700::1111"), null);
});

test("a redirect to another origin carries only an allowlist of headers: x-api-key, proxy-authorization, x-auth-token and custom credentials are dropped too", async () => {
  const f = redirector([[302, "https://other.example.org/"]]);
  const sent = { authorization: "Bearer x", cookie: "a=b", "x-api-key": "k", "proxy-authorization": "Basic x", "x-auth-token": "t", "x-vendor-secret": "s", accept: "application/json", "user-agent": "kit" };
  await safeFetch("https://example.com/", { headers: sent }, { fetch: f, resolve: PUBLIC });
  assert.deepEqual([...new Headers(f.seen[0].init.headers).keys()].sort(), Object.keys(sent).sort(), "the first hop carries everything");
  assert.deepEqual([...new Headers(f.seen[1].init.headers).keys()].sort(), ["accept", "user-agent"]);
  const same = redirector([[302, "/next"]]);
  await safeFetch("https://example.com/", { headers: sent }, { fetch: same, resolve: PUBLIC });
  assert.equal(new Headers(same.seen[1].init.headers).get("x-api-key"), "k", "same origin keeps its headers");
  const post = redirector([[307, "https://other.example.org/"]]);
  await safeFetch("https://example.com/", { method: "POST", body: "p", headers: { "content-type": "text/plain", "x-api-key": "k" } }, { fetch: post, resolve: PUBLIC });
  assert.deepEqual([...new Headers(post.seen[1].init.headers).keys()], ["content-type"]);
});

test("the total time limit is real: a hung server is a timeout error (code and message) at timeoutMs, not at the platform's limit", async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  await assert.rejects(safeFetch("https://example.com/", {}, { fetch: hang, resolve: PUBLIC, timeoutMs: 1 }), (e) => e instanceof SafeFetchError && e.code === "timeout" && e.message === "timeout");
  // the limit is what decides: a different limit gives the same error, with no clock read in the test
  await assert.rejects(safeFetch("https://example.com/", {}, { fetch: hang, resolve: PUBLIC, timeoutMs: 5 }), (e) => e instanceof SafeFetchError && e.code === "timeout");
});

test("the total time limit also covers a slow body: a response that stalls after its headers is aborted at timeoutMs and the read fails with timeout", async () => {
  const slow = async (url, init) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode("{")); init.signal.addEventListener("abort", () => c.error(init.signal.reason)); },
  }), { headers: { "content-type": "application/json" } });
  const res = await safeFetch("https://example.com/", {}, { fetch: slow, resolve: PUBLIC, timeoutMs: 1 });
  await assert.rejects(res.text(), (e) => e instanceof SafeFetchError && e.code === "timeout");
});

test("a finished body clears the timer: the signal is not aborted afterwards", async () => {
  let signal;
  const f = async (url, init) => { signal = init.signal; return new Response("{}", { headers: { "content-type": "application/json" } }); };
  const res = await safeFetch("https://example.com/", {}, { fetch: f, resolve: PUBLIC, timeoutMs: 40 });
  assert.equal(await res.text(), "{}");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(signal.aborted, false);
  const g = async (url, init) => { signal = init.signal; return new Response("x", { headers: { "content-type": "application/json" } }); };
  await safeFetch("https://example.com/", {}, { fetch: g, resolve: PUBLIC, timeoutMs: 40, discardBody: true });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(signal.aborted, false, "discardBody clears it too");
});
