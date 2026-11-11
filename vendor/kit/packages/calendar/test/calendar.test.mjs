import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/index.js";

test("Jalali round-trip for every day 1300–1500", () => {
  for (let jy = 1300; jy <= 1500; jy++) {
    let prev = null;
    for (let jm = 1; jm <= 12; jm++) for (let jd = 1; jd <= C.monthLength(jy, jm); jd++) {
      const n = C.fromJalali(jy, jm, jd);
      assert.deepEqual(C.toJalali(n), { jy, jm, jd });
      if (prev != null) assert.equal(n, prev + 1);
      prev = n;
    }
  }
});

test("known anchors", () => {
  assert.equal(C.toISO(C.fromJalali(1404, 1, 1)), "2025-03-21");
  assert.equal(C.toISO(C.fromJalali(1405, 1, 1)), "2026-03-21");
  assert.equal(C.toISO(C.fromJalali(1403, 12, 30)), "2025-03-20"); // 1403 is leap
  assert.equal(C.isLeap(1403), true);
  assert.equal(C.isLeap(1404), false);
  assert.equal(C.WEEKDAYS[C.weekday(C.fromISO("2026-09-29"))], "سه‌شنبه");
  assert.equal(C.parseDate("۱۴۰۵/۰۷/۰۷"), C.fromISO("2026-09-29"));
  assert.equal(C.parseDate("2026-09-29"), C.fromISO("2026-09-29"));
  assert.throws(() => C.parseDate("1404/12/30"), { code: "invalid_date" });
  assert.throws(() => C.parseDate("2026-02-30"), { code: "invalid_date" });
});

test("holidays: solar official, lunar predicted, 26 per year give or take overlaps", () => {
  const h = C.holidays(1405);
  const titles = h.map((x) => x.title);
  for (const t of ["جشن نوروز", "روز طبیعت", "رحلت امام خمینی", "پیروزی انقلاب اسلامی", "عاشورای حسینی", "عید سعید فطر", "عید سعید قربان"]) assert.ok(titles.includes(t), t);
  assert.ok(h.filter((x) => x.kind === "solar").every((x) => x.status === "official"));
  assert.ok(h.filter((x) => x.kind === "lunar").every((x) => x.status === "predicted"));
  assert.ok(h.length >= 25 && h.length <= 29, String(h.length));
  // Ashura 1404 computed on 15 Tir (6 July 2025)
  const ashura = C.holidays(1404).find((x) => x.title === "عاشورای حسینی");
  assert.equal(C.toISO(ashura.date), "2025-07-06");
});

test("official lunar table overrides prediction", () => {
  C.registerOfficialLunar({ 1404: { "1-10": "4-15" } });
  const a = C.holidays(1404).find((x) => x.title === "عاشورای حسینی");
  assert.equal(a.status, "official");
  assert.equal(C.toISO(a.date), "2025-07-06");
  C.registerOfficialLunar({ 1404: {} });
});

test("business days, conventions, settlement", () => {
  const fri = C.fromISO("2026-10-02"); // Friday
  assert.equal(C.weekday(fri), 6);
  assert.equal(C.isBusinessDay(fri), false);
  assert.equal(C.isBusinessDay(fri - 1), true);                       // Thursday: banks work
  assert.equal(C.isBusinessDay(fri - 1, { profile: "government" }), false);
  assert.equal(C.adjust(fri, "following").date, fri + 1);
  assert.equal(C.adjust(fri, "preceding").date, fri - 1);
  // Nowruz: 1405/01/01..04 holidays → T+1 from 1404/12/28 skips 29 (oil day), Nowruz, Friday
  const t = C.settlement(C.fromJalali(1404, 12, 28), 1);
  assert.ok(C.isBusinessDay(t.date));
  assert.ok(t.date > C.fromJalali(1405, 1, 4));
  // modified_following stays in the month
  const endEsfand = C.fromJalali(1404, 12, 29);
  const mf = C.adjust(endEsfand, "modified_following");
  assert.equal(C.toJalali(mf.date).jm, 12);
  const bd = C.businessDaysBetween(C.fromISO("2026-09-26"), C.fromISO("2026-10-03"));
  assert.equal(bd.calendar, 7);
  assert.ok(bd.business >= 5 && bd.business <= 6);
});

test("instalment schedule clamps and adjusts", () => {
  const rows = C.schedule({ start: "1405/05/31", count: 8, amount: 1000000001 });
  assert.equal(rows.length, 8);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), 1000000001);
  const mehr = rows.find((r) => C.toJalali(r.scheduled).jm === 7);
  assert.equal(C.toJalali(mehr.scheduled).jd, 30);                     // 31 → 30 in Mehr
  for (const r of rows) assert.ok(C.isBusinessDay(r.due));
});

test("month grid and ics", () => {
  const m = C.month(1405, 7);
  assert.equal(m.cells.length % 7, 0);
  assert.equal(m.cells.filter((c) => c.inMonth).length, 30);
  assert.equal(m.cells[0].weekday, 0);
  const cal = C.ics({ from: 1405, to: 1405 });
  assert.match(cal, /^BEGIN:VCALENDAR\r\n/);
  assert.ok((cal.match(/BEGIN:VEVENT/g) || []).length >= 25);
  for (const line of cal.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

// The HTTP handler test (legacy src/calendar-api.js) moved to @saasreport/cloudflare.

test("ics takes a name and UID domain; holidays:false ignores the holiday table", () => {
  const cal = C.ics({ from: 1405, to: 1405, name: "Demo", domain: "example.org" });
  assert.match(cal, /X-WR-CALNAME:Demo/);
  assert.match(cal, /@example\.org/);
  const nowruz = C.fromJalali(1405, 1, 1); // Saturday, official holiday
  assert.equal(C.isBusinessDay(nowruz), false);
  assert.equal(C.isBusinessDay(nowruz, { holidays: false }), true);
  assert.equal(C.isBusinessDay(nowruz + 6, { holidays: false }), false); // Friday is still a weekend
});

test("client requires a baseUrl", async () => {
  const { KitCalendarClient } = await import("../src/client.js");
  assert.throws(() => new KitCalendarClient(), /baseUrl/);
  const c = new KitCalendarClient({ baseUrl: "https://example.org/", fetch: async (u) => ({ status: 200, json: async () => ({ ok: true, data: { u } }) }) });
  assert.equal((await c.today()).u, "https://example.org/api/calendar/today");
});
