import { migrationOrder } from "@saasreport/core/migration-order";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  buildSpecs, specFiles, checkConfig, todos, copyrightYears, engineRuntime, wranglerToml, mailSenderOptions,
  renderPreviews, compileTemplate, colorsFromTokens, templateId, fieldsHtml, resolveConfig,
} from "../src/index.js";
import { createCommsEngine } from "../workers/comms-engine/engine.js";

/** An empty D1 for the engine: no suppression rows, no prior dispatch, every write accepted. */
const emptyDb = () => ({ prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ success: true }), all: async () => ({ results: [] }) }) }) });
import { createMailSender } from "../workers/mail-sender/sender.js";
import sample from "../examples/saasreport/comms.config.js";
import sampleAr from "../examples/saasreport-ar/comms.config.js";

/** A right-to-left Persian variant of the sample, built in the test: the locale packs (digits, Solar Hijri years, shells) are the kit's;
 *  the copy is the sample's English text under the `fa` key, because these tests prove the shell and the numerals, not the wording. */
const persian = (config) => {
  const loc = (v) => (v && typeof v === "object" && "en" in v ? { fa: v.en } : v);
  return {
    ...config, locales: ["fa-IR"], timeZone: "Asia/Tehran",
    brand: { ...config.brand, name: loc(config.brand.name), fonts: { fa: config.brand.fonts.en } },
    sender: { ...config.sender, name: loc(config.sender.name) },
    signature: loc(config.signature),
    preview: loc(config.preview),
    templates: config.templates.map((x) => ({ ...x, copy: { fa: x.copy.en } })),
  };
};
const fa = persian(sample);

/** The spec files for the dispatch-mechanics tests below: the manifest without its forms, so a form's template can be dispatched directly to
 *  exercise compile, suppression, idempotency and recording. The forms gate itself (their templates only through submit) is proven in
 *  forms.test.mjs. */
const mechanicsSpecs = (config) => {
  const s = Object.fromEntries(Object.entries(buildSpecs(config)).map(([f, v]) => [f.replace(".json", ""), v]));
  const { forms, owner, ...manifest } = s.manifest;
  return { ...s, manifest };
};
for (const [name, config] of Object.entries({ fa, sampleAr, sample })) {
  test(`${name}: every template compiles with header, body, signature and legal footer in its direction`, () => {
    const previews = renderPreviews(config, { now: new Date("2026-09-30T12:00:00Z") });
    const specs = buildSpecs(config);
    assert.equal(previews.length, specs["manifest.json"].templates.length);
    for (const p of previews) {
      const lang = p.locale.split("-")[0];
      assert.match(p.html, new RegExp(`<html dir="${p.dir}" lang="${lang}">`), p.template_id);
      assert.equal(p.dir, lang === "en" ? "ltr" : "rtl");
      assert.match(p.html, /border-radius:14px 14px 0 0/, "header");
      assert.match(p.html, /border-radius:0 0 18px 18px/, "legal");
      assert.match(p.html, /©/);
      assert.ok(!/\$\{[a-z_]+\}/.test(p.html + p.text + p.subject), `${p.template_id}: unfilled param`);
      if (!p.template_id.includes(".ops.")) assert.match(p.html, /border-top:1px solid/, "signature");
    }
  });
}

test("locales: English and Arabic legal wording, years, unsubscribe and privacy lines", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const pv = Object.fromEntries(renderPreviews(sampleAr, { now }).map((p) => [p.template_id, p]));
  const en = pv["saasreport.newsletter.ack.v1"];
  assert.match(en.text, /© 2026 SaasReport\. All rights reserved\. SaasReport and its logo are trademarks of SaasReport\./, "a TODO entity is not set: the brand is the holder");
  assert.doesNotMatch(en.text + en.html, /TODO/, "no TODO value reaches an email");
  assert.ok(todos(sampleAr).some(([p]) => p.startsWith("legal.entity.name")), "the owner still sees it in todos()");
  assert.match(en.text, /confidential and intended only for the named recipient/);
  assert.match(en.text, /Privacy notice: https:\/\/saasreport\.ai\/privacy/);
  assert.match(en.text, /Unsubscribe: https:\/\/saasreport\.ai\/unsubscribe/);
  assert.match(en.text, /Replies reach info@saasreport\.ai/);
  const ar = pv["saasreport.newsletter.ack.ar.v1"];
  assert.match(ar.text, /© ٢٠٢٦ م \/ ١٤٤٨ هـ/);
  assert.match(ar.text, /جميع الحقوق محفوظة/);
  assert.match(ar.text, /لإلغاء الاشتراك: https:\/\/saasreport\.ai\/unsubscribe/);
  assert.match(ar.html, /١<\/div>/, "Arabic-Indic step numbers");
  assert.ok(!pv["saasreport.contact.ack.v1"].text.includes("Unsubscribe"), "unsubscribe only on subscription templates");
  const ag = renderPreviews(sample, { now })[0];
  assert.match(ag.html, /<html dir="ltr" lang="en">/);
  assert.match(ag.html, /text-align:left/);
  assert.match(ag.html, /padding:2px 0 12px 10px/, "LTR steps");
});

test("ids: primary locale unsuffixed, others .<lang>; ops in the primary locale", () => {
  const ids = buildSpecs(sampleAr)["manifest.json"].templates.map((t) => t.template_id);
  assert.ok(ids.includes("saasreport.demo-request.ack.v1") && ids.includes("saasreport.demo-request.ack.ar.v1") && ids.includes("saasreport.ops.lead-alert.v1"));
  assert.equal(templateId(sampleAr, "contact", "ar"), "saasreport.contact.ack.ar.v1");
  assert.equal(templateId(fa, "contact"), "saasreport.contact.ack.v1");
  const t = buildSpecs(sampleAr)["manifest.json"].templates.find((x) => x.template_id === "saasreport.newsletter.ack.v1");
  assert.deepEqual(t.link_refs, ["link.privacy", "link.unsubscribe"]);
  assert.equal(t.reply_to_block, "reply_to.noreply");
});

test("copyright years: Solar Hijri, Gregorian and Hijri with the right numerals", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  assert.deepEqual(copyrightYears(engineRuntime(fa).years, "Asia/Tehran", now), { year_fa: "۱۴۰۵", year_en: "۲۰۲۶" });
  assert.deepEqual(copyrightYears(engineRuntime(sampleAr).years, "UTC", now), { year: "2026", year_ar: "٢٠٢٦", year_hijri: "١٤٤٨" });
  // Nowruz: 20 March 2026 23:00 UTC is already 1405 in Tehran.
  assert.equal(copyrightYears({ y: { calendar: "persian" } }, "Asia/Tehran", new Date("2026-03-20T23:00:00Z")).y, "1405");
});

test("config checks and TODO listing", () => {
  assert.deepEqual(checkConfig(fa), []);
  const bad = checkConfig({ project: "X", locales: ["xx"], brand: {}, sender: { address: "nope" }, templates: [{ key: "a", copy: {} }] });
  for (const f of ["project", "idPrefix", "site", "locales", "sender.address", "manifest.adopted", "templates[0] (a).copy.xx"]) {
    assert.ok(bad.some((p) => p.startsWith(f)), f);
  }
  assert.throws(() => buildSpecs({ ...fa, sender: { address: "x" } }), /sender\.address/);
  assert.deepEqual(todos(sample).map(([p]) => p), ["legal.entity.name", "legal.entity.registration", "legal.entity.address", "workers.engine.d1.database_id"]);
});

test("colours from site tokens", () => {
  const c = colorsFromTokens({ color: { accent: "#FF5A00", ink: "#0B0B0B", bg: "#FAFAF7", surface: "#FFFFFF", accentTint: "#FFF1E8" } });
  assert.deepEqual(c, { ink: "#0B0B0B", accent: "#FF5A00", background: "#FAFAF7", card: "#FFFFFF", pill: "#FFF1E8" }, "the roles the site derives (pillBorder, accentText, onAccent) come in with the tokens, never computed here");
});

test("wrangler.toml: per-project worker names, sender allow-list, D1/KV bindings", () => {
  const e = wranglerToml(sample, "comms-engine");
  assert.match(e, /^name = "saasreport-comms-engine"$/m);
  assert.match(e, /^service = "saasreport-mail-sender"$/m);
  const m = wranglerToml(sample, "mail-sender");
  assert.match(m, /^name = "saasreport-mail-sender"$/m);
  assert.match(m, /^allowed_sender_addresses = \["noreply@saasreport\.ai"\]$/m);
  const kv = wranglerToml({ ...sample, workers: { engine: { kv: [{ binding: "CACHE", id: "abc" }] } } }, "comms-engine");
  assert.match(kv, /\[\[kv_namespaces\]\]\nbinding = "CACHE"\nid = "abc"/);
  assert.deepEqual(mailSenderOptions(fa), { name: "saasreport-mail-sender", logPrefix: "saasreport-mail-sender" });
});

test("engine Worker: dispatch compiles, escapes, sends through MAIL_SENDER and names everything per project", async () => {
  const specs = mechanicsSpecs(sample);
  const engine = createCommsEngine({ config: sample, specs });
  const sent = [];
  const env = { DB: emptyDb(), MAIL_SENDER: { fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return Response.json({ ok: true, message_id: "m1" }); } } };
  const health = await (await engine.fetch(new Request("https://x/healthz"), env)).json();
  assert.deepEqual(health, { ok: true, component: "saasreport-comms-engine", templates: 5 });
  const params = { name: "<i>Sara</i>", reference: "R1", submitted_at: "now", fields_html: fieldsHtml([["Name", "<Sara>"]], { dir: "ltr" }), fields_text: "Name: Sara" };
  const res = await engine.dispatchCore({ template_id: "saasreport.contact.ack.v1", to: ["a@example.com"], params }, env, null);
  assert.equal(res.status, 200, JSON.stringify(res.payload));
  assert.match(res.payload.dispatch_id, /^saasreport:comms:email:/);
  assert.equal(sent[0].url, "https://saasreport-mail-sender/send");
  assert.equal(sent[0].body.from, "noreply@saasreport.ai");
  assert.match(sent[0].body.html, /&lt;i&gt;Sara&lt;\/i&gt;/);
  assert.match(sent[0].body.html, /&lt;Sara&gt;/);
  assert.match(sent[0].body.text, new RegExp(`© ${new Date().getUTCFullYear()} `));
  const miss = await engine.dispatchCore({ template_id: "saasreport.sandbox-key.ack.v1", to: ["a@example.com"], params }, env, null);
  assert.deepEqual([miss.status, miss.payload.error, miss.payload.param], [400, "missing_param", "use_case"]);
  const m = await (await engine.fetch(new Request("https://x/v1/comms/manifest"), env)).json();
  assert.ok(m.templates.find((t) => t.template_id === "saasreport.sandbox-key.ack.v1").required_params.includes("use_case"), "the manifest says which params each template requires");
});

test("engine Worker: onEvent gets a normalised event per dispatch (no addresses) and never breaks a send", async () => {
  const specs = mechanicsSpecs(sample);
  const events = [];
  const engine = createCommsEngine({ config: sample, specs, onEvent: (type, data) => { events.push({ type, data }); if (events.length === 1) throw new Error("hook down"); } });
  const params = { name: "Sara", reference: "R1", submitted_at: "now", fields_html: "", fields_text: "" };
  const ok = { DB: emptyDb(), MAIL_SENDER: { fetch: async () => Response.json({ ok: true, message_id: "m1" }) } };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  assert.equal((await engine.dispatchCore({ template_id: "saasreport.contact.ack.v1", to: ["a@example.com"], params }, ok, ctx)).status, 200, "a throwing hook does not fail the dispatch");
  const down = { DB: emptyDb(), MAIL_SENDER: { fetch: async () => new Response("no", { status: 500 }) } };
  assert.equal((await engine.dispatchCore({ template_id: "saasreport.contact.ack.v1", to: ["a@example.com"], params }, down, ctx)).status, 502);
  await Promise.all(pending);
  assert.deepEqual(events.map((e) => e.type), ["comms.dispatched", "comms.failed"]);
  assert.equal(events[0].data.sent, 1);
  assert.ok(!JSON.stringify(events).includes("a@example.com"), "no recipient address in events");
});

test("mail-sender Worker: sends through the send_email binding", async () => {
  const w = createMailSender(mailSenderOptions(sampleAr));
  const calls = [];
  const env = { MAIL: { send: async (m) => { calls.push(m); return { messageId: "x1" }; } } };
  assert.deepEqual(await (await w.fetch(new Request("https://x/healthz"), env)).json(), { ok: true, component: "saasreport-mail-sender" });
  const r = await w.fetch(new Request("https://x/send", { method: "POST", body: JSON.stringify({ from: "noreply@saasreport.ai", fromName: "SaasReport", to: "a@b.co", subject: "s", text: "t", replyTo: "info@saasreport.ai" }) }), env);
  assert.deepEqual(await r.json(), { ok: true, message_id: "x1", provider: "cf-email" });
  assert.deepEqual(calls[0].from, { email: "noreply@saasreport.ai", name: "SaasReport" });
  assert.equal(calls[0].replyTo, "info@saasreport.ai");
  assert.equal((await w.fetch(new Request("https://x/send", { method: "POST", body: "{}" }), {})).status, 400);
});

test("phone width: the header, domain and footer rows carry classes the shell narrows below 620px; nothing else is fixed-width", () => {
  for (const config of [fa, sampleAr, sample]) {
    const p = renderPreviews(config, { now: new Date("2026-09-30T12:00:00Z") })[0];
    const x = config.cssPrefix || config.idPrefix;
    assert.match(p.html, new RegExp(`@media \\(max-width:620px\\)\\{[^\\n]*\\.${x}-head\\{padding:24px 18px 0 !important\\}\\.${x}-foot\\{padding-left:18px !important;padding-right:18px !important\\}\\.${x}-domain\\{display:none !important\\}`));
    assert.match(p.html, new RegExp(`<td class="${x}-head" dir=`));
    assert.match(p.html, new RegExp(`<td class="${x}-domain" style=`), "the domain cell (logo + domain set the minimum width) hides on phones");
    assert.ok((p.html.match(new RegExp(`class="${x}-foot"`, "g")) || []).length >= 1, "the legal footer narrows its padding");
    assert.doesNotMatch(p.html, /width="(?!600")(?:[4-9]\d\d|\d{4,})"|(?<!max-)width:\s*(?!600px)[4-9]\d\dpx/, "no fixed width over the phone width besides the 600px max-width table");
  }
});

test("stepsHtml: pills and arrows in the brand's colours, arrow along the reading direction, escaped", async () => {
  const { stepsHtml } = await import("../src/index.js");
  const colors = { pill: "#E7F5EC", pillBorder: "#C0DBCC", accent: "#167A42", ink: "#0B0B0B" };
  const ltr = stepsHtml(["a<b", "c"], { colors, font: "'X',Arial" });
  assert.match(ltr, /^<p dir="ltr" style="margin:0 0 18px;font-size:14px;line-height:2.2;color:#0B0B0B;font-family:'X',Arial">/);
  assert.ok(ltr.includes("background:#E7F5EC;border:1px solid #C0DBCC") && ltr.includes("a&lt;b") && ltr.includes('color:#167A42">&rarr;'));
  assert.ok(stepsHtml(["a", "b"], { dir: "rtl", lineHeight: 2.4 }).includes("&larr;"));
});

test("email text roles are the site's (handed in with the tokens); a missing one comes from the same core functions, and every pair is held to AA", async () => {
  const { emailRoles, emailContrast, emailContrastProblems } = await import("../src/index.js");
  const { fillOn, ensureContrast } = await import("@saasreport/core/colour");
  const base = { ink: "#0B0B0B", accent: "#FF5A00", muted: "#6B6B6B", background: "#FAFAF7", card: "#FFFFFF", pill: "#FFF1E8", onInk: "#FFFFFF" };
  const bare = emailRoles(base);
  assert.equal(bare.onAccent, fillOn(base, base.accent), "the text on the accent is core's fillOn: ink on a bright orange, never white");
  assert.equal(bare.accentText, ensureContrast(base.accent, [base.background, base.card, base.pill], 4.5, base.ink), "the accent's text is core's ensureContrast on the page, the card and the pill");
  assert.deepEqual(emailContrastProblems({ ...base, ...bare }), [], "a bright accent still passes the config check with no role handed in");
  const handed = { ...base, accentText: "#B64203", onAccent: "#0B0B0B" };
  assert.deepEqual(emailRoles(handed), { onAccent: "#0B0B0B", accentText: "#B64203" });
  assert.ok(emailContrast(handed.accentText, base.background) >= 4.5 && emailContrast(handed.accentText, base.card) >= 4.5);
  assert.deepEqual(emailContrastProblems({ ...handed, ...emailRoles(handed) }), []);
  const { readFileSync, readdirSync } = await import("node:fs");
  for (const f of readdirSync(new URL("../src/", import.meta.url)).filter((x) => x.endsWith(".js"))) assert.ok(!/#fff(fff)?\b/i.test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/DEFAULT_COLORS[\s\S]*?\n};/, "")), `${f}: no white literal outside the neutral default palette`);
});

test("every text colour an email renders is a gated pair: no raw accent as text, in any template, locale or shell", async () => {
  const { resolveConfig, emailContrastProblems } = await import("../src/index.js");
  for (const [name, config] of Object.entries({ fa, sampleAr, sample })) {
    const r = resolveConfig(config), c = r.colors;
    const gated = new Set(["ink", "muted", "accentText", "onAccent", "onInk"].map((k) => String(c[k]).toLowerCase()));
    assert.deepEqual(emailContrastProblems(c), [], `${name}: the pairs`);
    const html = renderPreviews(config, { now: new Date("2026-09-30T12:00:00Z") }).map((p) => p.html).join("\n") + JSON.stringify(engineRuntime(config).shells);
    const used = new Set([...html.matchAll(/(?<![-\w])color:\s*(#[0-9a-fA-F]{3,6})/g)].map((m) => m[1].toLowerCase()));
    for (const v of used) assert.ok(gated.has(v), `${name}: text colour ${v} is rendered but is not a gated role (${[...gated].join(", ")})`);
    for (const [tag, sh] of Object.entries(engineRuntime(config).shells)) assert.ok(gated.has(String(sh.link).toLowerCase()), `${name} ${tag}: the shell's link colour ${sh.link} is not a gated role`);
  }
});

test("one derivation of accentText and onAccent: the email takes the site's, never computes a second one", async () => {
  const { resolveTokens, derivedColors, colorRoles } = await import("@saasreport/site");
  const { colorsFromTokens, emailRoles } = await import("../src/config.js");
  const t = resolveTokens({ color: { accent: "#FF5A00", accentPress: "#E65100" } });
  const site = derivedColors(t.color);
  const mail = colorsFromTokens({ color: colorRoles(t.color) });
  assert.equal(mail.accentText, site.accentText);
  assert.equal(mail.onAccent, site.onAccent);
  assert.equal(emailRoles({ ...mail, background: t.color.bg, card: t.color.surface }).accentText, site.accentText, "emailRoles keeps what the tokens gave");
});

test("the sample configs' derived colours are the site's derivation (tested against it, not copied by hand)", async () => {
  const { resolveTokens, colorRoles } = await import("@saasreport/site");
  const tokensOf = { sample: { accent: "#1F3A93", accentTint: "#E8ECF8", ink: "#0B0B0B", muted: "#5B5B66", rail: "#B8B8B8", line: "#E4E4EA", bg: "#F8F8FA", surface: "#FFFFFF" },
    sampleAr: { accent: "#0F766E", accentTint: "#F0FDFA", ink: "#0B0B0B", muted: "#5F6368", rail: "#B8B8B8", line: "#E4E7E6", bg: "#F7F9F8", surface: "#FFFFFF" },
    fa: { accent: "#1F3A93", accentTint: "#E8ECF8", ink: "#0B0B0B", muted: "#5B5B66", rail: "#B8B8B8", line: "#E4E4EA", bg: "#F8F8FA", surface: "#FFFFFF" } };
  for (const [name, config] of Object.entries({ fa, sampleAr, sample })) {
    const roles = colorRoles(resolveTokens({ color: tokensOf[name] }).color);
    const c = resolveConfig(config).colors;
    for (const [mail, site] of [["accentText", "accentText"], ["onAccent", "onAccent"], ["pillBorder", "pillBorder"]]) assert.equal(String(c[mail]).toLowerCase(), roles[site].toLowerCase(), `${name}: ${mail} is the site's ${site}`);
  }
});

test("engine and mail-sender Workers read request bodies through the bounded reader: over the cap is 413 before parsing, a lying length is 400, bad JSON keeps its own error", async () => {
  const specs = mechanicsSpecs(sample);
  const engine = createCommsEngine({ config: sample, specs });
  const sender = createMailSender(mailSenderOptions(sample));
  const env = {};
  const post = (url, body, headers = {}) => new Request(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers }, duplex: "half" });
  const cases = [["engine dispatch", (r) => engine.fetch(r, env), "https://x/v1/comms/dispatch", 256 * 1024], ["engine suppress", (r) => engine.fetch(r, env), "https://x/v1/comms/suppress", 256 * 1024], ["mail-sender", (r) => sender.fetch(r, env), "https://x/send", 1024 * 1024]];
  for (const [label, call, url, cap] of cases) {
    const big = JSON.stringify({ pad: "x".repeat(cap + 10) });
    const over = await call(post(url, big));
    assert.equal(over.status, 413, `${label}: over the cap`); assert.equal((await over.json()).error, "too_large");
    let pulled = 0;
    const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(65536)); } });
    const stream = await call(post(url, endless));   // no Content-Length at all: the cap still stops it while streaming
    assert.equal(stream.status, 413, `${label}: endless stream`); assert.ok(pulled <= cap / 65536 + 3, `${label}: pulled ${pulled} chunks`);
    const lying = await call(post(url, new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536)); } }), { "content-length": "20" }));
    assert.equal(lying.status, 400, `${label}: lying length`);
    const bad = await call(post(url, "{nope"));
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /json_parse_failed|invalid_json/);
    const notObject = await call(post(url, "null"));
    assert.equal(notObject.status, 400, `${label}: null body`);
  }
});

test("suppression fails closed: no store or a failed lookup holds the send, a missing row is an answer (wo-0009)", async () => {
  const { isSuppressed } = await import("../workers/comms-engine/suppression.js");
  assert.deepEqual(await isSuppressed(undefined, "h", "operational", []), { suppressed: true, held: true, reason: "no-store" });
  const failing = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1 unavailable"); }, all: async () => { throw new Error("D1 unavailable"); } }) }) };
  const errors = [], log = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try { assert.deepEqual(await isSuppressed(failing, "h", "operational", []), { suppressed: true, held: true, reason: "lookup-failed" }); } finally { console.error = log; }
  assert.match(errors.join("\n"), /lookup failed/);
  const empty = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) };
  assert.deepEqual(await isSuppressed(empty, "h", "operational", []), { suppressed: false });
});

test("the engine refuses a dispatch it cannot check: no D1 or a failed idempotency lookup is a 503 and nothing is sent (wo-0009)", async () => {
  const specs = mechanicsSpecs(sample);
  const engine = createCommsEngine({ config: sample, specs });
  const sent = [];
  const mail = { fetch: async (_u, init) => { sent.push(init); return Response.json({ ok: true, message_id: "m1" }); } };
  const body = { template_id: "saasreport.contact.ack.v1", to: ["a@example.org"], params: { name: "Sara", reference: "R1", submitted_at: "now", fields_html: "", fields_text: "" } };
  const none = await engine.dispatchCore(body, { MAIL_SENDER: mail });
  assert.equal(none.status, 503); assert.equal(none.payload.error, "no_suppression_store");
  const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1 down"); } }) }) };
  const log = console.error; console.error = () => {};
  try { const r = await engine.dispatchCore({ ...body, idempotency_key: "k1" }, { DB: broken, MAIL_SENDER: mail }); assert.equal(r.status, 503); assert.equal(r.payload.error, "idempotency_check_failed"); } finally { console.error = log; }
  assert.equal(sent.length, 0);
});

test("a suppression that cannot be recorded or checked is refused loudly: no 200 for a lost unsubscribe or a failed lookup (review of ccffd31)", async () => {
  const specs = mechanicsSpecs(sample);
  const engine = createCommsEngine({ config: sample, specs });
  const log = console.error; console.error = () => {};
  try {
    const suppress = (env) => engine.fetch(new Request("https://x/v1/comms/suppress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: "a@example.org", reason: "unsubscribe.marketing" }) }), env);
    const none = await suppress({});
    assert.equal(none.status, 503); assert.equal((await none.json()).error, "suppression_not_recorded");
    const failingWrite = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1 down"); }, first: async () => null }) }) };
    const lost = await suppress({ DB: failingWrite });
    assert.equal(lost.status, 503); assert.equal((await lost.json()).error, "suppression_not_recorded");
    const sent = [];
    const mail = { fetch: async (_u, init) => { sent.push(init); return Response.json({ ok: true, message_id: "m1" }); } };
    const failingLookup = { prepare: (sql) => ({ bind: () => ({ first: async () => null, all: async () => { if (/comms_suppression/.test(sql)) throw new Error("D1 down"); return { results: [] }; }, run: async () => ({}) }) }) };
    const r = await engine.dispatchCore({ template_id: "saasreport.contact.ack.v1", to: ["a@example.org"], params: { name: "S", reference: "R", submitted_at: "now", fields_html: "", fields_text: "" } }, { DB: failingLookup, MAIL_SENDER: mail });
    assert.equal(r.status, 503); assert.equal(r.payload.error, "suppression_check_failed");
    assert.equal(sent.length, 0);
  } finally { console.error = log; }
});

test("suppression reads every row of a recipient: an erasure or a bounce is never hidden by a later, narrower unsubscribe (review of 5c80528)", async () => {
  const { isSuppressed } = await import("../workers/comms-engine/suppression.js");
  const rows = [{ reason: "unsubscribe.marketing", scope: "global" }, { reason: "dsar-erasure", scope: "global" }];   // newest first
  const db = { prepare: () => ({ bind: () => ({ first: async () => rows[0], all: async () => ({ results: rows }) }) }) };
  assert.deepEqual(await isSuppressed(db, "h", "operational", []), { suppressed: true, reason: "dsar-erasure" });
  const bounced = [{ reason: "unsubscribe.marketing" }, { reason: "hard-bounce" }];
  const db2 = { prepare: () => ({ bind: () => ({ first: async () => bounced[0], all: async () => ({ results: bounced }) }) }) };
  assert.deepEqual(await isSuppressed(db2, "h", "operational", []), { suppressed: true, reason: "hard-bounce" });
  const failing = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("down"); }, all: async () => { throw new Error("down"); } }) }) };
  const log = console.error; console.error = () => {};
  try { assert.deepEqual(await isSuppressed(failing, "h", "operational", []), { suppressed: true, held: true, reason: "lookup-failed" }); } finally { console.error = log; }
});

test("a dispatch is recorded before it is sent: a record that cannot be written sends nothing, and a reason no rule reads is refused (review of 5c80528)", async () => {
  const specs = mechanicsSpecs(sample);
  const engine = createCommsEngine({ config: sample, specs });
  const sent = [];
  const mail = { fetch: async (_u, init) => { sent.push(init); return Response.json({ ok: true, message_id: "m1" }); } };
  const noWrite = { prepare: (sql) => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => { if (/INSERT INTO comms_dispatch/.test(sql)) throw new Error("D1 down"); return {}; } }) }) };
  const log = console.error; console.error = () => {};
  try {
    const r = await engine.dispatchCore({ template_id: "saasreport.contact.ack.v1", to: ["a@example.org"], idempotency_key: "k9", params: { name: "S", reference: "R", submitted_at: "now", fields_html: "", fields_text: "" } }, { DB: noWrite, MAIL_SENDER: mail });
    assert.equal(r.status, 503); assert.equal(r.payload.error, "dispatch_not_recorded"); assert.equal(sent.length, 0);
    const bad = await engine.fetch(new Request("https://x/v1/comms/suppress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: "a@example.org", reason: "unsubscribe.marketting" }) }), { DB: noWrite });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "unknown_reason");
  } finally { console.error = log; }
});

test("a dispatch reports exactly what happened: in flight is 409, a partial send is not ok, an unknown reason is refused everywhere, one key sends once (review of 3611d06)", async () => {
  const specs = mechanicsSpecs(sample);
  const engine = createCommsEngine({ config: sample, specs });
  const body = { template_id: "saasreport.contact.ack.v1", idempotency_key: "k1", params: { name: "S", reference: "R", submitted_at: "now", fields_html: "", fields_text: "" } };
  const log = console.error; console.error = () => {};
  try {
    // a reserved, unfinished dispatch is in flight: a retry is told so, never told it was sent
    const inFlight = { prepare: (sql) => ({ bind: () => ({ first: async () => (/FROM comms_dispatch/.test(sql) ? { dispatch_id: "d1", send_status: "sending" } : null), all: async () => ({ results: [] }), run: async () => ({}) }) }) };
    const r1 = await engine.dispatchCore({ ...body, to: ["a@example.org"] }, { DB: inFlight, MAIL_SENDER: { fetch: async () => Response.json({ ok: true }) } });
    assert.equal(r1.status, 409); assert.equal(r1.payload.error, "dispatch_in_flight");
    // one recipient of two fails: not ok
    const writes = [];
    const db = { prepare: (sql) => ({ bind: (...a) => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => { writes.push([sql, a]); return {}; } }) }) };
    let n = 0;
    const mail = { fetch: async () => (n++ === 0 ? Response.json({ ok: true, message_id: "m1" }) : new Response("down", { status: 500 })) };
    const r2 = await engine.dispatchCore({ ...body, idempotency_key: "k2", to: ["a@example.org", "b@example.org"] }, { DB: db, MAIL_SENDER: mail });
    assert.equal(r2.status, 207); assert.equal(r2.payload.ok, false); assert.equal(r2.payload.error, "partial_send"); assert.equal(r2.payload.failed, 1);
    assert.ok(writes.some(([sql, a]) => /UPDATE comms_dispatch/.test(sql) && a[0] === "partial"), "the row records the partial send");
  } finally { console.error = log; }
  // reasons: refused by the library and by a template's suppress_when, not only at the endpoint
  const { addSuppression } = await import("../workers/comms-engine/suppression.js");
  await assert.rejects(addSuppression({ prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) }, { recipientHash: "a".repeat(64), reason: "unsubscribe.marketting" }), /unknown suppression reason/);
  const badSpecs = structuredClone(specs);
  const tpl = Object.values(badSpecs).find((s) => Array.isArray(s?.templates))?.templates?.[0];
  if (tpl) { tpl.suppress_when = ["unsubscribe.operatonal"]; assert.throws(() => createCommsEngine({ config: sample, specs: badSpecs }), /unknown suppression reason/); }
  else assert.fail("no template found in specs to test suppress_when");
});

test("the idempotency key is unique in D1: the second insert of a key fails, so one key sends once even when two dispatches race (review of 3611d06)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { withD1Limits } = await import("@saasreport/core/d1-limits");
  const db = withD1Limits(new DatabaseSync(":memory:"));
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort(migrationOrder)) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const ins = db.prepare("INSERT INTO comms_dispatch (dispatch_id, template_id, channel, category, to_hashes_json, requested_at, idempotency_key, send_status) VALUES (?, ?, 'email', 'operational', '[]', '2026-10-07', ?, 'sending')");
  ins.run("d1", "t", "k");
  assert.throws(() => ins.run("d2", "t", "k"), /UNIQUE/);
  ins.run("d3", "t", null); ins.run("d4", "t", null);   // no key: no uniqueness asked
  db.prepare("UPDATE comms_dispatch SET send_status = 'failed' WHERE dispatch_id = 'd1'").run();
  ins.run("d5", "t", "k");   // a failed dispatch does not hold its key: the retry reserves it
});

test("migration 0002 upgrades a database that already holds duplicate live dispatches: one row per key stays live, the others are marked reconciled, none is deleted (Codex review of #122)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { withD1Limits } = await import("@saasreport/core/d1-limits");
  const db = withD1Limits(new DatabaseSync(":memory:"));
  const files = readdirSync(new URL("../migrations/", import.meta.url)).sort(migrationOrder);
  db.exec(readFileSync(new URL(`../migrations/${files[0]}`, import.meta.url), "utf8"));   // 0001: the index was not unique
  const ins = db.prepare("INSERT INTO comms_dispatch (dispatch_id, template_id, channel, category, to_hashes_json, requested_at, idempotency_key, send_status) VALUES (?, 't', 'email', 'operational', '[]', ?, 'k', ?)");
  ins.run("old-sending", "2026-10-01", "sending"); ins.run("sent", "2026-10-02", "sent"); ins.run("partial", "2026-10-03", "partial"); ins.run("failed", "2026-10-04", "failed");
  for (const f of files.slice(1)) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));   // must not abort
  const rows = Object.fromEntries(db.prepare("SELECT dispatch_id, send_status, send_error FROM comms_dispatch").all().map((r) => [r.dispatch_id, r]));
  assert.equal(Object.keys(rows).length, 4, "no row deleted");
  assert.equal(rows.sent.send_status, "sent", "the sent row stays live");
  for (const id of ["old-sending", "partial"]) { assert.equal(rows[id].send_status, "reconciled_duplicate"); assert.match(rows[id].send_error, /migration 0002/); }
  assert.equal(rows.failed.send_status, "failed");
  assert.throws(() => ins.run("new", "2026-10-05", "sending"), /UNIQUE/, "the key is held by the live row");
});

test("a recipient the mail sender accepted counts as sent, whatever its reply body; failures carry no address; nothing is audited as requested before it is reserved (review of 1db9a46)", async () => {
  const specs = mechanicsSpecs(sample);
  const audits = [];
  const engine = createCommsEngine({ config: sample, specs });
  const body = { template_id: "saasreport.contact.ack.v1", idempotency_key: "k3", to: ["a@example.org", "b@example.org"], params: { name: "S", reference: "R", submitted_at: "now", fields_html: "", fields_text: "" } };
  const writes = [];
  const db = { prepare: (sql) => ({ bind: (...a) => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => { writes.push([sql, a]); if (/INSERT INTO comms_audit/.test(sql)) audits.push(a); return {}; } }) }) };
  let n = 0;
  const mail = { fetch: async () => (n++ === 0 ? new Response("accepted", { status: 200 }) : new Response("down", { status: 500 })) };
  const log = console.error; console.error = () => {};
  try {
    const r = await engine.dispatchCore(body, { DB: db, MAIL_SENDER: mail });
    assert.equal(r.status, 207, JSON.stringify(r.payload)); assert.equal(r.payload.error, "partial_send");
    assert.ok(!JSON.stringify(r.payload).includes("@example.org"), "an address left the engine");
    const all = await engine.dispatchCore({ ...body, idempotency_key: "k4" }, { DB: db, MAIL_SENDER: { fetch: async () => new Response("down", { status: 500 }) } });
    assert.equal(all.status, 502); assert.ok(!JSON.stringify(all.payload).includes("@example.org"), "an address left the engine");
    // a dispatch refused before its reservation leaves no "requested" audit row
    audits.length = 0;
    const noRow = { prepare: (sql) => ({ bind: (...a) => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => { if (/INSERT INTO comms_audit/.test(sql)) audits.push(a); if (/INSERT INTO comms_dispatch/.test(sql)) throw new Error("down"); return {}; } }) }) };
    const refused = await engine.dispatchCore({ ...body, idempotency_key: "k5" }, { DB: noRow, MAIL_SENDER: mail });
    assert.equal(refused.status, 503); assert.equal(audits.length, 0, "a requested audit row for a dispatch that never happened");
  } finally { console.error = log; }
});

test("separate Worker names preserve all canonical comms records", () => {
 const c = { ...fa, workers: { ...(fa.workers || {}), namePrefix: "saasreport-edge" } };
 assert.deepEqual(checkConfig(c), []);
 assert.equal(engineRuntime(c).project, fa.project);
 assert.equal(engineRuntime(c).engineName, "saasreport-edge-comms-engine");
 assert.equal(engineRuntime(c).mailSenderName, "saasreport-edge-mail-sender");
 assert.equal(mailSenderOptions(c).name, "saasreport-edge-mail-sender");
 assert.match(wranglerToml(c, "comms-engine"), /name = "saasreport-edge-comms-engine"/);
 assert.match(wranglerToml(c, "comms-engine"), /service = "saasreport-edge-mail-sender"/);
 assert.match(wranglerToml(c, "mail-sender"), /name = "saasreport-edge-mail-sender"/);
 assert.deepEqual(buildSpecs(c), buildSpecs(fa), "No historical project or template rewrite.");
 assert.equal(checkConfig({...c,workers:{namePrefix:"Capitalized!"}}).length,1);
});
