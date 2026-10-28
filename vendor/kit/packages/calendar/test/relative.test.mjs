import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRelative } from "../src/relative.js";
import * as C from "../src/index.js";

const now = new Date("2026-10-01T08:00:00Z"); // 9 Mehr 1405, Tehran
const r = (s) => resolveRelative(s, { now });

test("business-day offsets from an explicit anchor, with a time", () => {
  const x = r("سه روز کاری بعد از ۱۵ مهر ۱۴۰۵ ساعت ۱۰");
  assert.equal(x.ok, true);
  assert.equal(x.iso, C.toISO(C.addBusinessDays(C.fromJalali(1405, 7, 15), 3, { profile: "bank" }).date));
  assert.equal(x.time, "10:00");
  assert.deepEqual(x.steps.map((s) => s.step), ["time", "count", "unit", "direction", "anchor", "profile"]);
});

test("calendar-day offsets, number words, relative words and default anchor", () => {
  assert.equal(r("بیست و دو روز بعد از 1405/07/15").iso, C.toISO(C.fromJalali(1405, 7, 15) + 22));
  assert.equal(r("فردا").iso, C.toISO(C.fromJalali(1405, 7, 10)));
  assert.equal(r("پس‌فردا").iso, C.toISO(C.fromJalali(1405, 7, 11)));
  assert.equal(r("۵ روز قبل").iso, C.toISO(C.fromJalali(1405, 7, 4)));
});

test("a day and month without a year assume this Jalali year and say so", () => {
  const x = r("سه روز کاری بعد از ۱۵ مهر");
  assert.equal(x.ok, true);
  assert.deepEqual(x.assumptions, [{ kind: "year", value: "1405" }]);
});

test("refuses what it cannot read instead of guessing", () => {
  assert.equal(r("").error.code, "empty");
  assert.equal(r("چند روز بعد").error.code, "invalid_count");
  assert.equal(r("فردا ساعت ۲۵").error.code, "invalid_time");
  assert.equal(r("یک روز بعد از بهار").ok, false);
  assert.equal(r("هفته‌ی بعد").ok, false);
});
