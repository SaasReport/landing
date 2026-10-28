/**
 * Calendar API on @saasreport/calendar (optional feature): public, read-only, CORS-open.
 *   GET  /api/calendar                 index            GET /api/calendar/openapi.json   OpenAPI 3.1
 *   GET  /api/calendar/{today,day,month,holidays,business-days,add,adjust,settlement}   GET|POST /api/calendar/schedule
 *   POST /mcp                          MCP server (stateless Streamable HTTP, JSON-RPC 2.0), read-only tools
 *   GET  /calendar.ics[?from=&to=]     iCalendar feed of holidays
 * Weekend rules and the holiday table come from config.calendar; `profile=bank|government|market` selects an engine profile.
 */
import { calendarOptions } from "../config.js";
import { marketIcs, hasMarketFeed } from "@saasreport/calendar/ics";
import { readJsonBody } from "../body.js";

const PROTOCOL = "2025-06-18";

export function createCalendar(k) {
  const C = k.deps.calendar;
  const { config } = k;
  const base = calendarOptions(config);
  const HEADERS = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type", "cache-control": "public, max-age=300" };
  const meta = () => ({ engine: "calendar", version: C.VERSION, timezone: config.site.timezone, holidays: config.calendar.holidays,
    ...(config.calendar.holidays === "iran" ? { lunar_basis: "islamic-civil (predicted ±1 day unless official)", official_lunar_years: C.officialYears() } : {}) });
  const ok = (data) => new Response(JSON.stringify({ ok: true, data, meta: meta() }), { headers: HEADERS });
  const fail = (status, code, message) => new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { ...HEADERS, "cache-control": "no-store" } });
  const optsFor = (profile) => (profile ? { ...base, profile, weekend: undefined } : base);
  const today = () => k.today();

  const day = (n, o) => {
    const d = C.describe(n, o);
    return { iso: d.iso, jalali: d.jalali.text, jalali_long: d.jalali.long, hijri: d.hijri.long, gregorian: d.gregorian.long, weekday: d.weekday,
      business_day: d.business, weekend: d.weekend, holiday: d.holiday, uncertain: d.uncertain, quarter: d.quarter, day_of_year: d.day_of_year,
      events: o.holidays === false ? [] : d.events.map((e) => ({ title: e.title, holiday: e.holiday, kind: e.kind, status: e.status })) };
  };
  const moved = (r, o) => ({ ...day(r.date, o), moved_days: r.moved, uncertain: r.uncertain });
  const int = (v, name, def) => {
    if (v == null || v === "") { if (def !== undefined) return def; throw new C.CalendarError(`missing_${name}`, `${name} is required`); }
    const n = Number(C.latin(String(v)));
    if (!Number.isInteger(n)) throw new C.CalendarError(`invalid_${name}`, `${name} must be an integer`);
    return n;
  };
  const date = (v) => (v == null || v === "" ? today() : C.parseDate(v));
  const ENDPOINTS = ["today", "day", "month", "holidays", "business-days", "add", "adjust", "settlement", "schedule", "openapi.json"];

  function openapi() {
    const dateP = (name, required = true) => ({ name, in: "query", required, schema: { type: "string" }, description: "Solar Hijri 1405/07/07 or Gregorian 2026-09-29" });
    const profile = { name: "profile", in: "query", schema: { type: "string", enum: Object.keys(C.PROFILES) }, description: "Weekend profile (default: the site's weekend rules)" };
    const convention = { name: "convention", in: "query", schema: { type: "string", enum: Object.keys(C.CONVENTIONS), default: "following" } };
    const intP = (name, required, extra = {}) => ({ name, in: "query", required, schema: { type: "integer", ...extra } });
    const op = (summary, parameters) => ({ get: { summary, parameters: [...parameters, profile], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } } }, 422: { description: "Invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } });
    return {
      openapi: "3.1.0",
      info: { title: `${config.site.name} — Calendar API`, version: C.VERSION, description: "Public, read-only calendar: Solar Hijri / Gregorian / lunar Hijri dates, holidays, business days, settlement (T+n), deadlines and instalment schedules. Results that depend on a predicted holiday carry `uncertain: true`. Also available as an MCP server at /mcp." },
      servers: [{ url: config.site.url }],
      paths: {
        "/api/calendar/today": op("Today", []),
        "/api/calendar/day": op("Describe a day", [dateP("date")]),
        "/api/calendar/month": op("All days of a Solar Hijri month", [intP("year", false), intP("month", false, { minimum: 1, maximum: 12 })]),
        "/api/calendar/holidays": op("Holidays of a Solar Hijri year", [intP("year", false)]),
        "/api/calendar/business-days": op("Business days in (from, to]", [dateP("from"), dateP("to")]),
        "/api/calendar/add": op("Deadline in business or calendar days", [dateP("date"), intP("days", true), { name: "type", in: "query", schema: { type: "string", enum: ["business", "calendar"], default: "business" } }]),
        "/api/calendar/adjust": op("Move a date to a business day", [dateP("date"), convention]),
        "/api/calendar/settlement": op("Settlement date T+n", [dateP("date"), intP("t", false, { minimum: 0, maximum: 30, default: 1 })]),
        "/api/calendar/schedule": op("Monthly instalment schedule", [dateP("start"), intP("count", false, { minimum: 1, maximum: 360, default: 12 }), intP("amount", false, { minimum: 0 }), convention]),
        "/calendar.ics": { get: { summary: "iCalendar feed of holidays", parameters: [intP("from", false), intP("to", false)], responses: { 200: { description: "text/calendar", content: { "text/calendar": { schema: { type: "string" } } } } } } },
      },
      components: { schemas: {
        Envelope: { type: "object", required: ["ok", "data"], properties: { ok: { const: true }, data: { type: "object" }, meta: { type: "object" } } },
        Error: { type: "object", properties: { ok: { const: false }, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
      } },
    };
  }

  async function api(request, url) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    const q = Object.fromEntries(url.searchParams);
    if (request.method === "POST") {
      const { value, response: refused, invalid } = await readJsonBody(request);
      if (refused) return refused;
      if (invalid || value === null) return fail(400, "invalid_json", "request body is not valid JSON");
      Object.assign(q, value);
    }
    else if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "method_not_allowed", "use GET or POST");
    if (q.profile && !C.PROFILES[q.profile]) return fail(422, "invalid_profile", `profile must be one of ${Object.keys(C.PROFILES).join(", ")}`);
    const o = optsFor(q.profile);
    const route = url.pathname.replace(/^\/api\/calendar\/?/, "");
    try {
      switch (route) {
        case "": return ok({ endpoints: ENDPOINTS.map((e) => `/api/calendar/${e}`).concat("/calendar.ics", "/mcp"), profiles: Object.keys(C.PROFILES), conventions: C.CONVENTIONS });
        case "openapi.json": return new Response(JSON.stringify(openapi()), { headers: HEADERS });
        case "today": return ok(day(today(), o));
        case "day": return ok(day(date(q.date), o));
        case "month": {
          const tj = C.toJalali(today()), m = C.month(int(q.year, "year", tj.jy), int(q.month, "month", tj.jm), o);
          return ok({ title: m.title, length: m.length, days: m.cells.filter((c) => c.inMonth).map((c) => day(c.date, o)) });
        }
        case "holidays": {
          const y = int(q.year, "year", C.toJalali(today()).jy);
          return ok({ year: y, holidays: o.holidays === false ? [] : C.holidays(y).map((h) => ({ ...day(h.date, o), title: h.title, kind: h.kind, status: h.status, events: undefined })) });
        }
        case "business-days": {
          const a = C.parseDate(q.from), b = C.parseDate(q.to);
          if (Math.abs(b - a) > 3660) throw new C.CalendarError("range_too_long", "range is limited to 10 years");
          return ok({ from: day(a, o), to: day(b, o), ...C.businessDaysBetween(a, b, o) });
        }
        case "add": { const n = date(q.date), kk = int(q.days, "days"); return ok({ from: day(n, o), result: moved(C.deadline(n, kk, q.type === "calendar" ? "calendar" : "business", o), o) }); }
        case "adjust": { const n = date(q.date); return ok({ from: day(n, o), convention: q.convention || "following", result: moved(C.adjust(n, q.convention || "following", o), o) }); }
        case "settlement": {
          const n = date(q.date), tt = int(q.t, "t", 1);
          if (tt < 0 || tt > 30) throw new C.CalendarError("invalid_t", "t must be between 0 and 30");
          return ok({ trade: day(n, o), t: tt, settlement: moved(C.settlement(n, tt, o), o) });
        }
        case "schedule": {
          const rows = C.schedule({ start: q.start, count: int(q.count, "count", 12), amount: int(q.amount, "amount", 0), day: q.day ? int(q.day, "day") : undefined, interval: int(q.interval, "interval", 1), convention: q.convention || "following", ...o });
          return ok({ convention: q.convention || "following", instalments: rows.map((r) => ({ n: r.n, scheduled: C.toISO(r.scheduled), due: day(r.due, o), moved_days: r.moved, uncertain: r.uncertain, amount: r.amount })) });
        }
        default: return fail(404, "not_found", "no such calendar endpoint");
      }
    } catch (e) {
      if (e instanceof C.CalendarError) return fail(422, e.code, e.message);
      throw e;
    }
  }

  function ics(url) {
    const ty = C.toJalali(today()).jy;
    const from = Math.max(C.RANGE.min, Number(url.searchParams.get("from")) || ty);
    const to = Math.min(C.RANGE.max, Number(url.searchParams.get("to")) || ty + 1, from + 5);
    const body = C.ics({ from, to, name: `${config.site.name}`, domain: config.site.host, uidPrefix: `${config.site.id}-` });
    return new Response(body, { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `inline; filename="${config.site.id}-calendar.ics"`, "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
  }

  /* ---------------------------------------------------------------- MCP */
  const DATE = { type: "string", description: "Solar Hijri 1405/07/07 or Gregorian 2026-09-29. Omit for today." };
  const PROFILE = { type: "string", enum: Object.keys(C.PROFILES), description: "Weekend profile (default: the site's weekend rules)." };
  const CONV = { type: "string", enum: Object.keys(C.CONVENTIONS), description: "Business-day convention. Default following." };
  const TOOLS = [
    { name: "calendar_day", title: "Describe a day", description: "Solar Hijri, Gregorian and lunar Hijri dates of a day, its holidays, and whether it is a business day.",
      inputSchema: { type: "object", properties: { date: DATE, profile: PROFILE } }, run: (a, o) => day(date(a.date), o) },
    { name: "calendar_business_days", title: "Business days between two dates", description: "Count business days in (from, to].",
      inputSchema: { type: "object", properties: { from: DATE, to: DATE, profile: PROFILE }, required: ["from", "to"] }, run: (a, o) => C.businessDaysBetween(C.parseDate(a.from), C.parseDate(a.to), o) },
    { name: "calendar_settlement", title: "Settlement date", description: "Settlement date T+n: n business days after the trade date.",
      inputSchema: { type: "object", properties: { date: DATE, t: { type: "integer", minimum: 0, maximum: 30, default: 1 }, profile: PROFILE } },
      run: (a, o) => moved(C.settlement(date(a.date), a.t ?? 1, o), o) },
    { name: "calendar_add", title: "Deadline", description: "Add business days (default) or calendar days (then rolled to the next business day).",
      inputSchema: { type: "object", properties: { date: DATE, days: { type: "integer" }, type: { type: "string", enum: ["business", "calendar"] }, profile: PROFILE }, required: ["days"] },
      run: (a, o) => moved(C.deadline(date(a.date), a.days, a.type || "business", o), o) },
    { name: "calendar_adjust", title: "Adjust to a business day", description: "Move a date to a business day with a convention.",
      inputSchema: { type: "object", properties: { date: DATE, convention: CONV, profile: PROFILE } }, run: (a, o) => moved(C.adjust(date(a.date), a.convention || "following", o), o) },
    { name: "calendar_schedule", title: "Instalment schedule", description: "Monthly instalment schedule, each due date moved to a business day.",
      inputSchema: { type: "object", properties: { start: DATE, count: { type: "integer", minimum: 1, maximum: 360 }, amount: { type: "integer", minimum: 0 }, convention: CONV, profile: PROFILE }, required: ["start", "count"] },
      run: (a, o) => C.schedule({ start: a.start, count: a.count, amount: a.amount || 0, convention: a.convention || "following", ...o }).map((r) => ({ n: r.n, scheduled: C.toISO(r.scheduled), due: day(r.due, o), moved_days: r.moved, uncertain: r.uncertain, amount: r.amount })) },
    { name: "calendar_holidays", title: "Holidays", description: "Public holidays of a Solar Hijri year (lunar holidays are predicted ±1 day until official).",
      inputSchema: { type: "object", properties: { year: { type: "integer", minimum: C.RANGE.min, maximum: C.RANGE.max } } },
      run: (a, o) => { const y = a.year || C.toJalali(today()).jy; return { year: y, holidays: o.holidays === false ? [] : C.holidays(y).map((h) => ({ date: C.describe(h.date).jalali.text, iso: C.toISO(h.date), title: h.title, status: h.status })) }; } },
  ];
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id", "access-control-expose-headers": "mcp-protocol-version" };
  const reply = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "mcp-protocol-version": PROTOCOL, ...CORS } });

  function rpc(m) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return { jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    const note = !("id" in m), res = (result) => (note ? null : { jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize": return res({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${config.site.id}-calendar`, title: `${config.site.name} — Calendar`, version: C.VERSION },
        instructions: `Calendar tools. Dates accept Solar Hijri (1405/07/07) or Gregorian (2026-09-29); "today" is ${config.site.timezone} time. Propagate \`uncertain\` to users.` });
      case "notifications/initialized": case "notifications/cancelled": return null;
      case "ping": return res({});
      case "tools/list": return res({ tools: TOOLS.map(({ run, ...x }) => ({ ...x, annotations: { readOnlyHint: true, openWorldHint: false } })) });
      case "tools/call": {
        const tool = TOOLS.find((x) => x.name === m.params?.name);
        if (!tool) return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool: ${m.params?.name}` } };
        const args = m.params?.arguments || {};
        try {
          if (args.profile && !C.PROFILES[args.profile]) throw new C.CalendarError("invalid_profile", "unknown profile");
          const data = tool.run(args, optsFor(args.profile));
          return res({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: Array.isArray(data) ? { items: data } : data, isError: false });
        } catch (e) {
          if (!(e instanceof C.CalendarError)) throw e;
          return res({ content: [{ type: "text", text: `${e.code}: ${e.message}` }], isError: true });
        }
      }
      default: return note ? null : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  async function mcp(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET") return reply({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST (stateless Streamable HTTP)." } }, 405);
    if (request.method !== "POST") return reply(null, 405);
    const { value: msg, response: refused, invalid } = await readJsonBody(request);
    if (refused) return refused;
    if (invalid) return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    const batch = Array.isArray(msg), out = [];
    for (const m of batch ? msg : [msg]) { const r = rpc(m); if (r) out.push(r); }
    return out.length ? reply(batch ? out : out[0]) : reply(null, 202);
  }

  async function handle(request, env, url) {
    const p = url.pathname;
    if (p === "/api/calendar" || p.startsWith("/api/calendar/")) return api(request, url);
    if (p === "/calendar.ics") return config.calendar.holidays === "iran" ? ics(url) : null; // the engine only knows the Iranian holiday table
    if (p === "/mcp") return mcp(request);
    return null;
  }
  return { handle, TOOLS, openapi };
}

/**
 * Market holiday feeds (feature "feeds", on by default): GET|HEAD /calendar/<market>.ics for every market in
 * config.calendar.feeds (default: the site's market profiles), on @saasreport/calendar/ics marketIcs().
 *   ?from=YYYY&to=YYYY   Gregorian years (default: this year and next; at most 6 years, 1900-2100)
 *   ?lang=en|ar|fa       titles and notes (default: the site's language when the engine has it, else en)
 *   ?weekends=1          also weekly all-day weekend events
 * UIDs carry the site's own prefix (`${site.id}-`) and host. Any other market → 404. The body is deterministic for a
 * given range and data version, so it carries a strong ETag and answers If-None-Match with 304.
 */
export function createMarketFeeds(k, { ics = k.deps?.marketIcs || marketIcs } = {}) {
  const { config } = k;
  const feeds = (config.calendar.feeds || []).filter(hasMarketFeed);
  const LANGS = ["en", "ar", "fa"];
  const HEAD = { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400",
    "access-control-allow-origin": "*", "x-content-type-options": "nosniff" };
  const text = (status, body, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });
  const etagFor = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return `"${h.toString(16)}-${s.length.toString(16)}"`; };
  const yearNow = () => Number(new Intl.DateTimeFormat("en-CA", { timeZone: config.site.timezone || "UTC", year: "numeric" }).format(k.now ? k.now() : new Date()));

  /** Feed URLs: [{ market, path, url, webcal }]. */
  const list = () => feeds.map((m) => {
    const path = `/calendar/${m}.ics`;
    return { market: m, path, url: `${config.site.url}${path}`, webcal: `${config.site.url.replace(/^https?:/, "webcal:")}${path}` };
  });

  function handle(request, url) {
    const m = /^\/calendar\/([^/]+)\.ics$/.exec(url.pathname);
    if (!m) return null;
    const id = decodeURIComponent(m[1]).toLowerCase();
    if (!feeds.includes(id)) return text(404, `No calendar feed for "${id}". Feeds: ${feeds.map((f) => `/calendar/${f}.ics`).join(", ") || "none"}\n`);
    if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Use GET.\n", { allow: "GET, HEAD" });
    const q = url.searchParams, y = yearNow();
    const year = (v, def) => { if (v == null || v === "") return def; const n = Number(v); return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : NaN; };
    const from = year(q.get("from"), y), to = year(q.get("to"), Math.max(from, y + 1));
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from || to - from > 5) return text(400, "from and to must be Gregorian years (1900-2100), from <= to, at most 6 years.\n");
    const lang = LANGS.includes(q.get("lang")) ? q.get("lang") : LANGS.includes(config.site.lang) ? config.site.lang : "en";
    const weekends = q.get("weekends") === "1" || q.get("weekends") === "true";
    const body = ics(id, { from, to, locale: lang, weekends, uidPrefix: `${config.site.id}-`, domain: config.site.host, url: `${config.site.url}/calendar/${id}.ics` });
    const etag = etagFor(body);
    const headers = { ...HEAD, etag, "content-disposition": `inline; filename="${config.site.id}-${id}.ics"` };
    if ((request.headers.get("if-none-match") || "").split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : body, { headers });
  }
  return { handle, list, feeds };
}
