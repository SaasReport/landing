/* Test helpers: a D1 shim on node:sqlite with the package migrations applied, an R2 fake, a Workflow fake,
   and two sample sites (fa / RTL / jalali and en / LTR / gregorian). */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";
import * as core from "@saasreport/core";
import * as calendar from "@saasreport/calendar";
import { episodeFromItem, articleEpisode } from "@saasreport/podcast";
import { migrationOrder } from "@saasreport/core/migration-order";
import { buildKit } from "../src/kit.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

/** A Cloudflare D1 binding backed by an in-memory SQLite database (migrations applied). */
export function makeDB({ migrate = true } = {}) {
  const db = withD1Limits(new DatabaseSync(":memory:"));
  if (migrate) for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort(migrationOrder)) db.exec(readFileSync(MIGRATIONS + f, "utf8"));
  const conv = (args) => args.map((v, i) => {
    if (v === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound at position ${i + 1}`);
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  const log = [];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, conv(a)),
    first: async (col) => { log.push(sql); const r = db.prepare(sql).get(...args); const o = r ? { ...r } : null; return col ? o?.[col] ?? null : o; },
    all: async () => { log.push(sql); return { success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    run: async () => { log.push(sql); const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    raw: async () => db.prepare(sql).all(...args).map((r) => Object.values(r)),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), exec: async (sql) => db.exec(sql), sqlite: db, log };
}

/** The MONITOR's own D1 (never the site's DB): @saasreport/monitor's migrations on a fresh in-memory database. */
export function makeMonitorDB() {
  const db = makeDB({ migrate: false });
  const dir = fileURLToPath(new URL("../../monitor/migrations/", import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort(migrationOrder)) db.sqlite.exec(readFileSync(dir + f, "utf8"));
  return db;
}

/**
 * The monitor Worker as the site sees it: a service binding whose GET /status is @saasreport/monitor's statusHandler over the MONITOR's own
 * D1. That D1 lives in the monitor's env only; the site's env never holds it (review H2).
 */
export function makeMonitorService(db = makeMonitorDB()) {
  return { db, fetch: async (url, init) => {
    const { statusHandler } = await import("../../monitor/src/status.js");
    const u = new URL(typeof url === "string" ? url : url.url);
    if (u.pathname !== "/status" || (init?.method && init.method !== "GET")) return new Response("not found", { status: 404 });
    return statusHandler({ MONITOR_DB: db, MONITOR_STALE_AFTER_MIN: "1560" });
  } };
}

/** R2 fake with head / get (ranges) / put / delete. */
export function makeR2(objects = {}) {
  const store = new Map(Object.entries(objects).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v]));
  return {
    store,
    head: async (key) => (store.has(key) ? { key, size: store.get(key).length, httpEtag: `"${key.length}-${store.get(key).length}"` } : null),
    get: async (key, opts = {}) => {
      if (!store.has(key)) return null;
      let bytes = store.get(key);
      if (opts.range) bytes = bytes.slice(opts.range.offset, opts.range.offset + opts.range.length);
      return { body: bytes, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    put: async (key, v) => { store.set(key, v); },
    delete: async (key) => { store.delete(key); },
  };
}

/** Workflow binding fake recording created instances. */
export function makeWF() {
  const created = [];
  return { created, create: async (o) => { created.push(o); return { id: o.id }; }, get: async (id) => ({ status: async () => ({ status: "running", id }) }) };
}

/* ------------------------------------------------------------------ sample sites */
const talk = (lang) => lang === "fa"
  ? [["host", "امروز درباره رابط‌های باز حرف می‌زنیم."], ["expert", "رابط باز یعنی قرارداد روشن و پایدار."], ["host", "چرا مهم است؟"], ["expert", "چون اتصال را ساده می‌کند."]]
  : [["host", "Today we talk about open interfaces."], ["expert", "An open interface is a clear, stable contract."], ["host", "Why does it matter?"], ["expert", "It makes connecting simple."]];

export function sample(lang) {
  const fa = lang === "fa";
  const config = {
    site: fa
      ? { name: "نمونه", url: "https://fa.example.org", locale: "fa-IR", timezone: "Asia/Tehran", description: "سایت نمونه برای آزمون.", logo: "/logo.png", ogImage: "/og.png",
        org: { name: "سازمان نمونه", sameAs: ["https://t.me/example"] } }
      : { name: "Sample", url: "https://en.example.org", locale: "en-US", timezone: "UTC", description: "A sample site for tests.", org: { name: "Sample Org" } },
    brand: { colors: { accent: fa ? "#0a7d5a" : "#b4235a", ink: "#101010" }, fonts: { body: "Inter, sans-serif" } },
    calendar: fa ? { system: "jalali", weekend: "bank" } : { system: "gregorian", weekend: [0, 6] },
    hosts: fa ? { sara: { name: "سارا", role: "میزبان" }, omid: { name: "امید", role: "کارشناس" } } : { ann: { name: "Ann", role: "host" }, bob: { name: "Bob", role: "expert" } },
    tts: { provider: "gemini" },
    series: [
      { id: "weekly", kind: "topic", every: "week", on: fa ? "sat" : "mon", at: "06:00", post: true, podcast: { show: "weekly", maxSeconds: 150 } },
      { id: "monthly", kind: "report", every: "month", on: 1, at: "06:00", post: true },
      { id: "daily", kind: "term", every: "day", at: "06:00", start: "2026-09-30", podcast: { show: "daily", maxSeconds: 80 } },
    ],
    shows: {
      weekly: { title: fa ? "برنامه هفتگی" : "The Weekly", description: fa ? "هر هفته یک موضوع." : "One topic a week." },
      daily: { title: fa ? "یک واژه" : "One Term", description: fa ? "هر روز یک واژه." : "One term a day." },
    },
  };
  const weekDate = fa ? "2026-10-03" : "2026-10-05"; // a Saturday (fa) / a Monday (en)
  const content = {
    weekly: [{ date: weekDate, title: fa ? "رابط‌های باز" : "Open interfaces", summary: fa ? "چرا رابط باز مهم است." : "Why open interfaces matter.",
      tags: [fa ? "رابط" : "api"], article: fa ? "## چرا\nمتن مقاله درباره رابط باز." : "## Why\nThe article about open interfaces.", talk: talk(lang) }],
    monthly: [{ month: fa ? "1405-08" : "2026-11", title: fa ? "ماه اتصال" : "Month of connections", intro: fa ? "مقدمه گزارش ماهانه." : "Intro of the monthly report." }],
    daily: {
      categories: [{ key: "pay", name: fa ? "پرداخت" : "Payments" }, { key: "bank", name: fa ? "بانکداری" : "Banking" }],
      terms: [
        { slug: "iban", term: fa ? "شبا" : "IBAN", en: "IBAN", category: "pay", short: fa ? "شماره حساب بین‌المللی." : "International account number.", definition: fa ? "شبا شناسه یکتای حساب است." : "An IBAN identifies an account.", related: ["ledger"], talk: talk(lang) },
        { slug: "ledger", term: fa ? "دفتر کل" : "Ledger", en: "Ledger", category: "bank", short: fa ? "دفتر ثبت تراکنش‌ها." : "The book of transactions.", definition: fa ? "دفتر کل همه تراکنش‌ها را نگه می‌دارد." : "A ledger keeps every transaction.", related: [], talk: talk(lang) },
        { slug: "card", term: fa ? "کارت" : "Card", en: "Card", category: "pay", short: fa ? "ابزار پرداخت." : "A payment instrument.", definition: fa ? "کارت برای پرداخت است." : "A card is for payments.", related: [], talk: talk(lang) },
      ],
    },
  };
  return { config, content, weekDate };
}

export const DEPS = {
  defineConfig: core.defineConfig, loadContent: core.loadContent, planner: core.planner, buildPost: core.buildPost, calendar, episodeFromItem, articleEpisode,
  ttsConfigured: (config, env) => Boolean(env.GEMINI_API_KEY),
};

/** A request init as it arrives on the wire: a string or byte body carries its Content-Length (the platform adds it; a synthetic Request does not). */
export const wire = (init = {}) => (typeof init.body === "string" || init.body instanceof Uint8Array) && !new Headers(init.headers || {}).has("content-length")
  ? { ...init, headers: { ...Object.fromEntries(new Headers(init.headers || {})), "content-length": String(typeof init.body === "string" ? new TextEncoder().encode(init.body).length : init.body.length) } } : init;

/** A kit for a sample site with a fixed clock, plus an env with every binding faked. */
export function makeKit(lang, { now = "2026-10-03T08:00:00Z", options = {}, deps = {}, env: envExtra = {}, config: patch, content: contentPatch } = {}) {
  const s = sample(lang);
  const config = patch ? patch(structuredClone(s.config)) : s.config;
  if (contentPatch) s.content = contentPatch(structuredClone(s.content));
  const kit = buildKit(config, s.content, { now: () => new Date(now), ...options, deps: { ...DEPS, ...deps } });
  const env = { DB: makeDB(), MONITOR: makeMonitorService(), PODCASTS: makeR2(), PODCAST_WF: makeWF(), GEMINI_API_KEY: "k", ADMIN_TOKEN: "secret-token", IP_SALT: "salt", ...envExtra };
  const get = (path, init = {}) => kit.fetch(new Request(`${config.site.url}${path}`, wire(init)), env, { waitUntil() {} });
  return { kit, env, get, config, content: s.content, weekDate: s.weekDate };
}

/** JSON-LD graph nodes of an HTML page. */
export function jsonLd(html) {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return [];
  const j = JSON.parse(m[1]);
  return j["@graph"] || [j];
}

/** The provenance record of a seeded episode (the t=0 rule: the database refuses a row without one). */
export const PROV = (series, ref, at, origin = "cron") => JSON.stringify({ v: 1, origin, trigger: "scheduled", series, ref, spec_sha256: "a".repeat(64), created_at: at });

/** Seed D1 with one published post, one published episode per show, and events. */
export async function seed(env, { lang = "fa" } = {}) {
  const fa = lang === "fa", now = "2026-10-01T00:00:00.000Z";
  const run = (sql, ...a) => env.DB.prepare(sql).bind(...a).run();
  await run("INSERT INTO posts (slug, series, kind, title, summary, body_md, tags, author, source, status, published_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    "hello-world", null, "article", fa ? "سلام دنیا" : "Hello world", fa ? "خلاصه نوشته" : "Post summary", fa ? "## بخش یک\nمتن\n\n## بخش دو\nمتن دوم" : "## Part one\nText\n\n## Part two\nMore", JSON.stringify(["t1"]), null, "editorial", "published", now, now);
  await run("INSERT INTO posts (slug, series, kind, title, summary, body_md, tags, source, status, published_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "future-post", null, "article", "Future", "Not yet", "x", "[]", "editorial", "published", "2027-01-01T00:00:00.000Z", now);
  const lines = JSON.stringify([{ speaker: fa ? "sara" : "ann", text: fa ? "سلام" : "Hello", start_ms: 0 }, { speaker: fa ? "omid" : "bob", text: fa ? "سلام سارا" : "Hi Ann", start_ms: 1200 }]);
  await run(`INSERT INTO podcast_episodes (slug, series, show, number, kind, title, summary, source_type, source_ref, script_json, status, audio_key, audio_bytes, duration_ms, published_at, created_at, updated_at, provenance_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, "weekly-2026-09-26", "weekly", "weekly", 1, "topic", fa ? "قسمت یک" : "Episode one", fa ? "خلاصه قسمت" : "Episode summary", "topic", "2026-09-26", lines, "published", "podcasts/weekly-2026-09-26.mp3", 10, 65000, now, now, now, PROV("weekly", "2026-09-26", now));
  await run(`INSERT INTO podcast_episodes (slug, series, show, number, kind, title, summary, source_type, source_ref, script_json, status, audio_bytes, duration_ms, published_at, created_at, updated_at, provenance_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, "daily-iban", "daily", "daily", 1, "term", fa ? "واژه شبا" : "Term IBAN", fa ? "شبا در یک دقیقه" : "IBAN in a minute", "term", "iban", lines, "published", 10, 60000, now, now, now, PROV("daily", "iban", now));
  await run(`INSERT INTO events (slug, title, summary, body_md, starts_at, ends_at, format, location, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    "webinar", fa ? "وبینار" : "Webinar", fa ? "خلاصه رویداد" : "Event summary", "## Agenda\n- one", "2026-10-20T13:30:00.000Z", "2026-10-20T15:00:00.000Z", "online", null, "scheduled", now, now);
  await run(`INSERT INTO events (slug, title, summary, starts_at, ends_at, format, location, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "meetup", fa ? "نشست" : "Meetup", "s", "2026-09-01T13:30:00.000Z", "2026-09-01T15:00:00.000Z", "in_person", fa ? "تهران" : "Berlin", "scheduled", now, now);
  env.PODCASTS.store.set("podcasts/weekly-2026-09-26.mp3", new TextEncoder().encode("0123456789"));
}
