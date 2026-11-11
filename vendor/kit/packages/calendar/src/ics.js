/* @saasreport/calendar/ics — subscribable iCalendar (RFC 5545) feeds for every market profile in markets.js.

   marketIcs("sa", { uidPrefix: "example-", domain: "example.org" }) → one VCALENDAR text with
   - one all-day VEVENT per holiday day (floating DATE values, so no VTIMEZONE is needed; X-WR-TIMEZONE names the
     market's zone for clients that show it);
   - Islamic (Hijri-derived) holidays that are still predictions marked STATUS:TENTATIVE, "(expected)" in the
     summary, CATEGORIES:EXPECTED and the PREDICTED_NOTE in the description; announced and fixed dates are
     STATUS:CONFIRMED;
   - optional weekly weekend events (weekends: true), one RRULE per weekend definition in the range, with an EXDATE
     for every make-up working day in it;
   - make-up working days (China's 调休: a weekend day that is a working day) as all-day events titled
     "Working day (make-up for …)", CATEGORIES:WORKDAY (workdays: false leaves them out);
   - stable UIDs: Hijri holidays are keyed by Hijri year, rule and day index (so a prediction that moves by a day
     after the announcement updates the same event, with SEQUENCE raised), others by date and rule;
   - a deterministic body for a given range and data: DTSTAMP is the profile's data version date, so a feed only
     changes when the data does (good for ETags and caches);
   - CRLF line endings, TEXT escaping, and lines folded at 75 octets without splitting a UTF-8 character. */
import { COPY, fill } from "./copy.js";
import { market, yearHolidays, weekendOf, dow, makeUpWorkdaysBetween, PREDICTED_NOTE, MarketError } from "./markets.js";

const DAY = 86400000;
const VERSION = "1.4.0"; // keep equal to package.json and index.js VERSION (test/ics.test.mjs checks it via PRODID)
const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const d8 = (n) => isoOf(n).replace(/-/g, "");
const dayOfISO = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY);
const COVERAGE = { from: 1900, to: 2100 };
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** TEXT value escaping (RFC 5545 §3.3.11): backslash, semicolon, comma and newlines. */
export const escapeText = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\r\n|\r|\n/g, "\\n");

/** Fold one content line at 75 octets (RFC 5545 §3.1): continuation lines start with one space, and a UTF-8
 *  character is never split. */
export function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "", size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; size = 0; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** Lines → one iCalendar text: folded, CRLF-terminated. */
export const icsText = (lines) => lines.map(foldLine).join("\r\n") + "\r\n";

const WORDS = COPY.ics.words;
const NOTE_FA = COPY.ics.predicted;
const pick = (o, lang) => (o && (o[lang] || o.en || o.ar || o.fa)) || "";

/** Range → [first, last] day numbers. Accepts Gregorian years (integers) or ISO dates; default: this Gregorian year
 *  and the next one, in the market's time zone at `now`. */
function rangeOf(from, to, now, timeZone) {
  const read = (v, end) => {
    if (Number.isInteger(v)) {
      if (v < COVERAGE.from || v > COVERAGE.to) throw new MarketError("invalid_range", `Years must be from ${COVERAGE.from} to ${COVERAGE.to}.`);
      return end ? dayOfISO(`${v}-12-31`) : dayOfISO(`${v}-01-01`);
    }
    if (typeof v === "string" && /^\d{4}$/.test(v)) return read(Number(v), end);
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && isoOf(dayOfISO(v)) === v) return dayOfISO(v);
    throw new MarketError("invalid_range", "from and to must be Gregorian years or ISO dates (YYYY-MM-DD).");
  };
  if (from == null && to == null) {
    const y = Number(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(now ? new Date(now) : new Date()));
    return [read(y, false), read(y + 1, true)];
  }
  const a = read(from ?? to, false), b = read(to ?? from, true);
  if (b < a) throw new MarketError("invalid_range", "from must not be after to.");
  if (b - a > 366 * 10) throw new MarketError("invalid_range", "A feed may span at most 10 years.");
  if (new Date(a * DAY).getUTCFullYear() < COVERAGE.from || new Date(b * DAY).getUTCFullYear() > COVERAGE.to) throw new MarketError("invalid_range", `Dates must be from ${COVERAGE.from} to ${COVERAGE.to}.`);
  return [a, b];
}

/** A market's weekend segments within [a, b]: [{ from, to, days }]. */
function weekendSegments(id, a, b) {
  const w = market(id).weekend;
  if (!w.length) return [];
  if (typeof w[0] === "number") return [{ from: a, to: b, days: w, key: "weekend" }];
  // Entries are newest first ({ from, days }); find where the weekend changes inside the range.
  const segs = [];
  let start = a, cur = weekendOf(id, a);
  const changes = w.filter((e) => e.from).map((e) => dayOfISO(e.from)).filter((n) => n > a && n <= b).sort((x, y) => x - y);
  for (const c of changes) {
    segs.push({ from: start, to: c - 1, days: cur });
    start = c; cur = weekendOf(id, c);
  }
  segs.push({ from: start, to: b, days: cur });
  return segs.filter((s) => s.days.length).map((s) => ({ ...s, key: `weekend-${d8(s.from)}` }));
}

/**
 * An iCalendar feed of one market's holidays.
 * @param {string} id  market id (markets.js MARKET_IDS: sa, ae, …, uk, us, eu, ir)
 * @param {object} [o]
 *   from, to    Gregorian years or ISO dates, inclusive (default: this year and next, at `now` in the market zone)
 *   uidPrefix   UID prefix, the site's own (e.g. "example-"); letters, digits, ".", "_", "-"
 *   domain      right-hand side of every UID (default "calendar.invalid")
 *   name        X-WR-CALNAME (default "<market name> holidays")
 *   description X-WR-CALDESC
 *   locale      "en" (default), "ar" or "fa": titles and notes
 *   weekends    true: also weekly all-day weekend events (RRULE; make-up working days are EXDATEs)
 *   workdays    false: leave out the make-up working day events (default true; only some markets have them)
 *   url         the feed's own https URL (URL and SOURCE properties)
 *   refresh     ISO 8601 duration for REFRESH-INTERVAL / X-PUBLISHED-TTL (default "P1D")
 *   stamp       DTSTAMP override (Date); default: the profile's data version date
 *   prodid, now
 */
export function marketIcs(id, { from, to, now, uidPrefix = "cal-", domain = "calendar.invalid", name, description, locale = "en", weekends = false, workdays = true, url, refresh = "P1D", stamp, prodid = `-//kit//calendar markets ${VERSION}//EN` } = {}) {
  const m = market(id);
  if (!/^[A-Za-z0-9._-]*$/.test(String(uidPrefix))) throw new MarketError("invalid_option", "uidPrefix may only contain letters, digits, '.', '_' and '-'.");
  if (!/^[A-Za-z0-9.-]+$/.test(String(domain))) throw new MarketError("invalid_option", "domain must be a host name.");
  if (!/^P(\d+[DW]|T\d+[HM]|\d+DT\d+H)$/.test(String(refresh))) throw new MarketError("invalid_option", 'refresh must be an ISO 8601 duration such as "P1D" or "PT12H".');
  const lang = WORDS[String(locale).slice(0, 2)] ? String(locale).slice(0, 2) : "en";
  const W = WORDS[lang];
  const timeZone = m.timeZone || m.timezone || "UTC";
  const [a, b] = rangeOf(from, to, now, timeZone);
  const mid = m.id.replace(/[^A-Za-z0-9]+/g, "-");
  const version = m.dataVersion || `${m.id}-unversioned`;
  const vdate = (version.match(/(\d{4})\.(\d{2})\.(\d{2})$/) || []).slice(1).join("");
  const dtstamp = stamp ? new Date(stamp).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")
    : vdate ? `${vdate}T000000Z` : new Date(now || Date.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const calName = name || `${pick(m.name, lang)} ${W.holidays}`;

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodid}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `NAME:${escapeText(calName)}`, `X-WR-CALNAME:${escapeText(calName)}`];
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`, `X-WR-CALDESC:${escapeText(description)}`);
  lines.push(`X-WR-TIMEZONE:${timeZone}`, `REFRESH-INTERVAL;VALUE=DURATION:${refresh}`, `X-PUBLISHED-TTL:${refresh}`);
  if (url) lines.push(`URL;VALUE=URI:${url}`, `SOURCE;VALUE=URI:${url}`);

  // Holidays, one event per day.
  const list = [];
  for (let y = new Date(a * DAY).getUTCFullYear(); y <= new Date(b * DAY).getUTCFullYear(); y++) for (const h of yearHolidays(m.id, y)) if (h.date >= a && h.date <= b) list.push(h);
  const hijriIndex = new Map(), seen = new Map();
  for (const h of list) {
    let key;
    if (h.hijriYear != null) {
      const g = `h${h.hijriYear}-${h.id}${h.observed ? "-observed" : ""}`;
      const k = (hijriIndex.get(g) || 0) + 1;
      hijriIndex.set(g, k);
      key = `${g}-${k}`;
    } else key = `${d8(h.date)}-${String(h.id).replace(/[^A-Za-z0-9]+/g, "-")}${h.observed ? "-observed" : ""}`;
    const dup = (seen.get(key) || 0) + 1;
    seen.set(key, dup);
    if (dup > 1) key += `-${dup}`;
    const title = pick(h.title, lang) || h.id;
    const tags = [h.predicted ? W.expected : null, h.half ? W.half : null, h.observed ? W.observed : null].filter(Boolean);
    const summary = tags.length ? `${title} (${tags.join(", ")})` : title;
    const note = h.predicted ? (lang === "fa" ? NOTE_FA : pick(h.note || PREDICTED_NOTE, lang)) : h.official ? W.announced : W.official;
    const desc = [note, h.observed && h.of ? fill(W.observedOf, { d: h.of }) : null, h.source && /^https?:\/\//.test(h.source) ? h.source : null].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:${uidPrefix}${mid}-${key}@${domain}`, `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${d8(h.date)}`, `DTEND;VALUE=DATE:${d8(h.date + 1)}`, `SUMMARY:${escapeText(summary)}`, `DESCRIPTION:${escapeText(desc)}`,
      `STATUS:${h.predicted ? "TENTATIVE" : "CONFIRMED"}`, `SEQUENCE:${h.official ? 1 : 0}`,
      `CATEGORIES:HOLIDAY,${h.predicted ? "EXPECTED" : "OFFICIAL"}${h.half ? ",HALF-DAY" : ""}${h.observed ? ",SUBSTITUTE" : ""}`,
      "TRANSP:TRANSPARENT", "CLASS:PUBLIC");
    lines.push("END:VEVENT");
  }

  // Make-up working days: weekend days that are working days.
  const makeUp = makeUpWorkdaysBetween(m.id, a, b);
  if (workdays) for (const w of makeUp) {
    const desc = [W.workdayNote, w.source && /^https?:\/\//.test(w.source) ? w.source : null].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:${uidPrefix}${mid}-${d8(w.date)}-workday@${domain}`, `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${d8(w.date)}`, `DTEND;VALUE=DATE:${d8(w.date + 1)}`, `SUMMARY:${escapeText(pick(w.title, lang) || w.title.en)}`, `DESCRIPTION:${escapeText(desc)}`,
      "STATUS:CONFIRMED", "SEQUENCE:0", "CATEGORIES:WORKDAY,OFFICIAL", "TRANSP:TRANSPARENT", "CLASS:PUBLIC", "END:VEVENT");
  }

  // Weekends: one weekly recurring all-day event per weekend definition.
  if (weekends) for (const s of weekendSegments(m.id, a, b)) {
    let first = s.from;
    while (!s.days.includes(dow(first)) && first <= s.to) first++;
    if (first > s.to) continue;
    const byday = [...s.days].sort((x, y) => x - y).map((d) => BYDAY[d]).join(",");
    const ex = makeUp.filter((w) => w.date >= first && w.date <= s.to && s.days.includes(dow(w.date))).map((w) => d8(w.date));
    lines.push("BEGIN:VEVENT", `UID:${uidPrefix}${mid}-${s.key}@${domain}`, `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${d8(first)}`, `DTEND;VALUE=DATE:${d8(first + 1)}`, `RRULE:FREQ=WEEKLY;BYDAY=${byday};UNTIL=${d8(s.to)}`);
    if (ex.length) lines.push(`EXDATE;VALUE=DATE:${ex.join(",")}`);
    lines.push(`SUMMARY:${escapeText(W.weekend)}`, `DESCRIPTION:${escapeText(W.weekendNote)}`, "STATUS:CONFIRMED", "CATEGORIES:WEEKEND",
      "TRANSP:TRANSPARENT", "CLASS:PUBLIC", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return icsText(lines);
}

/** Can this id be served as a feed? (a known market profile) */
export function hasMarketFeed(id) {
  try { market(String(id)); return true; } catch { return false; /* not a known market: false is the answer */ }
}
