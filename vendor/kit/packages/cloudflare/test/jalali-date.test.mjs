/* Solar Hijri dates come from @saasreport/calendar, never the runtime's ICU (Workers' ICU put Nowruz 1405 a day early). */
import test from "node:test";
import assert from "node:assert/strict";
import * as calendar from "@saasreport/calendar";
import { makeKit } from "./helpers.mjs";
import { dateLocale } from "../src/config.js";

test("fmtDate/fmtWhen take day, month and year from the kit calendar", () => {
  const { kit } = makeKit("fa");
  const k = kit.context, iso = "2026-10-03T02:30:00Z";
  const j = calendar.toJalali(k.dayOf(new Date(iso)));
  assert.deepEqual(j, { jy: 1405, jm: 7, jd: 11 });
  assert.equal(k.fmtDate(iso), "۱۱ مهر ۱۴۰۵");
  const when = k.fmtWhen(iso);
  for (const part of ["۱۱", "مهر", "۱۴۰۵", "شنبه"]) assert.ok(when.includes(part), `${part} in ${when}`);
  assert.equal(k.fmtDate("not a date"), "");
});

test("a site locale that names ICU's Persian calendar still gets the arithmetic date, across Tehran midnight", () => {
  // fa-IR-u-ca-persian asked ICU for the day; the Worker now lays out a Gregorian formatter and takes the Jalali day
  // from @saasreport/calendar, so a runtime ICU that is a day off (Workers in 1405) can no longer move the date.
  const { kit } = makeKit("fa", { config: (c) => ({ ...c, site: { ...c.site, locale: "fa-IR-u-ca-persian" } }) });
  const k = kit.context;
  assert.equal(k.fmtDate("2026-10-03T02:30:00Z"), "۱۱ مهر ۱۴۰۵");
  assert.equal(k.fmtDate("2026-10-02T21:00:00Z"), "۱۱ مهر ۱۴۰۵");
  assert.equal(k.fmtDate("2026-10-02T20:00:00Z"), "۱۰ مهر ۱۴۰۵");
  assert.equal(k.fmtDate("2026-03-21T12:00:00Z"), "۱ فروردین ۱۴۰۵");
});

test("a non-Persian Jalali locale keeps its own month names; numeric months stay numeric", () => {
  const { kit } = makeKit("en", { config: (c) => ({ ...c, calendar: { ...c.calendar, system: "jalali" } }) });
  const k = kit.context, iso = "2026-10-03T02:30:00Z";
  const date = k.fmtDate(iso);
  assert.ok(!date.includes("مهر"), date);
  assert.match(date, /Mehr/);
  assert.match(date, /11/);
  assert.match(date, /1405/);
  assert.match(k.fmtPart(iso, { month: "2-digit", day: "2-digit" }), /07.*11|11.*07/);
});

test("a locale with its own Unicode extension still gets Solar Hijri dates", () => {
  const { kit } = makeKit("en", { config: (c) => ({ ...c, site: { ...c.site, locale: "en-US-u-nu-arab" }, calendar: { ...c.calendar, system: "jalali" } }) });
  const date = kit.context.fmtDate("2026-10-03T02:30:00Z");
  assert.ok(!/October/.test(date), date);
  assert.match(date, /Mehr/);
});

test("gregorian sites keep ICU formatting", () => {
  const { kit } = makeKit("en");
  assert.match(kit.context.fmtDate("2026-10-03T02:30:00Z"), /2026/);
});

test("a Hijri site keeps its own calendar: only Jalali sites get the Gregorian layout calendar", () => {
  // calendar.system is jalali or gregorian; a Hijri site is a non-Jalali site whose locale names islamic-umalqura.
  // ar-SA-u-ca-islamic-umalqura: 2026-10-03 is 22 Rabi' al-Akhir 1448 in Riyadh; forcing gregory would print 2026.
  const { kit } = makeKit("en", { config: (c) => ({ ...c, site: { ...c.site, locale: "ar-SA-u-ca-islamic-umalqura", timezone: "Asia/Riyadh" }, calendar: { ...c.calendar, system: "gregorian" } }) });
  const date = kit.context.fmtDate("2026-10-03T08:00:00Z");
  assert.match(date, /1448|١٤٤٨/, date);
  assert.doesNotMatch(date, /2026|٢٠٢٦/, date);
  assert.equal(dateLocale({ site: { locale: "ar-SA-u-ca-islamic-umalqura" }, calendar: { system: "gregorian" } }), "ar-SA-u-ca-islamic-umalqura");
  assert.equal(dateLocale({ site: { locale: "th-TH" }, calendar: { system: "gregorian" } }), "th-TH"); // Buddhist stays Buddhist
  assert.equal(dateLocale({ site: { locale: "fa-IR" }, calendar: { system: "jalali" } }), "fa-IR-u-ca-gregory");
  // a non-Jalali site whose locale defaults to ICU's Persian calendar gets Gregorian, never Persian
  assert.equal(dateLocale({ site: { locale: "fa-IR" }, calendar: { system: "gregorian" } }), "fa-IR-u-ca-gregory");
});
