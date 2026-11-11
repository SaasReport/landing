// Solar Hijri dates in the kit come from @saasreport/calendar's arithmetic, never the runtime's ICU Persian calendar:
// the Workers runtime's ICU put Nowruz 1405 a day early, so 2026-10-03 rendered as ۱۲ مهر instead of ۱۱ مهر ۱۴۰۵.
// Intl is only for the clock time, the weekday, the layout and the digits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zonedDay, jalaliFor, formatJalali, formatInstant, dateTag } from "../src/instant.js";
import { icuPersianUses, installIntlGuard } from "../src/guard.js";
import vm from "node:vm";
import { toJalali, fromISO } from "../src/index.js";
import { digits } from "../../format/src/index.js";
import { localParts } from "../../monitor/src/journeys.js";
import { formatWhen } from "../../channels/src/messages.js";
import { dayLabel, dayMonth, monthName } from "../../core/src/dates.js";
import { copyrightYears } from "../../comms/src/runtime.js";
import { dateLocale } from "../../cloudflare/src/config.js";

const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEHRAN = "Asia/Tehran";
const fa = (s) => digits(s, "fa");

test("arithmetic: 2026-10-03 is 11 Mehr 1405, the Tehran midnight edge, Nowruz 1405", () => {
  assert.deepEqual(toJalali(fromISO("2026-10-03")), { jy: 1405, jm: 7, jd: 11 });
  assert.equal(fa(formatJalali("2026-10-03T08:00:00Z", { locale: "fa-IR", timeZone: TEHRAN, day: "numeric", month: "long", year: "numeric" })), "۱۱ مهر ۱۴۰۵");
  // 21:00 UTC on 2 October is 00:30 on Saturday 3 October in Tehran; 20:00 UTC is still Friday 10 Mehr
  assert.equal(fa(formatJalali("2026-10-02T21:00:00Z", { locale: "fa-IR", timeZone: TEHRAN, weekday: "long", day: "numeric", month: "long", year: "numeric" })), "شنبه ۱۱ مهر ۱۴۰۵");
  assert.equal(fa(formatJalali("2026-10-02T20:00:00Z", { locale: "fa-IR", timeZone: TEHRAN, weekday: "long", day: "numeric", month: "long", year: "numeric" })), "جمعه ۱۰ مهر ۱۴۰۵");
  assert.equal(zonedDay("2026-10-02T21:00:00Z", TEHRAN), fromISO("2026-10-03"));
  assert.equal(zonedDay("2026-10-02T20:00:00Z", TEHRAN), fromISO("2026-10-02"));
  assert.deepEqual(jalaliFor("2026-03-21T12:00:00Z", TEHRAN), { jy: 1405, jm: 1, jd: 1, n: fromISO("2026-03-21") });
  assert.deepEqual(jalaliFor("2026-03-20T12:00:00Z", TEHRAN), { jy: 1404, jm: 12, jd: 29, n: fromISO("2026-03-20") });
  assert.equal(fa(formatJalali("2026-03-21T12:00:00Z", { locale: "fa", timeZone: TEHRAN, day: "numeric", month: "long", year: "numeric" })), "۱ فروردین ۱۴۰۵");
  assert.equal(formatJalali("2026-10-03T08:00:00Z", { locale: "en-US", timeZone: TEHRAN, day: "numeric", month: "long", year: "numeric" }), "Mehr 11, 1405");
  assert.equal(formatJalali("2026-10-03T08:00:00Z", { locale: "en-GB", timeZone: TEHRAN, day: "2-digit", month: "2-digit", year: "numeric" }), "11/07/1405");
  assert.equal(formatJalali("not a date"), "");
});

const jalaliSite = { site: { locale: "fa-IR", timezone: TEHRAN }, calendar: { system: "jalali" } };

test("every former ICU Persian path gives 11 Mehr 1405 for 2026-10-03 (monitor, channels, core, comms, cloudflare)", () => {
  // monitor: the local day of month of a Jalali site
  assert.equal(localParts(jalaliSite, new Date("2026-10-02T21:00:00Z")).localDay, 11);
  assert.equal(localParts(jalaliSite, new Date("2026-10-02T20:00:00Z")).localDay, 10);
  assert.equal(localParts(jalaliSite, new Date("2026-03-21T12:00:00Z")).localDay, 1);
  // channels: the human date-time of an event
  assert.match(formatWhen(jalaliSite, "2026-10-03T08:00:00Z"), /^شنبه ۱۱ مهر ۱۴۰۵/);
  assert.match(formatWhen(jalaliSite, "2026-10-02T20:00:00Z"), /^جمعه ۱۰ مهر ۱۴۰۵/);
  assert.match(formatWhen({ ...jalaliSite, site: { ...jalaliSite.site, locale: "en-US" } }, "2026-10-03T08:00:00Z"), /^Saturday, Mehr 11, 1405/);
  // core: labels of day numbers, in Persian and in English on a Jalali site
  const n = fromISO("2026-10-03"), en = { site: { locale: "en-US" }, calendar: { system: "jalali" } };
  assert.equal(dayLabel(jalaliSite, n), "شنبه ۱۱ مهر ۱۴۰۵");
  assert.equal(dayLabel(en, n), "Saturday, Mehr 11, 1405");
  assert.equal(dayMonth(en, n), "Mehr 11");
  assert.equal(monthName(en, 1405, 7), "Mehr");
  assert.equal(dayLabel(en, fromISO("2026-03-21")), "Saturday, Farvardin 1, 1405");
  // comms: the Solar Hijri copyright year flips at Nowruz in Tehran, not a day early
  assert.deepEqual(copyrightYears({ y: { calendar: "jalali", numerals: "latn" } }, TEHRAN, new Date("2026-03-20T12:00:00Z")), { y: "1404" });
  assert.deepEqual(copyrightYears({ y: { calendar: "jalali", numerals: "arabext" } }, TEHRAN, new Date("2026-03-21T12:00:00Z")), { y: "۱۴۰۵" });
  // cloudflare: the Worker's Intl locale lays out Gregorian dates only, whatever calendar keyword the site carried
  assert.equal(dateLocale({ site: { locale: "fa-IR" }, calendar: { system: "jalali" } }), "fa-IR-u-ca-gregory");
  assert.equal(dateLocale({ site: { locale: "en-US-u-nu-arab" }, calendar: { system: "jalali" } }), "en-US-u-ca-gregory-nu-arab");
});

test("formatJalali: dateStyle and timeStyle layouts, no era, numeric widths", () => {
  const at = "2026-10-03T08:00:00Z", z = { timeZone: TEHRAN };
  assert.equal(formatJalali(at, { locale: "en-US", ...z, dateStyle: "long", timeStyle: "short" }).replace(/\s/g, " "), "Mehr 11, 1405 at 11:30 AM"); // ICU puts U+202F before AM
  assert.equal(formatJalali(at, { locale: "en-US", ...z, dateStyle: "short" }), "7/11/05");
  assert.equal(fa(formatJalali(at, { locale: "fa-IR", ...z, dateStyle: "long" })), "۱۱ مهر ۱۴۰۵");
  assert.equal(fa(formatJalali("2026-10-02T21:00:00Z", { locale: "fa-IR", ...z, dateStyle: "full" })), "شنبه ۱۱ مهر ۱۴۰۵");
  // the Gregorian era ("AD", "میلادی") is dropped with its space, never left trailing
  assert.equal(formatJalali(at, { locale: "en", ...z, year: "numeric", era: "short" }), "1405");
  assert.equal(formatJalali(at, { locale: "en", ...z, day: "numeric", month: "long", year: "numeric", era: "long" }), "Mehr 11, 1405");
  assert.equal(formatJalali(at, { locale: "fa", ...z, year: "numeric", month: "long", era: "long" }), "مهر 1405");
  assert.equal(formatJalali("2026-04-05T08:00:00Z", { locale: "en-GB", ...z, day: "2-digit", month: "2-digit", year: "2-digit" }), "16/01/05");
});

test("dateTag and formatInstant: Jalali → Gregorian layout + arithmetic; every other calendar keeps its own", () => {
  assert.equal(dateTag("fa-IR", "jalali"), "fa-IR-u-ca-gregory");
  assert.equal(dateTag("fa-IR-u-ca-persian-nu-arabext", "gregorian"), "fa-IR-u-ca-gregory-nu-arabext");
  assert.equal(dateTag("fa"), "fa-u-ca-gregory"); // CLDR's default for fa is Persian
  assert.equal(dateTag("ar-SA-u-ca-islamic-umalqura", "gregorian"), "ar-SA-u-ca-islamic-umalqura");
  assert.equal(dateTag("th-TH"), "th-TH");
  assert.match(formatInstant("2026-10-03T08:00:00Z", { locale: "ar-SA-u-ca-islamic-umalqura", timeZone: "Asia/Riyadh", dateStyle: "long" }), /١٤٤٨|1448/);
  assert.match(formatInstant("2026-10-03T08:00:00Z", { locale: "th-TH", timeZone: "Asia/Bangkok", dateStyle: "long" }), /2569/);
  assert.equal(fa(formatInstant("2026-10-02T21:00:00Z", { locale: "fa-IR", timeZone: TEHRAN, dateStyle: "long" })), "۱۱ مهر ۱۴۰۵"); // fa's own calendar → arithmetic
});

test("runtime guard: anything that resolves to ICU's Persian calendar is refused, however the tag was built", () => {
  // the suite runs with the guard (package.json: node --import ./packages/calendar/test/intl-guard.setup.mjs)
  assert.ok(globalThis[Symbol.for("@saasreport/calendar/intl-guard")], "npm test installs the Intl guard");
  const ctx = vm.createContext({});
  const guard = installIntlGuard({ scope: vm.runInContext("globalThis", ctx) });
  const refused = (code) => { const before = guard.violations.length; assert.throws(() => vm.runInContext(code, ctx), /ICU Persian calendar refused/, code); assert.equal(guard.violations.length, before + 1, code); };
  refused('new Intl.DateTimeFormat("fa-IR")');                                // CLDR default, no keyword
  refused('Intl.DateTimeFormat("en")["constructor"]; Intl.DateTimeFormat("en-u-ca-" + ["per", "sian"].join(""))'); // concatenated, called without new
  refused('const calendar = "PERSIAN".toLowerCase(); new Intl.DateTimeFormat("en", { calendar })');       // shorthand + variable
  refused('new Intl.DateTimeFormat("en", { ["calendar"]: `pers${"ian"}` })');   // computed key + template literal
  refused('new Intl.DateTimeFormat("EN-U-CA-PERSIAN")');                        // upper case
  refused('new Intl.DateTimeFormat("en-u-ca-\\u0070ersian")');                  // escape
  refused('new Intl.Locale("en", { calendar: "persian" })');
  refused('new Date(0).toLocaleDateString("fa-IR")');
  // a refusal swallowed by a try/catch fallback is still recorded: the suite's setup fails the file at exit
  assert.doesNotThrow(() => vm.runInContext('try { new Intl.DateTimeFormat("ps-AF") } catch { "swallowed" }', ctx));
  assert.equal(guard.violations.length, 9);
  for (const ok of ['new Intl.DateTimeFormat("fa-IR-u-ca-gregory").format(0)', 'new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura").format(0)', 'new Date(0).toLocaleDateString("en-GB")', 'new Intl.Locale("fa-IR").language'])
    assert.doesNotThrow(() => vm.runInContext(ok, ctx), ok);
  assert.equal(guard.allow(() => vm.runInContext('new Intl.DateTimeFormat("fa-IR").resolvedOptions().calendar', ctx)), "persian");
  guard.restore();
  assert.doesNotThrow(() => vm.runInContext('new Intl.DateTimeFormat("fa-IR")', ctx));
});

/** Every source a package ships or a site copies: src/ and assets/ of each package, examples/ and templates/. */
function shipped() {
  const walk = (d) => { try { return readdirSync(d).flatMap((f) => { const p = join(d, f); return f === "node_modules" ? [] : statSync(p).isDirectory() ? walk(p) : /\.(m?js|cjs|ts|html?)$/.test(f) ? [p] : []; }); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return []; throw e; } };
  const pkgs = readdirSync(PACKAGES).flatMap((p) => [join(PACKAGES, p, "src"), join(PACKAGES, p, "assets")]);
  return [...pkgs, join(ROOT, "examples"), join(ROOT, "templates")].flatMap(walk);
}

test("static tripwire: no shipped source names ICU's Persian calendar (src/, assets/, examples/, templates/; .js .mjs .cjs .ts .html)", () => {
  const files = shipped();
  assert.ok(files.length > 150, `the scan sees every package's source and assets (${files.length})`);
  assert.ok(files.some((f) => f.endsWith(".html")) && files.some((f) => f.includes(`${join("assets", "pages")}`)), "html and assets are scanned");
  const bad = files.map((f) => [f.slice(ROOT.length), icuPersianUses(readFileSync(f, "utf8"), { html: /\.html?$/.test(f) })]).filter(([, uses]) => uses.length);
  assert.deepEqual(bad, [], "use @saasreport/calendar (formatJalali, formatInstant, jalaliFor) for Solar Hijri dates; Intl only for layout, clock time and digits");
});

test("static rules: case, quoted keys, escapes, assignment; comments ignored by a lexer that keeps strings, templates and regexes", () => {
  assert.deepEqual(icuPersianUses('new Intl.DateTimeFormat("fa-IR-u-ca-persian")'), ["persian-tag"]);
  assert.deepEqual(icuPersianUses('new Intl.DateTimeFormat("FA-IR-U-CA-PERSIAN")'), ["persian-tag"]);
  assert.deepEqual(icuPersianUses("const o = { 'calendar': 'persian' };"), ["persian-option"]);
  assert.deepEqual(icuPersianUses('const o = { calendar: "\\u0070ersian" };'), ["persian-option"]);
  assert.deepEqual(icuPersianUses('o.calendar = "persian";'), ["persian-assignment"]);
  assert.deepEqual(icuPersianUses('if (o.calendar === "persian") legacy();'), []); // reading a legacy value is fine
  assert.deepEqual(icuPersianUses('const CA = { jalali: "persian" };'), ["persian-keyword-map"]);
  assert.deepEqual(icuPersianUses('// "fa-IR-u-ca-persian" is a day off\n/* calendar: "persian" */\nconst u = "https://x.test/ca";'), []);
  // a comment marker inside a string or a regex does not hide the code after it
  assert.deepEqual(icuPersianUses('const u = "http://x"; new Intl.DateTimeFormat("en-u-ca-persian")'), ["persian-tag"]);
  assert.deepEqual(icuPersianUses('const re = /\\/\\//; new Intl.DateTimeFormat("en-u-ca-persian")'), ["persian-tag"]);
  assert.deepEqual(icuPersianUses('const t = `a // ${1}`; x("ca-persian")'), ["persian-tag"]);
  assert.deepEqual(icuPersianUses('<!-- ca-persian --><script>new Intl.DateTimeFormat("fa-u-ca-persian")</script>', { html: true }), ["persian-tag"]);
  assert.deepEqual(icuPersianUses("<!-- ca-persian -->", { html: true }), []);
});
