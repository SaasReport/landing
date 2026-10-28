import { test } from "node:test";
import assert from "node:assert/strict";
import {
  postMessage, eventMessage, episodeMessage, formatWhen, fill, toPlain,
  botApiAdapter, emailAdapter, webhookAdapter, resolveChannels, sign,
  announce, announcePending, channelsConfigured, sendAlert, alertConfig,
} from "../src/index.js";
import { fakeD1 } from "./fake-d1.mjs";

const FA = { site: { name: "سایت نمونه", url: "https://example.org/", locale: "fa-IR", timezone: "Asia/Dubai" }, calendar: { system: "jalali" } };
const EN = { site: { name: "Example Site", url: "https://example.org", locale: "en-US", timezone: "UTC" } };

/** fetch stub recording calls; `reply(url, body)` returns the JSON result. */
function fakeFetch(reply = () => ({ ok: true, result: { message_id: 42 } }), status = 200) {
  const calls = [];
  const f = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), init, body });
    const out = reply(String(url), body);
    return new Response(JSON.stringify(out), { status: out?.status || status, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

// ---------- message builders ----------

test("post message: fa defaults, escaping, site hashtag, absolute link", () => {
  const m = postMessage(FA, { slug: "hello-world", title: "A <b> & B", summary: "خلاصه", kind: "article" });
  assert.match(m.text, /^<b>A &lt;b&gt; &amp; B<\/b>\n\nخلاصه\n\n#مقاله #سایت_نمونه$/);
  assert.deepEqual(m.button, { label: "خواندن مطلب", url: "https://example.org/blog/hello-world" });
  assert.equal(m.plain, "A <b> & B\n\nخلاصه\n\n#مقاله #سایت_نمونه");
  assert.equal(m.kind, "post");
  assert.equal(m.subject, "A <b> & B");
});

test("episode message: en defaults, minutes, audio url, no empty lines when summary missing", () => {
  const m = episodeMessage(EN, { slug: "ep-1", title: "Episode 1", duration_ms: 150000, audio: "/podcasts/ep-1.mp3" });
  assert.equal(m.text, "<b>Podcast: Episode 1</b>\n🎧 3 min\n\n#podcast #Example_Site");
  assert.equal(m.button.url, "https://example.org/podcasts/ep-1");
  assert.equal(m.audio, "https://example.org/podcasts/ep-1.mp3");
});

test("episode minutes use the site locale digits", () => {
  const m = episodeMessage(FA, { slug: "e", title: "t", duration_ms: 80000 });
  assert.match(m.text, /🎧 ۱ دقیقه/);
});

test("event message: online vs location, when override, paths and strings from config", () => {
  const cfg = { ...EN, channels: { hashtags: false, paths: { event: "/meetups/{slug}/" } }, strings: { channels: { eventButton: "RSVP", event: "{title} @ {when} ({where})" } } };
  const m = eventMessage(cfg, { slug: "m 1", title: "Meetup", format: "online", starts_at: "2026-10-01T10:00:00Z" }, "Thu 10:00");
  assert.equal(m.text, "Meetup @ Thu 10:00 (Online)");
  assert.deepEqual(m.button, { label: "RSVP", url: "https://example.org/meetups/m%201/" });
  const m2 = eventMessage(EN, { slug: "x", title: "Conf", location: "Hall <A>", starts_at: "2026-10-01T10:00:00Z" });
  assert.match(m2.text, /📍 Hall &lt;A&gt;/);
  assert.match(m2.text, /2026/);
});

test("formatWhen honours timezone and calendar system", () => {
  const en = formatWhen(EN, "2026-09-30T23:30:00Z");
  assert.match(en, /September 30, 2026/);
  const fa = formatWhen(FA, "2026-09-30T23:30:00Z"); // Dubai: Oct 1 03:30 → Jalali 1405/07/09
  assert.match(fa, /مهر/);
  assert.match(fa, /۱۴۰۵/);
});

test("fill and toPlain", () => {
  assert.equal(fill("{a}-{b}-{c}", { a: "<", b: 1 }), "&lt;-1-{c}");
  assert.equal(toPlain("<b>x &amp; y</b>\n\n\n\nz"), "x & y\n\nz");
});

// ---------- adapters ----------

test("bot API adapter: sendMessage with inline button; bale base URL; media → sendPhoto/sendAudio", async () => {
  const f = fakeFetch();
  const tg = botApiAdapter({ token: "T", chatId: "@c", fetch: f });
  const ref = await tg.send({ text: "<b>x</b>", button: { label: "Go", url: "https://e/x" } });
  assert.equal(ref, "42");
  assert.equal(f.calls[0].url, "https://api.telegram.org/botT/sendMessage");
  assert.deepEqual(f.calls[0].body.reply_markup, { inline_keyboard: [[{ text: "Go", url: "https://e/x" }]] });
  assert.equal(f.calls[0].body.parse_mode, "HTML");

  const bale = botApiAdapter({ name: "bale", apiBase: "https://tapi.bale.ai/", token: "B", chatId: "1", media: true, fetch: f });
  await bale.send({ text: "cap", photo: "https://e/p.png" });
  await bale.send({ text: "cap", audio: "https://e/a.mp3", photo: "https://e/p.png" });
  assert.equal(f.calls[1].url, "https://tapi.bale.ai/botB/sendPhoto");
  assert.equal(f.calls[1].body.caption, "cap");
  assert.equal(f.calls[2].url, "https://tapi.bale.ai/botB/sendAudio");
  assert.equal(f.calls[2].body.audio, "https://e/a.mp3");

  const bad = botApiAdapter({ token: "T", chatId: "c", fetch: fakeFetch(() => ({ ok: false, description: "chat not found", status: 400 })) });
  await assert.rejects(bad.send({ text: "x" }), /telegram sendMessage 400: chat not found/);
});

test("email adapter posts {template_id,to,params,idempotency_key} to the service binding", async () => {
  const f = fakeFetch(() => ({ id: "d-1" }));
  const binding = { fetch: f };
  const email = emailAdapter({ binding, to: "a@x.org, b@x.org", templates: { post: "tpl.post.v1" } });
  const ref = await email.send({ kind: "post", subject: "S", title: "T", plain: "P", button: { label: "L", url: "https://u" }, params: { summary: "s" }, idempotencyKey: "posts:a" });
  assert.equal(ref, "d-1");
  assert.equal(f.calls[0].url, "https://comms/v1/comms/dispatch");
  assert.deepEqual(f.calls[0].body, {
    template_id: "tpl.post.v1", to: ["a@x.org", "b@x.org"],
    params: { subject: "S", title: "T", text: "P", url: "https://u", button: "L", summary: "s" }, idempotency_key: "posts:a",
  });
  assert.equal(await email.send({ kind: "event" }), null, "no template → nothing sent");
  assert.equal(f.calls.length, 1);
});

test("webhook adapter signs the body", async () => {
  const f = fakeFetch(() => ({}));
  const w = webhookAdapter({ url: "https://hook", secret: "s3", fetch: f });
  await w.send({ kind: "post", title: "T", text: "x", idempotencyKey: "k" });
  const sig = f.calls[0].init.headers["x-kit-signature"];
  assert.equal(sig, `sha256=${await sign("s3", f.calls[0].init.body)}`);
  assert.equal(f.calls[0].init.headers["idempotency-key"], "k");
});

test("resolveChannels: dormant without secrets; env names and bale base configurable", () => {
  const channels = { telegram: { chatIdEnv: "TG_CHAT" }, bale: { apiBaseEnv: "BALE_BASE" }, email: { serviceBinding: "MAIL", templates: { post: "p" } }, webhook: true };
  assert.deepEqual(resolveChannels({}, channels), []);
  assert.equal(channelsConfigured({}, { channels }), false);
  const env = { TELEGRAM_BOT_TOKEN: "t", TG_CHAT: "@c", BALE_BOT_TOKEN: "b", BALE_CHAT_ID: "1", BALE_BASE: "https://bale.example", MAIL: { fetch() {} }, ANNOUNCE_EMAIL_TO: "a@x", CHANNEL_WEBHOOK_URL: "https://h" };
  assert.deepEqual(resolveChannels(env, channels).map((a) => a.name), ["telegram", "bale", "email", "webhook"]);
  assert.deepEqual(resolveChannels({ ...env, TELEGRAM_CHAT_ID: "@d" }, { telegram: true }).map((a) => a.name), ["telegram"]);
  assert.deepEqual(resolveChannels(env, { email: { serviceBinding: "MAIL" } }), [], "email without templates stays dormant");
});

// ---------- announce ----------

const NOW = Date.parse("2026-09-30T06:00:00Z");
const posts = () => ({
  a: { slug: "a", title: "A", summary: "sa", kind: "article", published_at: "2026-09-30T05:00:00Z", channel_state: "pending", channel_ref: null },
  b: { slug: "b", title: "B", summary: "sb", published_at: "2026-09-29T05:00:00Z", channel_state: "pending", channel_ref: null },
  old: { slug: "old", title: "Old", summary: "", published_at: "2026-08-01T05:00:00Z", channel_state: "pending", channel_ref: null },
  done: { slug: "done", title: "Done", published_at: "2026-09-30T05:00:00Z", channel_state: "sent", channel_ref: "7" },
});
const tgEnv = (DB, f) => ({ DB, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "@c", _fetch: f });
const tgAdapters = (f) => [botApiAdapter({ token: "t", chatId: "@c", fetch: f })];

test("announce is dormant when no channel is configured and touches nothing", async () => {
  const DB = fakeD1({ posts: posts() });
  const r = await announce({ DB }, { ...EN, channels: { telegram: true } }, { table: "posts", rows: Object.values(DB.tables.posts), now: NOW });
  assert.equal(r.configured, false);
  assert.equal(DB.log.length, 0);
  assert.equal(DB.tables.posts.a.channel_state, "pending");
});

test("announce sends each pending row once, skips stale rows, and is idempotent across runs", async () => {
  const DB = fakeD1({ posts: posts() });
  const f = fakeFetch();
  const cfg = { ...EN, channels: { telegram: true } };
  const rows = () => Object.values(DB.tables.posts).map((r) => ({ ...r }));
  const r1 = await announce(tgEnv(DB), cfg, { table: "posts", rows: rows(), now: NOW, adapters: tgAdapters(f) });
  assert.deepEqual({ sent: r1.sent, skipped: r1.skipped, failed: r1.failed }, { sent: 2, skipped: 1, failed: 0 });
  assert.equal(f.calls.length, 2);
  assert.equal(DB.tables.posts.a.channel_state, "sent");
  assert.equal(DB.tables.posts.a.channel_ref, "42");
  assert.equal(DB.tables.posts.old.channel_state, "skipped");
  assert.equal(DB.tables.posts.done.channel_ref, "7");

  // Same (stale) rows again, e.g. a second cron run that read them before the first finished.
  const stale = Object.values(posts());
  const r2 = await announce(tgEnv(DB), cfg, { table: "posts", rows: stale, now: NOW, adapters: tgAdapters(f) });
  assert.equal(r2.sent, 0);
  assert.equal(r2.duplicate, 2);
  assert.equal(f.calls.length, 2, "nothing sent twice");
});

test("announce: overlapping runs claim rows exclusively", async () => {
  const DB = fakeD1({ posts: posts() });
  const f = fakeFetch();
  const cfg = { ...EN, channels: { telegram: true } };
  const rows = Object.values(posts());
  const [x, y] = await Promise.all([
    announce(tgEnv(DB), cfg, { table: "posts", rows, now: NOW, adapters: tgAdapters(f) }),
    announce(tgEnv(DB), cfg, { table: "posts", rows, now: NOW, adapters: tgAdapters(f) }),
  ]);
  assert.equal(x.sent + y.sent, 2);
  assert.equal(f.calls.length, 2);
});

test("announce: maxPerRun defers, total failure marks failed, partial failure still counts as sent", async () => {
  const DB = fakeD1({ posts: posts() });
  const ok = fakeFetch();
  const r = await announce(tgEnv(DB), { ...EN, channels: { telegram: true, maxPerRun: 1 } }, { table: "posts", rows: Object.values(posts()), now: NOW, adapters: tgAdapters(ok) });
  assert.equal(r.sent, 1); assert.equal(r.deferred, 1);
  assert.equal(DB.tables.posts.b.channel_state, "pending");

  const failing = fakeFetch(() => ({ ok: false, description: "boom", status: 500 }));
  const r2 = await announce(tgEnv(DB), { ...EN, channels: { telegram: true } }, { table: "posts", rows: [DB.tables.posts.b], now: NOW, adapters: tgAdapters(failing) });
  assert.equal(r2.failed, 1);
  assert.equal(DB.tables.posts.b.channel_state, "failed");
  assert.match(r2.errors[0].error, /boom/);

  const DB2 = fakeD1({ posts: posts() });
  const both = [botApiAdapter({ token: "t", chatId: "@c", fetch: ok }), botApiAdapter({ name: "bale", token: "b", chatId: "1", fetch: failing })];
  const r3 = await announce({ DB: DB2 }, EN, { table: "posts", rows: [DB2.tables.posts.a], now: NOW, adapters: both });
  assert.equal(r3.sent, 1);
  assert.equal(DB2.tables.posts.a.channel_ref, JSON.stringify({ telegram: "42" }));
  assert.equal(r3.errors[0].channel, "bale");
});

test("announce rejects unsafe table names and unknown kinds", async () => {
  const DB = fakeD1({});
  await assert.rejects(announce({ DB }, EN, { table: "posts; DROP", rows: [], adapters: tgAdapters(fakeFetch()) }), /invalid table/);
  await assert.rejects(announce({ DB }, EN, { table: "things", rows: [], adapters: tgAdapters(fakeFetch()) }), /unknown kind/);
});

test("announce: events use the when() formatter; email adapter gets per-row idempotency key", async () => {
  const DB = fakeD1({ events: { e: { slug: "e", title: "Conf", summary: "s", starts_at: "2026-10-10T10:00:00Z", created_at: "2026-09-30T01:00:00Z", channel_state: "pending" } } });
  const f = fakeFetch(() => ({ id: "m1" }));
  const adapters = [emailAdapter({ binding: { fetch: f }, to: "x@y", templates: { event: "tpl.event" } })];
  const r = await announce({ DB }, EN, { table: "events", rows: [DB.tables.events.e], now: NOW, adapters, when: () => "Oct 10" });
  assert.equal(r.sent, 1);
  assert.equal(f.calls[0].body.idempotency_key, "events:e");
  assert.equal(f.calls[0].body.params.when, "Oct 10");
  assert.equal(DB.tables.events.e.channel_ref, "m1");
});

test("announcePending reads pending rows per enabled feature and announces them", async () => {
  const DB = fakeD1({ posts: Object.fromEntries(Object.entries(posts()).map(([k, v]) => [k, { ...v, status: "published" }])) });
  const f = fakeFetch();
  const orig = globalThis.fetch; globalThis.fetch = f;
  try {
    const r = await announcePending({ DB, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "@c" }, { ...EN, channels: { telegram: true }, features: { events: false, podcasts: false } }, { now: NOW });
    assert.equal(r.sent, 2); assert.equal(r.skipped, 1);
    assert.equal(f.calls.length, 2);
  } finally { globalThis.fetch = orig; }
});

// ---------- alerts ----------

test("alert config never inherits the public chat or announcement recipients", () => {
  const cfg = { channels: { telegram: { chatId: "@public", tokenEnv: "TOK" }, email: { serviceBinding: "MAIL", to: ["list@x"], templates: { post: "p", alert: "ops.alert" } } }, monitor: { alerts: { telegram: true, email: true } } };
  const a = alertConfig(cfg);
  assert.equal(a.telegram.chatId, undefined);
  assert.equal(a.telegram.chatIdEnv, "MONITOR_TELEGRAM_CHAT_ID");
  assert.equal(a.telegram.tokenEnv, "TOK");
  assert.equal(a.email.to, undefined);
  assert.equal(a.email.toEnv, "MONITOR_NOTIFY_TO");
  assert.deepEqual(a.email.templates, { alert: "ops.alert" });
  assert.deepEqual(alertConfig({}, undefined).email?.toEnv, "MONITOR_NOTIFY_TO");
});

test("sendAlert: dormant without destinations; email + telegram when configured", async () => {
  assert.equal((await sendAlert({}, EN, { subject: "x", lines: [] })).configured, false);
  const f = fakeFetch(() => ({ ok: true, id: "e1", result: { message_id: 5 } }));
  const env = { MAIL: { fetch: f }, MONITOR_NOTIFY_TO: "ops@x", TOK: "t", MONITOR_TELEGRAM_CHAT_ID: "-100" };
  const cfg = { ...EN, channels: { telegram: { tokenEnv: "TOK" }, email: { serviceBinding: "MAIL", templates: { alert: "ops.alert" } } }, monitor: { alerts: { email: true, telegram: true } } };
  const r = await sendAlert(env, cfg, { subject: "2 of 6 journeys failed", lines: ["landing: no <h1>"], url: "https://example.org/api/status", reference: "r1" }, { fetch: f });
  assert.deepEqual(r.refs, { telegram: "5", email: "e1" });
  const tg = f.calls.find((c) => c.url.includes("/sendMessage"));
  assert.equal(tg.body.chat_id, "-100");
  assert.match(tg.body.text, /no &lt;h1&gt;/);
  const mail = f.calls.find((c) => c.body?.template_id);
  assert.equal(mail.body.template_id, "ops.alert");
  assert.equal(mail.body.idempotency_key, "alert:r1");
  assert.equal(mail.body.params.lines_text, "landing: no <h1>");
});

test("sendAlert: alerts.email.params fills an existing template's own fields", async () => {
  const f = fakeFetch(() => ({ ok: true, id: "e2" }));
  const env = { MAIL: { fetch: f }, MONITOR_NOTIFY_TO: "ops@x" };
  const cfg = { ...EN, channels: { email: { serviceBinding: "MAIL" } },
    monitor: { alerts: { email: { template: "ops.lead-alert", params: (a) => ({ form_label: "Monitor", fields_text: `${a.subject}\n${a.lines.join("\n")}` }) } } } };
  await sendAlert(env, cfg, { subject: "1 of 6 failed", lines: ["feeds: boom"], reference: "r2" }, { fetch: f });
  const mail = f.calls.find((c) => c.body?.template_id);
  assert.equal(mail.body.template_id, "ops.lead-alert");
  assert.equal(mail.body.params.form_label, "Monitor");
  assert.equal(mail.body.params.fields_text, "1 of 6 failed\nfeeds: boom");
  assert.equal(mail.body.params.lines_text, "feeds: boom");
});
