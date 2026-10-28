/* @saasreport/calendar/relative — Persian relative date expressions on top of parseInput. Never throws; never guesses.

   Accepted (any digit set, ZWNJ or space spellings):
   - an anchor alone: anything parseInput reads (1405/07/15, ۱۵ مهر ۱۴۰۵, 2026-10-07, today/امروز …),
     the relative days امروز / فردا / پس‌فردا / دیروز / پریروز, or a day and month without a year
     (۱۵ مهر → this Jalali year in options.timeZone; reported in `assumptions`)
   - an offset: "<N> روز [کاری] بعد|پس|قبل|پیش [از <anchor>]" — N in digits or Persian number words
     (سه، بیست و دو …, up to 3650); without "از <anchor>" the anchor is today; "کاری" counts business days of
     options.profile (default "bank") with the engine's holidays
   - an optional trailing time: "ساعت 10" / "ساعت ۱۰:۳۰" (24-hour)

   Result: { ok: true, input, day, iso, time ("HH:MM" | null), uncertain (a predicted holiday was involved),
   steps: [{ step, value }], assumptions: [{ kind, value }] } or { ok: false, input, error: { code, message }, steps }.
   step is one of: time, count, unit (business | calendar), direction (after | before), anchor (relative word or the
   calendar system read), profile. Error codes: empty, invalid_time, invalid_count, plus parseInput's codes. */
import * as C from "./index.js";
import { parseInput, normalizeDigits, normalizeText } from "./parse.js";
import { dayOf } from "./time.js";

const pad = (n) => String(n).padStart(2, "0");
const WORDS = { "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "شیش": 6, "هفت": 7, "هشت": 8, "نه": 9, "ده": 10, "یازده": 11, "دوازده": 12,
  "سیزده": 13, "چهارده": 14, "پانزده": 15, "پونزده": 15, "شانزده": 16, "هفده": 17, "هجده": 18, "هیجده": 18, "نوزده": 19, "بیست": 20, "سی": 30,
  "چهل": 40, "پنجاه": 50, "شصت": 60, "هفتاد": 70, "هشتاد": 80, "نود": 90, "صد": 100, "دویست": 200, "سیصد": 300, "چهارصد": 400, "پانصد": 500 };
const RELATIVE = { "امروز": 0, "فردا": 1, "پسفردا": 2, "دیروز": -1, "پریروز": -2 };
const MAX = 3650;

function count(text) {
  const t = text.replace(/‌/g, " ").trim();
  if (/^\d+$/.test(t)) return +t;
  let total = 0;
  for (const part of t.split(/\s+و\s+/)) { const v = WORDS[part.trim()]; if (v == null) return null; total += v; }
  return total || null;
}

function anchorOf(text, steps, assumptions, o) {
  const key = text.replace(/[\s‌]/g, "");
  const today = dayOf(o.now, o.timeZone);
  if (key in RELATIVE) { steps.push({ step: "anchor", value: key }); return { day: today + RELATIVE[key] }; }
  let r = parseInput(text, { timeZone: o.timeZone, now: o.now });
  if (!r.ok && /^\d{1,2}\s+\S+$/.test(text)) {
    const y = C.toJalali(today).jy, again = parseInput(`${text} ${y}`, { timeZone: o.timeZone, now: o.now });
    if (again.ok && again.system === "jalali") { assumptions.push({ kind: "year", value: String(y) }); r = again; }
  }
  if (!r.ok) return { error: r.error };
  steps.push({ step: "anchor", value: r.system });
  return { day: r.day, parsed: r };
}

export function resolveRelative(input, { now = new Date(), timeZone = "Asia/Tehran", profile = "bank" } = {}) {
  const steps = [], assumptions = [];
  const fail = (code, message) => ({ ok: false, input, error: { code, message }, steps });
  let s = normalizeText(normalizeDigits(input));
  if (!s) return fail("empty", "Enter a date expression.");
  const o = { now, timeZone };
  let time = null;
  const tm = s.match(/(?:،|,)?\s*ساعت\s*(\d{1,2})(?::(\d{2}))?\s*$/);
  if (tm) {
    const h = +tm[1], m = +(tm[2] || 0);
    if (h > 23 || m > 59) return fail("invalid_time", "Hour 0–23, minute 0–59.");
    time = `${pad(h)}:${pad(m)}`;
    s = s.slice(0, tm.index).trim();
    steps.push({ step: "time", value: time });
  }
  const rel = s.match(/^(.+?)\s*روز\s*(کاری)?\s*(بعد|پس|قبل|پیش)(?:\s+از\s+(.+))?$/);
  let day, uncertain = false;
  if (rel) {
    const k = count(rel[1]);
    if (k == null || k > MAX) return fail("invalid_count", `Could not read the number of days (${rel[1]}).`);
    const business = !!rel[2], sign = /قبل|پیش/.test(rel[3]) ? -1 : 1;
    steps.push({ step: "count", value: String(k) }, { step: "unit", value: business ? "business" : "calendar" }, { step: "direction", value: sign > 0 ? "after" : "before" });
    const a = anchorOf(rel[4] ? rel[4].trim() : "امروز", steps, assumptions, o);
    if (a.error) return fail(a.error.code, a.error.message);
    if (business) {
      steps.push({ step: "profile", value: profile });
      let r;
      try { r = C.addBusinessDays(a.day, sign * k, { profile }); }
      catch (e) { return fail(e.code || "out_of_range", e.message); }
      day = r.date; uncertain = !!r.uncertain;
    } else day = a.day + sign * k;
  } else {
    const a = anchorOf(s, steps, assumptions, o);
    if (a.error) return fail(a.error.code, a.error.message);
    day = a.day;
    if (a.parsed?.kind === "datetime" && a.parsed.zoned && !time) time = String(a.parsed.zoned).slice(11, 16);
  }
  const jy = C.toJalali(day).jy;
  if (jy < C.RANGE.min || jy > C.RANGE.max) return fail("out_of_range", "The result is outside the supported range.");
  uncertain ||= C.holidaysOn(day).some((h) => h.status === "predicted");
  return { ok: true, input, day, iso: C.toISO(day), time, uncertain, steps, assumptions };
}
