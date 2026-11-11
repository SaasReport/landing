import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit } from "./helpers.mjs";

const call = async (get, path, init) => { const r = await get(path, init); return [r.status, await r.json(), r.headers]; };

test("calendar REST API (fa site: jalali, bank weekend, Iranian holidays)", async () => {
  const { get } = makeKit("fa");
  let [st, body, h] = await call(get, "/api/calendar/settlement?date=1404/12/28&t=1");
  assert.equal(st, 200);
  assert.equal(h.get("access-control-allow-origin"), "*");
  assert.equal(body.data.settlement.jalali, "1405/01/05");
  [st, body] = await call(get, "/api/calendar/day?date=1404/12/30");
  assert.equal(st, 422); assert.equal(body.error.code, "invalid_date");
  [st, body] = await call(get, "/api/calendar/schedule", { method: "POST", body: JSON.stringify({ start: "1405/05/31", count: 3, amount: 900 }) });
  assert.equal(st, 200); assert.equal(body.data.instalments.length, 3);
  assert.equal(body.data.instalments.reduce((s, r) => s + r.amount, 0), 900);
  [st] = await call(get, "/api/calendar/day?date=1405/01/01&profile=nope"); assert.equal(st, 422);
  [st, body] = await call(get, "/api/calendar/day?date=1405/01/01&profile=government");
  assert.equal(st, 200); assert.equal(body.data.holiday, true);
  [st] = await call(get, "/api/calendar/nope"); assert.equal(st, 404);
  [st, body] = await call(get, "/api/calendar/today");
  assert.equal(st, 200); assert.equal(body.data.iso, "2026-10-03");
  [st, body] = await call(get, "/api/calendar");
  assert.ok(body.data.endpoints.includes("/mcp"));
  const spec = await (await get("/api/calendar/openapi.json")).json();
  assert.equal(spec.openapi, "3.1.0"); assert.equal(spec.servers[0].url, "https://fa.example.org"); assert.ok(spec.paths["/api/calendar/settlement"]);
  const r = await get("/calendar.ics?from=1405&to=1405");
  assert.match(r.headers.get("content-type"), /text\/calendar/);
  const ics = await r.text();
  assert.match(ics, /X-WR-CALNAME/); assert.match(ics, /BEGIN:VEVENT/);
  // Event UIDs carry the site's own prefix (the one its .ics filename uses), never the engine's default.
  const id = /filename="(.+)-calendar\.ics"/.exec(r.headers.get("content-disposition"))[1];
  const uids = ics.match(/^UID:.*$/gm);
  assert.ok(uids.length > 0 && uids.every((u) => u.startsWith(`UID:${id}-`)), `UIDs should start with ${id}-`);
  assert.equal((await get("/api/calendar/day", { method: "OPTIONS" })).status, 204);
});

test("calendar REST API on a gregorian site uses its weekend and no Iranian holidays", async () => {
  const { get } = makeKit("en");
  let [, body] = await call(get, "/api/calendar/day?date=2026-10-03"); // Saturday
  assert.equal(body.data.weekend, true); assert.equal(body.data.business_day, false);
  [, body] = await call(get, "/api/calendar/day?date=2027-03-21"); // Nowruz, a Sunday → weekend, not a holiday here
  assert.equal(body.data.holiday, false); assert.deepEqual(body.data.events, []);
  [, body] = await call(get, "/api/calendar/day?date=2027-03-22"); // Monday
  assert.equal(body.data.business_day, true);
  [, body] = await call(get, "/api/calendar/settlement?date=2026-10-02&t=1"); // Friday → Monday
  assert.equal(body.data.settlement.iso, "2026-10-05");
  assert.equal((await get("/calendar.ics")).status, 404);
});

test("MCP server speaks JSON-RPC (initialize, notifications, tools/list, tools/call, errors, batch)", async () => {
  const { get } = makeKit("fa");
  const rpc = async (body) => { const r = await get("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return [r.status, r.status === 202 ? null : await r.json(), r]; };
  let [st, b, r] = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(st, 200); assert.equal(b.result.serverInfo.name, "fa-example-org-calendar");
  assert.equal(r.headers.get("mcp-protocol-version"), "2025-06-18");
  [st] = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); assert.equal(st, 202);
  [, b] = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(b.result.tools.length, 7); assert.ok(b.result.tools.every((x) => x.annotations.readOnlyHint && !("run" in x)));
  [, b] = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "calendar_settlement", arguments: { date: "1404/12/28", t: 1 } } });
  assert.equal(b.result.structuredContent.jalali, "1405/01/05"); assert.equal(b.result.isError, false);
  [, b] = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "calendar_day", arguments: { date: "1404/12/30" } } });
  assert.equal(b.result.isError, true);
  [, b] = await rpc({ jsonrpc: "2.0", id: 5, method: "nope" }); assert.equal(b.error.code, -32601);
  [, b] = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }); assert.equal(b.error.code, -32602);
  [, b] = await rpc([{ jsonrpc: "2.0", id: 7, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]);
  assert.equal(b.length, 1); assert.deepEqual(b[0].result, {});
  const bad = await get("/mcp", { method: "POST", body: "{" }); assert.equal(bad.status, 400);
  assert.equal((await get("/mcp")).status, 405);
});

test("calendar routes are absent without the calendar engine", async () => {
  const { get } = makeKit("fa", { deps: { calendar: undefined } });
  assert.equal((await get("/api/calendar/today")).status, 404);
  assert.equal((await get("/mcp", { method: "POST", body: "{}" })).status, 404);
});

/* ------------------------------------------------------------------ market feeds: /calendar/<market>.ics */
const marketSite = (extra = {}) => makeKit("en", { config: (c) => ({ ...c, site: { ...c.site, ...extra.site }, calendar: { systems: ["gregorian", "hijri-umalqura"], primary: "gregorian", profiles: ["sa", "ae", "uk"], ...extra.calendar }, features: { ...c.features, ...extra.features } }) });

test("market feeds: /calendar/<market>.ics for the site's markets, text/calendar, cache headers, site-prefixed UIDs", async () => {
  const { get, kit } = marketSite({ site: { id: "acme" } });
  assert.deepEqual(kit.calendarFeeds().map((f) => f.market), ["sa", "ae", "uk"]);
  assert.equal(kit.calendarFeeds()[0].webcal, "webcal://en.example.org/calendar/sa.ics");
  for (const f of kit.calendarFeeds()) {
    const r = await get(f.path);
    assert.equal(r.status, 200, f.path);
    assert.equal(r.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.match(r.headers.get("cache-control"), /public, max-age=\d+/);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("content-disposition"), `inline; filename="acme-${f.market}.ics"`);
    const t = await r.text();
    assert.ok(t.startsWith("BEGIN:VCALENDAR\r\n") && t.endsWith("END:VCALENDAR\r\n"));
    const uids = t.replace(/\r\n /g, "").match(/^UID:.*$/gm);
    assert.ok(uids.length > 0 && uids.every((u) => u.startsWith(`UID:acme-${f.market}-`) && u.endsWith("@en.example.org")), uids[0]);
    // Conditional GET
    const again = await get(f.path, { headers: { "if-none-match": r.headers.get("etag") } });
    assert.equal(again.status, 304);
  }
  const sa = await (await get("/calendar/sa.ics?from=2027&to=2027")).text();
  assert.match(sa, /STATUS:TENTATIVE/); assert.match(sa, /SUMMARY:Eid al-Fitr \(expected\)/);
  assert.ok(!sa.includes("RRULE"));
  assert.match(await (await get("/calendar/sa.ics?weekends=1")).text(), /RRULE:FREQ=WEEKLY;BYDAY=FR,SA/);
  assert.match(await (await get("/calendar/ae.ics?lang=ar&from=2027")).text(), /\(متوقع\)/);
});

test("market feeds: unknown or disabled market → 404, bad range → 400, the UID prefix follows the site id", async () => {
  const { get } = marketSite();
  for (const p of ["/calendar/zz.ics", "/calendar/us.ics", "/calendar/gb.ics"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p); assert.match(await r.text(), /\/calendar\/sa\.ics/);
  }
  assert.equal((await get("/calendar/sa.ics?from=2030&to=2027")).status, 400);
  assert.equal((await get("/calendar/sa.ics?from=1800")).status, 400);
  assert.equal((await get("/calendar/sa.ics", { method: "POST" })).status, 405);
  // No site.id: derived from the host (en.example.org → en-example-org).
  const t = await (await get("/calendar/uk.ics")).text();
  assert.ok(t.match(/^UID:.*$/gm).every((u) => u.startsWith("UID:en-example-org-uk-")));
  // An explicit list wins over the profiles; feeds: false or features.feeds: false turns them off.
  const only = marketSite({ calendar: { feeds: ["us"] } });
  assert.equal((await only.get("/calendar/us.ics")).status, 200);
  assert.equal((await only.get("/calendar/sa.ics")).status, 404);
  assert.equal((await marketSite({ calendar: { feeds: false } }).get("/calendar/sa.ics")).status, 404);
  const off = marketSite({ features: { feeds: false } });
  assert.equal((await off.get("/calendar/sa.ics")).status, 404);
  assert.deepEqual(off.kit.calendarFeeds(), []);
  // An Iran-style site (legacy calendar shape) serves no market feeds by default; /calendar.ics is unchanged.
  const fa = makeKit("fa");
  assert.deepEqual(fa.kit.calendarFeeds(), []);
  assert.equal((await fa.get("/calendar/ir.ics")).status, 404);
  assert.equal((await fa.get("/calendar.ics")).status, 200);
});

test("contracts: the calendar's OpenAPI document and every MCP tool conform (openapi + kit.mcp-tool.v1), and the kit Worker contract covers the calendar paths", async () => {
  const { readFileSync } = await import("node:fs");
  const { createValidator, formatProblems } = await import("@saasreport/core/schema");
  const read = (u) => JSON.parse(readFileSync(new URL(u, import.meta.url), "utf8"));
  const openapi = read("../../core/schemas/openapi.schema.json"), tool = read("../../core/schemas/mcp-tool.schema.json");
  const v = createValidator([openapi, tool]);
  const { get } = makeKit("fa");
  const spec = await (await get("/api/calendar/openapi.json")).json();
  assert.deepEqual(formatProblems(v.validate(spec, openapi.$id)), []);
  const kitContract = read("../contracts/openapi.json");
  assert.deepEqual(formatProblems(v.validate(kitContract, openapi.$id)), []);
  for (const p of Object.keys(spec.paths)) assert.ok(kitContract.paths[p], `${p} is served but not in packages/cloudflare/contracts/openapi.json`);
  const r = await get("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const tools = (await r.json()).result.tools;
  assert.ok(tools.length > 0);
  for (const t of tools) assert.deepEqual(formatProblems(v.validate(t, tool.$id)), [], t.name);
});
