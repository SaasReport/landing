/* Iran (the original profile) must stay byte-identical while the engine grows other markets.
   This hashes the canonical output of every Iran-facing function over a wide window and compares
   it with test/fixtures/iran.snapshot.json, captured from the engine before the markets work.
   Regenerate only on purpose: KIT_UPDATE_SNAPSHOT=1 node --test packages/calendar/test/iran-snapshot.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as C from "../src/index.js";
import * as P from "../src/picker.js";

const FIXTURE = new URL("./fixtures/iran.snapshot.json", import.meta.url);
const sha = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

function outputs() {
  const from = C.fromJalali(1400, 1, 1), to = C.fromJalali(1410, 12, C.monthLength(1410, 12));
  const days = [];
  for (let n = from; n <= to; n++) days.push(n);
  const opts = [undefined, { profile: "bank" }, { profile: "government" }, { profile: "market" }, { weekend: [6], holidays: false }];
  // The conventions the snapshot was captured with; "nearest" (added later) has its own hashes below.
  const LEGACY_CONVENTIONS = ["following", "modified_following", "preceding", "modified_preceding", "none"];
  const out = {};
  out.describe = sha(days.map((n) => C.describe(n)));
  for (const [i, o] of opts.entries()) {
    out[`status_${i}`] = sha(days.map((n) => C.dayStatus(n, o)));
    out[`settle_${i}`] = sha(days.filter((n) => n % 3 === 0).map((n) => [C.settlement(n, 1, o), C.settlement(n, 2, o), C.addBusinessDays(n, -3, o)]));
    out[`adjust_${i}`] = sha(days.filter((n) => n % 2 === 0).map((n) => LEGACY_CONVENTIONS.map((c) => C.adjust(n, c, o))));
    out[`nearest_${i}`] = sha(days.filter((n) => n % 2 === 0).map((n) => C.adjust(n, "nearest", o)));
    out[`between_${i}`] = sha(days.filter((n) => n % 11 === 0).map((n) => C.businessDaysBetween(n, n + 40, o)));
  }
  out.holidays = sha(Array.from({ length: 11 }, (_, i) => C.holidays(1400 + i)));
  out.months = sha(Array.from({ length: 24 }, (_, i) => C.month(1404 + Math.floor(i / 12), (i % 12) + 1, { profile: "bank" })));
  out.schedule = sha([
    C.schedule({ start: "1405/05/31", count: 24, amount: 1_200_000_000, convention: "modified_following" }),
    C.schedule({ start: "1404/12/29", count: 12, amount: 999, convention: "preceding", profile: "market" }),
  ]);
  out.ics = sha(C.ics({ from: 1403, to: 1407 }).replace(/^DTSTAMP:.*$/gm, "DTSTAMP:X"));
  out.parse = sha(["1405/07/08", "۱۴۰۵-۰۷-۰۸", "2026-09-30", "٢٠٢٦/٠٩/٣٠"].map((s) => C.parseDate(s)));
  out.hijri = sha(days.filter((n) => n % 5 === 0).map((n) => C.toHijri(n)));
  out.picker = sha([
    ...Array.from({ length: 24 }, (_, i) => P.monthMatrix(1404 + Math.floor(i / 12), (i % 12) + 1, { today: C.fromISO("2026-09-30") })),
    ...days.filter((n) => n % 17 === 0).map((n) => P.dayDetail(n, { settlement: 1 })),
  ]);
  out.names = sha([C.J_MONTHS, C.H_MONTHS, C.G_MONTHS, C.WEEKDAYS, C.SEASONS, C.PROFILES, C.CONVENTIONS, C.RANGE, C.TZ, C.VERSION]);
  return out;
}

test("Iran output is byte-identical to the snapshot", () => {
  const got = outputs();
  if (process.env.KIT_UPDATE_SNAPSHOT === "1") writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
  const want = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(got, want);
});
