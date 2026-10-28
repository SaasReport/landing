// The workbench archetype: the grammar and the Persian-folded command line, Solar Hijri arithmetic, seeded series, the
// layout and watchlist models, SourceEnvelope rules, the browser-side BYO checks, the definition guards and the server
// rendering (streaming order, first chunk, accessibility, no inline handlers, no colour literal).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadRuntime, runtimeSource, workbenchProblems, workbenchChunks, renderWorkbenchBody, chromeFor, validator, buildDefinition, SCHEMAS } from "../src/index.js";
import { buildWidgets, checkWidgets } from "../../widgets/src/index.js";
import { toJalali, toGregorian, fromISO } from "../../calendar/src/index.js";

const FIX = fileURLToPath(new URL("./fixture/widgets.spec.json", import.meta.url));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const WB = loadRuntime();
const gen = JSON.parse(read("./fixture/widgets.generated.json"));
const DEF = { fa: gen.exports.workbench.fa, en: gen.exports.workbench.en };
const clone = (v) => JSON.parse(JSON.stringify(v));
// Objects made inside the runtime's vm context have another realm's prototypes: compare their JSON.
const eq = (a, b, m) => assert.deepStrictEqual(clone(a), b, m);
const REG = { schema: "kit.vocabularies.v1", projects: [{ key: "example", terms: ["Example Library"] }, { key: "other", terms: ["Other Co"] }] };

test("the fixture's generated workbench is fresh, valid and passes kit widgets check", async () => {
  const r = await buildWidgets(FIX);
  assert.equal(r.json, read("./fixture/widgets.generated.json"), "test/fixture/widgets.generated.json is stale: run `kit widgets build --spec packages/workbench/test/fixture/widgets.spec.json`");
  eq(workbenchProblems(DEF.fa), []);
  eq(workbenchProblems(DEF.en), []);
  const { problems } = await checkWidgets(FIX, { registry: REG, projects: { projects: [] } });
  eq(problems, []);
});

test("fold: the kit search fold, character for character", () => {
  const shell = read("../../site/assets/shell.js"), line = shell.slice(shell.indexOf("const fold ="), shell.indexOf("\n", shell.indexOf("const fold =")));
  const theirs = vm.runInNewContext(`(${line.replace(/^const fold = /, "").replace(/;$/, "")})`);
  const corpus = ["كتاب ي ۱۲۳ ٤٥٦", "تقويم", "می‌خواهم", "نیم‌فاصله‌ها", "Café ™ Brand®", "مؤسسه ة", "ﻻ ﻑ", "ٱلسلام", "ABC def", "", null, undefined, "کتابَُ"];
  for (const s of corpus) assert.equal(WB.fold(s), theirs(s), JSON.stringify(s));
  assert.equal(WB.fold("كتاب ي ۱۲"), "کتاب ی 12");
});

test("grammar: VERB [target] [name=value]; verbs and aliases in Persian and Latin, folded", () => {
  const C = DEF.fa.commands, run = (l) => WB.parseLine(C, l, chromeFor("fa").cmd);
  assert.equal(run("CAL 1405 7").command.id, "cal");
  eq(run("CAL 1405 7").args, { year: 1405, month: 7, profile: "bank" });
  assert.equal(run("تقویم ۱۴۰۵ ۷").command.id, "cal", "Persian alias and Persian digits");
  eq(run("تقویم ۱۴۰۵ ۷").args, { year: 1405, month: 7, profile: "bank" });
  assert.equal(run("تقويم 1405").command.id, "cal", "Arabic yeh in the alias folds to the Persian one");
  assert.equal(run("دیده‌بان").command.id, "wl", "a ZWNJ alias");
  assert.equal(run("دیده بان").command, null, "a missing ZWNJ is not folded away (it is a different word)");
  assert.equal(run("کتاب امانتی").command.id, "loan", "a two-word alias");
  eq(run("LOAN fees days=30").args, { series: "fees", days: 30 });
  eq(run("loan days=30 series=FEES").args, { series: "fees", days: 30 }, "named arguments in any order; enum values are matched folded");
  eq(run("LOAN").args, { series: "loans", days: 90 }, "defaults");
  assert.equal(run("LOAN fees days=2").errors[0].arg, "days", "below min");
  assert.match(run("LOAN fees days=2").errors[0].message, /days/);
  assert.equal(run("CAL 1405 13").errors[0].arg, "month");
  assert.equal(run("CAL 1405 7 bank extra").errors.at(-1).arg, "", "an extra word is an error, not ignored");
  const bad = run("cla");
  assert.equal(bad.command, null);
  assert.equal(bad.suggestions[0].command.id, "cal", "one typo still finds CAL");
  assert.ok(run("zzzzzz").suggestions.length === 0);
  eq(WB.paneArgs(C.find((c) => c.id === "cal"), { year: 1405 }), { year: 1405 });
});

test("grammar: suggestions rank exact, prefix, word prefix, substring, one typo, subsequence", () => {
  const C = DEF.en.commands;
  assert.equal(WB.suggest(C, "cal")[0].command.id, "cal");
  assert.equal(WB.suggest(C, "cal")[0].score, 100);
  assert.equal(WB.suggest(C, "hol")[0].command.id, "hol");
  assert.equal(WB.suggest(C, "calc")[0].command.id, "calc", "exact beats the CAL prefix");
  assert.equal(WB.suggest(C, "sandb")[0].command.id, "api", "a prefix of an alias");
  assert.ok(WB.suggest(C, "").length >= 5, "an empty line lists commands");
  eq(WB.suggest(DEF.fa.commands, "تقوی").map((s) => s.command.id), ["cal"]);
  assert.ok(WB.suggest(DEF.fa.commands, "ديده").some((s) => s.command.id === "wl"), "Arabic yeh in a query");
});

test("dates: Jalali and ISO forms, Persian digits, invalid days", () => {
  eq(WB.parseDate("1405/07/15"), { iso: "2026-10-07", jalali: "1405/07/15" });
  eq(WB.parseDate("۱۴۰۵-۰۷-۱۵"), { iso: "2026-10-07", jalali: "1405/07/15" });
  eq(WB.parseDate("2026-10-07"), { iso: "2026-10-07", jalali: "1405/07/15" });
  assert.equal(WB.parseDate("1405/12/30"), null, "1405 is not a leap year");
  assert.notEqual(WB.parseDate("1403/12/30"), null, "1403 is");
  assert.equal(WB.parseDate("2026-02-30"), null);
  assert.equal(WB.parseDate("1405/07/32"), null);
  assert.equal(WB.parseDate("hello"), null);
});

test("Solar Hijri by arithmetic equals @saasreport/calendar for every day of 1300-1500, and the Iranian week starts on Saturday", () => {
  let n = 0;
  for (let day = fromISO("1921-03-21"); day <= fromISO("2122-03-21"); day += 1) {
    const g = toGregorian(day), j = toJalali(day), mine = WB.gregorianToJalali(g.gy, g.gm, g.gd), back = WB.jalaliToGregorian(j.jy, j.jm, j.jd);
    if (mine.jy !== j.jy || mine.jm !== j.jm || mine.jd !== j.jd || back.gy !== g.gy || back.gm !== g.gm || back.gd !== g.gd) assert.fail(`day ${day}: ${JSON.stringify([g, j, mine, back])}`);
    n++;
  }
  assert.ok(n > 73000);
  assert.equal(WB.weekdayIndex("2026-10-03"), 0, "3 Oct 2026 is a Saturday");
  assert.equal(WB.weekdayIndex("2026-10-09"), 6, "a Friday");
  eq(WB.localStamp(Date.UTC(2026, 9, 7, 0, 0), 210), { gregorian: "2026-10-07 03:30", jalali: "1405/07/15 03:30" });
  assert.equal(WB.isLeapJalali(1403), true); assert.equal(WB.isLeapJalali(1405), false);
});

test("seeded series: deterministic, bounded, ends on asOf, and different seeds differ", () => {
  const a = DEF.fa.sources[0].adapter, x = WB.seededSeries(a, "2026-10-01"), y = WB.seededSeries(a, "2026-10-01"), z = WB.seededSeries({ ...a, seed: 43 }, "2026-10-01");
  assert.equal(JSON.stringify(x), JSON.stringify(y));
  assert.notDeepEqual(x.series[0].values, z.series[0].values);
  assert.equal(x.dates.at(-1), "2026-10-01"); assert.equal(x.dates.length, 120); assert.equal(x.series[0].values.length, 120);
  assert.ok(x.series.every((s) => s.values.every((v) => Number.isFinite(v) && v > 0)));
  assert.equal(x.series[1].unit, "IRR");
  assert.equal(x.series[0].values[0], 119, "a pinned first value: a change of the generator is a visible, reviewed change");
});

test("calculators: arithmetic only", () => {
  eq(WB.calculate("jalali-to-gregorian", { date: "1405/07/15" }), { gregorian: "2026-10-07", weekday: 4 });
  eq(WB.calculate("gregorian-to-jalali", { date: "2026-10-07" }), { jalali: "1405/07/15", weekday: 4 });
  assert.equal(WB.calculate("jalali-to-gregorian", { date: "2026-10-07" }), null, "a Gregorian date in a Jalali field is refused, never guessed");
  eq(WB.calculate("rial-toman", { amount: "۲٬۵۰۰٬۰۰۰" }), { toman: 250000, rial: 25000000 });
  eq(WB.calculate("nav", { assets: "1000", liabilities: "200", units: "40" }), { net: 800, nav: 20 });
  assert.equal(WB.calculate("nav", { assets: "1", liabilities: "0", units: "0" }), null);
  const y = WB.calculate("yield", { start: "100", end: "103", days: "90" });
  assert.equal(y.period, 3); assert.ok(Math.abs(y.annual - 12.1666) < 0.001);
  assert.equal(WB.calculate("unknown", {}), null);
});

test("sandbox parameters read the engine state by path", () => {
  const st = { accounts: [{ sheba: "IR1" }, { sheba: "IR2" }], consents: [{ id: "a" }, { id: "b" }] };
  eq(WB.fillState({ s: "$state.accounts.1.sheba", c: "$state.consents.-1.id", n: 5, a: ["$state.accounts.0.sheba"], x: "$state.none.0" }, st), { s: "IR2", c: "b", n: 5, a: ["IR1"] });
});

test("layout: open, replace, split, close, cycle, validity and the tab cap", () => {
  const ids = DEF.fa.panes.map((p) => p.id);
  let s = WB.layoutFrom(DEF.fa, "main");
  assert.ok(WB.layoutValid(s, ids)); assert.equal(s.groups.length, 2);
  let r = WB.layoutOpen(s, "holidays", { year: 1405 }); s = r.state;
  assert.equal(s.groups[0].tabs.at(-1).pane, "holidays"); assert.equal(s.groups[0].active, 2);
  r = WB.layoutOpen(s, "holidays", { year: 1405 }); assert.equal(r.state.groups[0].tabs.length, 3, "the same pane with the same arguments only focuses");
  r = WB.layoutOpen(r.state, "holidays", { year: 1404 }); assert.equal(r.state.groups[0].tabs.length, 3, "the same pane with other arguments replaces it, tabs do not pile up"); eq(r.state.groups[0].tabs[2].args, { year: 1404 });
  s = WB.layoutSplit(r.state); assert.equal(s.groups.length, 3); assert.equal(s.focus, 1); assert.equal(s.groups[1].tabs[0].pane, "holidays");
  assert.equal(WB.layoutSplit(WB.layoutFrom({ layouts: [{ id: "x", groups: [[{ pane: "loans" }]] }] }, "x")).groups.length, 1, "a lone tab is not split away");
  const k = s.groups[1].tabs[0].k; s = WB.layoutClose(s, k); assert.equal(s.groups.length, 2, "an emptied column goes away");
  const one = WB.layoutFrom({ layouts: [{ id: "x", groups: [[{ pane: "loans" }]] }] }, "x");
  assert.equal(WB.layoutClose(one, one.groups[0].tabs[0].k), one, "the last tab stays");
  assert.equal(WB.layoutCycle(s, 1).groups[s.focus].active, (s.groups[s.focus].active + 1) % s.groups[s.focus].tabs.length);
  assert.equal(WB.layoutFocus(s, 1).focus, (s.focus + 1) % s.groups.length);
  for (let i = 0; i < 30; i++) s = WB.layoutOpen(s, ids[i % ids.length], { n: i }).state;
  assert.ok(s.groups.reduce((n, g) => n + g.tabs.length, 0) <= WB.MAX_TABS, "tabs are capped");
  assert.ok(WB.layoutValid(s, ids));
  for (const bad of [null, {}, { v: 2 }, { v: 1, focus: 0, groups: [] }, { v: 1, focus: 5, groups: [{ active: 0, tabs: [{ k: "a", pane: "loans", args: {} }] }] }, { v: 1, focus: 0, groups: [{ active: 0, tabs: [{ k: "a", pane: "gone", args: {} }] }] }, "x"]) assert.equal(WB.layoutValid(bad, ids), false, JSON.stringify(bad));
});

test("watchlist: add, duplicate, full, remove, validity", () => {
  let w = { v: 1, items: [] }, r = WB.watchAdd(w, "lib.series:loans", 2);
  assert.equal(r.status, "added"); w = r.watch;
  assert.equal(WB.watchAdd(w, "lib.series:loans", 2).status, "exists");
  w = WB.watchAdd(w, "lib.series:fees", 2).watch; assert.equal(WB.watchAdd(w, "x.y:z", 2).status, "full");
  eq(WB.watchRemove(w, "lib.series:loans").items, [{ ref: "lib.series:fees" }]);
  assert.ok(WB.watchValid(w)); assert.equal(WB.watchValid({ v: 1, items: [{ ref: "nocolon" }] }), false); assert.equal(WB.watchValid({ v: 1, items: [{ ref: "<script>:x" }] }), false);
});

test("SourceEnvelope: every kind has exactly one badge, the envelope validates, sources do not mix silently", () => {
  const badges = { "sandbox-mock": WB.badgeOf({ kind: "sandbox-mock" }), "customer-endpoint": WB.badgeOf({ kind: "customer-endpoint" }), "customer-dataset": WB.badgeOf({ kind: "customer-dataset" }), "public-feed": WB.badgeOf({ kind: "public-feed" }) };
  eq(badges, { "sandbox-mock": "synthetic", "customer-endpoint": "yours", "customer-dataset": "yours", "public-feed": "feed" });
  assert.equal(WB.badgeOf({ kind: "sandbox-mock", origin: "sandbox-api" }), "sandbox"); assert.equal(WB.badgeOf({ kind: "sandbox-mock", origin: "computed" }), "computed");
  assert.equal(WB.BADGE_LATIN.synthetic, "SYNTHETIC"); assert.equal(WB.BADGE_LATIN.yours, "YOURS"); assert.equal(WB.BADGE_LATIN.feed, "PUBLIC FEED");
  const v = validator(), src = DEF.fa.sources[0];
  const env = WB.makeEnvelope(src, { now: Date.UTC(2026, 9, 7, 8, 0), asOf: "2026-10-01T00:00:00.000Z", basis: "seed", seed: 42, data: { dates: [], series: [] }, lang: "fa", tz: "UTC" });
  eq(WB.acceptEnvelope(v, env, src.id), []);
  assert.equal(env.asOfLocal.jalali, "1405/07/09", "a date-only as-of shows no clock"); assert.equal(env.provenance.asOfBasis, "seed");
  assert.match(WB.acceptEnvelope(v, env, "lib.other")[0], /reads lib.other/, "a pane never shows another source's data");
  for (const k of ["asOf", "fetchedAt", "licence", "freshness", "reach", "provenance", "source", "data"]) { const bad = clone(env); delete bad[k]; assert.ok(WB.acceptEnvelope(v, bad, src.id).length, `missing ${k}`); }
  const bad = clone(env); bad.licence.redistribution = "free-for-all"; assert.ok(WB.acceptEnvelope(v, bad, src.id).length);
  const k = clone(env); k.source.kind = "mystery"; assert.ok(WB.acceptEnvelope(v, k, src.id).length);
  const t = clone(env); t.asOf = "yesterday"; assert.ok(WB.acceptEnvelope(v, t, src.id).length);
});

test("BYO: https only, no credentials, no fragment; capped, timed, cookie-less fetch; CSV; schema inference; encrypted keys", async () => {
  for (const [u, why] of [["http://api.example.com/x", "https"], ["https://user:pw@api.example.com/x", "credentials"], ["https://api.example.com/x#k", "fragment"], ["https://localhost/x", "host"], ["ftp://a.example/x", "https"], ["not a url", "url"], ["", "url"]]) assert.equal(WB.checkEndpoint(u), why, u);
  assert.equal(WB.checkEndpoint("https://api.example.com/v1/rows?x=1"), null);
  const calls = [];
  const ok = (body, h = {}) => async (url, init) => { calls.push([url, init]); return new Response(body, { status: 200, headers: h }); };
  let r = await WB.fetchEndpoint("https://api.example.com/rows", { fetchFn: ok('[{"a":1}]', { "content-type": "application/json" }), key: "S3CR3T", keyHeader: "X-Api-Key" });
  eq(r.json, [{ a: 1 }]);
  const [, init] = calls[0];
  assert.equal(init.credentials, "omit", "no cookies"); assert.equal(init.redirect, "error"); assert.equal(init.referrerPolicy, "no-referrer"); assert.equal(init.headers["X-Api-Key"], "S3CR3T"); assert.equal(init.mode, "cors"); assert.equal(init.cache, "no-store");
  await assert.rejects(WB.fetchEndpoint("https://api.example.com/rows", { fetchFn: ok("[]"), key: "k", keyHeader: "Bad Header\r\nX: y" }).then((x) => { assert.equal(calls.at(-1)[1].headers["Bad Header\r\nX: y"], undefined); throw new Error("done"); }), /done/, "an invalid header name is never sent");
  await assert.rejects(WB.fetchEndpoint("http://api.example.com/rows", { fetchFn: ok("[]") }), { code: "https" });
  await assert.rejects(WB.fetchEndpoint("https://api.example.com/rows", { fetchFn: ok("x".repeat(100), { "content-length": "100" }), maxBytes: 50 }), { code: "size" }, "Content-Length over the cap fails before reading");
  await assert.rejects(WB.fetchEndpoint("https://api.example.com/rows", { fetchFn: ok(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("[".padEnd(60, "1"))); c.enqueue(new TextEncoder().encode("]")); c.close(); } })), maxBytes: 50 }), { code: "size" }, "a stream is cut at the cap");
  await assert.rejects(WB.fetchEndpoint("https://api.example.com/rows", { fetchFn: ok("not json") }), { code: "parse" });
  await assert.rejects(WB.fetchEndpoint("https://api.example.com/rows", { fetchFn: async () => new Response("no", { status: 503 }) }), { code: "http", status: 503 });
  await assert.rejects(WB.fetchEndpoint("https://api.example.com/rows", { fetchFn: async () => { throw new TypeError("Failed to fetch"); } }), { code: "network" }, "a CORS refusal looks like a network error to a page");
  await assert.rejects(WB.fetchEndpoint("https://api.example.com/rows", { timeoutMs: 20, fetchFn: (u, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) }), { code: "timeout" });

  const csv = WB.parseCsv('name;qty;note\n"A, B";3;"say ""hi"""\nC;۴;\n');
  eq(csv.columns, ["name", "qty", "note"]); eq(csv.rows, [{ name: "A, B", qty: 3, note: 'say "hi"' }, { name: "C", qty: 4, note: "" }]);
  assert.throws(() => WB.parseCsv("a\n1\n2\n3\n", { maxRows: 2 }), { code: "rows" }); assert.throws(() => WB.parseCsv('a\n"x'), { code: "parse" });
  eq(WB.findRows({ data: { days: [{ a: 1 }] } }), [{ a: 1 }]); eq(WB.findRows({ x: { items: [1] } }, "/x/items"), [1]); assert.equal(WB.findRows({ a: 1 }), null);
  const rows = [{ id: "a", n: 1 }, { id: "b", n: 2.5, extra: true }], v = validator(), sch = WB.inferSchema(rows);
  eq(WB.checkRows(v, rows, sch), []); eq(sch.items.required.sort(), ["id", "n"]); eq(sch.items.properties.n.type, "number");
  const hostile = WB.inferSchema(JSON.parse('[{"__proto__": 1, "constructor": "x", "a": 1}]'));
  assert.deepEqual(Object.keys(hostile.items.properties).sort(), ["__proto__", "a", "constructor"], "hostile keys are data, not prototypes"); assert.equal(({}).polluted, undefined);
  assert.ok(WB.checkRows(v, [{ id: 3, n: "x" }], sch).length, "a row of another shape fails the inferred schema");
  assert.ok(WB.checkRows(v, rows, { type: "array", items: { type: "object", required: ["zzz"] } }).length, "and the user's own schema");

  const sealed = await WB.sealSecret("S3CR3T", "correct horse");
  assert.ok(!sealed.includes("S3CR3T")); assert.equal(await WB.openSecret(sealed, "correct horse"), "S3CR3T");
  await assert.rejects(WB.openSecret(sealed, "wrong"));
  assert.notEqual(await WB.sealSecret("S3CR3T", "correct horse"), sealed, "a fresh salt and IV every time");
});

test("the browser code keeps keys out of localStorage and never builds HTML from data", () => {
  const ui = read("../assets/ui.js"), core = read("../assets/core.js");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(ui + core), "text only through textContent");
  assert.ok(!/\bon[a-z]+="/.test(ui), "no inline handler strings");
  const sets = [...ui.matchAll(/(local|session)Storage\.setItem\(([^)]*)\)/g)].map((m) => m[0]);
  for (const s of sets) if (/localStorage/.test(s)) assert.ok(!/key\./.test(s) && !/secret|passphrase|\.key\b/i.test(s), `localStorage must not receive a key: ${s}`);
  assert.ok(/sessionStorage\.setItem\(`\$\{NS\}\.key\.\$\{entry\.id\}`, await WB\.sealSecret/.test(ui), "a kept key is sealed first");
  assert.ok(!/localStorage[^\n]*keys\.get|keys\.get[^\n]*localStorage/.test(ui));
  const urls = [...ui.matchAll(/store\.set\("localStorage", ([^,]+),/g)].map((m) => m[1]);
  eq([...new Set(urls)].sort(), ['"byo.lastendpoint"', '"layout.v1"', '"watch.v1"', "WB.keptKey(entry.id)"].sort());
});

test("every key the UI asks for exists in the fa and en packs, and the packs have the same keys", () => {
  const ui = read("../assets/ui.js"), flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const fa = new Set(flat(chromeFor("fa"))), en = new Set(flat(chromeFor("en")));
  eq([...fa].filter((k) => !en.has(k)), []); eq([...en].filter((k) => !fa.has(k)), []);
  const used = new Set([...ui.matchAll(/\bt\("([\w.]+)"/g)].map((m) => m[1]));
  for (const m of ui.matchAll(/\bt\(`([\w.]+)\$\{/g)) for (const k of fa) if (k.startsWith(m[1])) used.add(k);
  for (const k of used) assert.ok(fa.has(k) || [...fa].some((x) => x.startsWith(`${k}.`)), `missing chrome key ${k}`);
  for (const k of ["badge.synthetic", "badge.sandbox", "badge.computed", "badge.yours", "badge.feed"]) assert.ok(fa.has(k));
});

test("definition guards: schema and cross-checks fail loudly", () => {
  const bad = (f, re) => { const d = clone(DEF.fa); f(d); const p = workbenchProblems(d); assert.ok(p.some((x) => re.test(x)), `${re}: ${p.join(" | ") || "no problem"}`); };
  bad((d) => { d.commands[2].aliases.push("تقويم"); }, /also a word of/);
  bad((d) => { d.commands[0].opens = "gone"; }, /unknown pane/);
  bad((d) => { d.commands[0].source = "lib.sandbox"; }, /not a source of pane/);
  bad((d) => { d.panes[0].source = "lib.sandbox"; }, /must be a seeded-series source/);
  bad((d) => { d.panes[0].source = "gone"; }, /unknown source/);
  bad((d) => { d.sources[5].enabled = true; d.panes[0].source = "lib.partner"; }, /(must be|ownerDecisionRef|seeded)/);
  bad((d) => { delete d.sources[5].contract; }, /ships its contract/);
  bad((d) => { delete d.sources[5].fixture; }, /ships a fixture/);
  bad((d) => { d.sources[5].fixture = [{ id: 5 }]; }, /fixture does not satisfy/);
  bad((d) => { d.sources[0].kind = "public-feed"; d.sources[0].homepage = "https://example.org"; }, /seeded series is sandbox-mock/);
  bad((d) => { d.sources[0].origin = "sandbox-api"; }, /seeded series is sandbox-mock/);
  bad((d) => { d.sources[1].origin = "generated"; }, /lab engine/);
  bad((d) => { d.sources[2].origin = "generated"; }, /local source/);
  bad((d) => { d.sources[3].kind = "sandbox-mock"; }, /http-json source is a public-feed/);
  bad((d) => { d.sources[0].freshness.status = "live"; }, /freshness.status mock/);
  bad((d) => { d.sources[3].adapter.url = "https://example.org/x"; d.sources[3].licence.redistribution = "unverified"; }, /ownerDecisionRef/);
  bad((d) => { d.panes[1].params.fields = {}; }, /params.fields.date/);
  bad((d) => { d.panes[2].source = "byo"; d.panes[2].kind = "series"; }, /only a table pane/);
  bad((d) => { d.layouts[0].groups[0][0].pane = "gone"; }, /unknown pane/);
  bad((d) => { d.defaultLayout = "gone"; }, /not a layout/);
  bad((d) => { d.commands[0].example = "CAL 1405 7"; }, /does not run this command/);
  bad((d) => { d.commands[0].verb = "lower"; }, /must match/);
  bad((d) => { d.panes[0].id = "calendar"; }, /used twice/);
  bad((d) => { d.byo.maxResponseBytes = 99999999; }, /must be ≤/);
  bad((d) => { d.panes[0].kind = "chart"; }, /enum|one of/);
  bad((d) => { d.sources[0].adapter = { type: "teleport" }; }, /./);
  assert.equal(SCHEMAS.length, 3);
});

test("render: the first chunk has the heading, intro, badge key and command line and no pane; panes are separate chunks; the whole is balanced", () => {
  const S = chromeFor("fa"), c = workbenchChunks(DEF.fa, S);
  assert.match(c.first, /<h1>میزکار کتابخانه<\/h1>/); assert.match(c.first, /data-wb-input/); assert.match(c.first, /role="combobox"/);
  assert.ok(!/data-pane=/.test(c.first), "no pane in the first chunk: crawl-critical content never waits for a pane");
  assert.equal(c.panes.length, DEF.fa.layouts[0].groups.length);
  for (const [i, p] of c.panes.entries()) { assert.equal((p.match(/data-pane="/g) || []).length, 1); assert.match(p, /class="wb-badge"/, `pane chunk ${i} carries its source badge before any script`); assert.match(p, /aria-busy="true"/); }
  const html = c.first + c.panes.join("") + c.last, stack = [], VOID = new Set(["input", "br", "img", "meta", "link", "hr"]);
  for (const m of html.replace(/<script[\s\S]*?<\/script>/g, "").matchAll(/<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/gi)) { const [, close, tag, self] = m; if (VOID.has(tag) || self) continue; if (close) assert.equal(stack.pop(), tag, `unbalanced </${tag}>`); else stack.push(tag); }
  eq(stack, [], "tags balance across the chunks");
  assert.equal(renderWorkbenchBody(DEF.fa, S), html);
  const data = JSON.parse(html.match(/<script type="application\/json" id="wb-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.def.id, "library"); assert.equal(data.schemas.envelope.$id, "urn:kit:schema:source-envelope:v1");
});

test("render: all four badges are named in the key; Persian digits; no inline handler; escaping holds", () => {
  const S = chromeFor("fa"), html = renderWorkbenchBody(DEF.fa, S);
  for (const b of ["SYNTHETIC", "SANDBOX", "COMPUTED", "YOURS", "PUBLIC FEED"]) assert.ok(html.includes(`<b dir="ltr">${b}</b>`), b);
  assert.ok(!/\son[a-z]+=/i.test(html), "CSP: no inline handlers");
  assert.ok(!/style="/.test(html), "no inline style");
  const evil = clone(DEF.fa); evil.title = "</script><img src=x onerror=alert(1)>"; evil.intro = '"><svg onload=alert(1)>';
  const out = renderWorkbenchBody(evil, S);
  assert.ok(!/<img src=x/.test(out) && !/<svg onload/.test(out), "text is escaped");
  assert.equal((out.match(/<\/script>/g) || []).length, 1, "a title cannot close the data block");
  const col = (html.match(/aria-label="ستون ([^"]+)"/) || [])[1]; assert.equal(col, "۱", "the column number is in Persian digits");
  assert.match(renderWorkbenchBody(DEF.en, chromeFor("en")), /Column 1/);
});

test("the theme paints with roles only and the runtime carries no colour literal", () => {
  const css = read("../theme/workbench.css"), js = runtimeSource();
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "no hex in workbench.css"); assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(css), "no rgb()/hsl() in workbench.css");
  assert.ok(!/#[0-9a-fA-F]{6}\b/.test(js) && !/\brgba?\(/.test(js), "no colour literal in the runtime");
  assert.ok(!/@media[^{]*prefers-reduced-motion/.test(css) === false, "reduced motion is handled");
  for (const sel of ["[data-badge=\"synthetic\"]", "[data-badge=\"yours\"]", "[data-badge=\"feed\"]", "[data-badge=\"sandbox\"]", "[data-badge=\"computed\"]"]) assert.ok(css.includes(`.wb-badge${sel}`), sel);
});

test("the runtime source is one closure and its DOM hooks exist in the markup", () => {
  const js = runtimeSource(), html = renderWorkbenchBody(DEF.fa, chromeFor("fa"));
  assert.ok(js.startsWith("/* @saasreport/workbench runtime") && js.includes("globalThis.KitWorkbench"));
  for (const m of read("../assets/ui.js").matchAll(/\$\("\[(data-[\w-]+)\]"/g)) assert.ok(html.includes(m[1]), `markup lacks ${m[1]}`);
  for (const m of read("../assets/ui.js").matchAll(/\$\("\[(data-[\w-]+)\]", dlg\)/g)) assert.ok(html.includes(m[1]), `dialog markup lacks ${m[1]}`);
});

test("buildDefinition rejects a definition that fails the guards", async () => {
  const spec = JSON.parse(read("./fixture/widgets.spec.json")), raw = clone(spec.scenarios[0].workbench);
  raw.commands[0].opens = "gone";
  await assert.rejects(buildDefinition(raw, { text: async (v) => (typeof v === "string" ? v : v.en), asOf: "2026-10-01", locale: { code: "en", dir: "ltr", digits: "latn", intl: "en-GB" } }), /unknown pane/);
});

test("ISO dates in the locale's digits are isolated left to right (RTL text would reverse them), and forms cannot widen a pane", () => {
  const ui = read("../assets/ui.js"), css = read("../theme/workbench.css");
  assert.match(ui, /const dg = \(s\) => WB\.toDigits\(s, L\.digits\)\.replace\(.*0x2066|LRI = String\.fromCharCode\(0x2066\)/s);
  assert.ok(ui.includes("LRI + m + PDI"));
  assert.ok(/\.wb-form\{[^}]*minmax\(0,1fr\)/.test(css), "a grid column that can shrink: a long option never widens the page at 390 px");
});

// ---- findings of 2026-10-08 (SaasReport #52): absence is a declared state, ranges are elapsed days, a kept dataset is the envelope, the key is the identity ----
test("rowsAt: a null at the declared pointer is the empty state, a missing key or a non-array is refused (undefined)", () => {
  eq(WB.rowsAt({ last: null }, "/last"), [], "a monitor that has not run yet: no rows");
  eq(WB.rowsAt({ last: null }, "/last/rows"), [], "null above the pointer is empty too");
  eq(WB.rowsAt({ last: { rows: [{ a: 1 }] } }, "/last/rows"), [{ a: 1 }]);
  assert.equal(WB.rowsAt({ last: {} }, "/last/rows"), undefined, "a missing key is not an empty state");
  assert.equal(WB.rowsAt({ last: "x" }, "/last/rows"), undefined);
});

test("series ranges are elapsed days of the date axis, never sample counts", () => {
  const monthly = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.UTC(2024, i, 28)); return d.toISOString().slice(0, 10); });
  const v = monthly.map((_, i) => i);
  const w = WB.sliceByDays(monthly, v, 90);
  assert.ok(w.dates.length >= 2 && w.dates.length <= 4, `90 days of monthly samples is about 3 points, not 30 (got ${w.dates.length})`);
  assert.ok(Date.parse(`${w.dates[w.dates.length - 1]}T00:00:00Z`) - Date.parse(`${w.dates[0]}T00:00:00Z`) < 90 * 86400000);
  eq(WB.rangesFor(monthly), [90, 365], "30 days holds one monthly sample: not offered");
  const daily = WB.seededSeries({ points: 90, step: "day", series: [{ id: "x", label: "x", unit: "u", decimals: 1, start: 10, drift: 0, vol: 1 }], seed: 1 }, "2026-10-01");
  assert.equal(WB.sliceByDays(daily.dates, daily.series[0].values, 30).dates.length, 30, "daily samples: 30 days is 30 points");
  eq(WB.rangesFor(daily.dates), [30, 90]);
  eq(WB.rangesFor(["2026-10-01"]), []);
});

test("a kept dataset is the canonical envelope: asOf and basis survive the round trip, and an invalid record is dropped", () => {
  const v = validator(), src = { id: "byo.7", name: { fa: "x" }, kind: "customer-dataset", licence: { line: "l", redistribution: "not-applicable" }, freshness: { slaSeconds: 0, status: "stale" }, reach: { fromBrowser: "not-applicable", testedOn: "2026-10-08" }, provenance: { adapter: "browser-file", adapterVersion: "1" } };
  const env = WB.makeEnvelope(src, { now: Date.UTC(2026, 9, 8), asOf: "2026-09-01T10:00:00.000Z", basis: "source", data: { rows: [{ a: 1 }, { a: 2 }], bytes: 9 }, lang: "fa" });
  const entry = { id: "byo.7", envelope: env, schema: WB.inferSchema([{ a: 1 }]) };
  const disk = JSON.parse(JSON.stringify(WB.keptDataset(entry)));          // what localStorage holds
  const back = WB.restoreKept(v, "byo.7", disk);
  assert.ok(back.entry, JSON.stringify(back.problems));
  assert.equal(back.entry.envelope.asOf, "2026-09-01T10:00:00.000Z", "the source timestamp survives: asOf is not now");
  assert.equal(back.entry.envelope.provenance.asOfBasis, "source");
  eq(back.entry.envelope.data.rows, [{ a: 1 }, { a: 2 }]);
  assert.ok(WB.restoreKept(v, "byo.8", disk).problems, "a record under another key is refused: the key is the identity");
  assert.ok(WB.restoreKept(v, "byo.7", { ...disk, envelope: { ...disk.envelope, asOf: "yesterday" } }).problems, "validated as a SourceEnvelope on restore");
  assert.ok(WB.restoreKept(v, "byo.7", { kind: "dataset", name: "old", rows: [{ a: 1 }] }).problems, "the old subset form is not loaded");
  assert.ok(WB.restoreKept(v, "byo.7", disk, { maxRows: 1 }).problems, "over the row cap");
});

test("restore keeps each id from its storage key, so Forget after a gap deletes the right key", () => {
  const v = validator(), mk = (id, a) => { const src = { id, name: { fa: id }, kind: "customer-dataset", licence: { line: "l", redistribution: "not-applicable" }, freshness: { slaSeconds: 0, status: "stale" }, reach: { fromBrowser: "not-applicable", testedOn: "2026-10-08" }, provenance: { adapter: "browser-file", adapterVersion: "1" } }; return { id, envelope: WB.makeEnvelope(src, { now: Date.UTC(2026, 9, 8), asOf: a, basis: "source", data: { rows: [{ n: 1 }], bytes: 1 }, lang: "fa" }), schema: WB.inferSchema([{ n: 1 }]) }; };
  const stored = [mk("byo.1", "2026-01-01T00:00:00.000Z"), mk("byo.3", "2026-03-01T00:00:00.000Z")].map((e) => ({ key: WB.keptKey(e.id), value: JSON.parse(JSON.stringify(WB.keptDataset(e))) }));   // byo.2 was forgotten: a gap
  const r = WB.restoreAll(v, [...stored, { key: "byo.lastendpoint", value: { url: "https://x.example/" } }]);
  eq(r.entries.map((e) => e.id), ["byo.1", "byo.3"], "ids come from the keys, not from a counter");
  assert.equal(r.next, 3, "a new source gets byo.4, never a restored id");
  const forget = r.entries.find((e) => e.envelope.asOf.startsWith("2026-03"));
  assert.equal(WB.keptKey(forget.id), stored[1].key, "Forget removes exactly the key the record came from");
  assert.equal(r.dropped.length, 1, "a key that is not a kept dataset is dropped, never loaded");
});

test("the browser code uses the tested helpers, not its own copy of their logic", () => {
  const ui = read("../assets/ui.js");
  for (const call of ["WB.rowsAt(json, a.rows)", "WB.sliceByDays(", "WB.rangesFor(d.dates)", "WB.keptDataset(entry)", "WB.keptKey(entry.id)", "WB.keptKey(id)", "WB.restoreAll(validator"]) assert.ok(ui.includes(call), `ui.js no longer calls ${call}`);
  assert.ok(!/\.slice\(-cut\)/.test(ui), "a range is elapsed days of the date axis, never a sample count");
  assert.ok(!/byoSource\(v\.name/.test(ui), "a kept dataset is restored as its envelope under its key, never re-ingested under a new id");
});
