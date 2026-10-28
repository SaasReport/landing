/* @saasreport/calendar/weekday — the package's one canonical weekday convention, and adapters to the legacy ones.

   Canonical (every new API: time.js, parse.js, working hours): ISO 8601, 1 = Monday … 7 = Sunday.

   Legacy conventions, kept unchanged for backwards compatibility:
   - "saturday0": index.js (`weekday(n)`, `PROFILES[*].weekend`, `opts.weekend`): 0 = Saturday … 6 = Friday.
   - "sunday0":   markets.js (`dow(n)`, profile `weekend`), business.js, locale.js (`weekdayNames`) and
                  kit.config.js, like Date#getUTCDay: 0 = Sunday … 6 = Saturday.
   Convert at the boundary with the functions below; never mix numbers from two conventions. */

export const MONDAY = 1, TUESDAY = 2, WEDNESDAY = 3, THURSDAY = 4, FRIDAY = 5, SATURDAY = 6, SUNDAY = 7;
export const ISO_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

export const WEEKDAY_CONVENTIONS = Object.freeze({
  iso: Object.freeze({ first: 1, description: "ISO 8601: 1 = Monday … 7 = Sunday (canonical; every new API)", legacy: false }),
  sunday0: Object.freeze({ first: 0, description: "0 = Sunday … 6 = Saturday (legacy: markets.js, business.js, locale.js, kit.config.js)", legacy: true }),
  saturday0: Object.freeze({ first: 0, description: "0 = Saturday … 6 = Friday (legacy: index.js weekday(), PROFILES, opts.weekend)", legacy: true }),
});

const mod7 = (x) => ((x % 7) + 7) % 7;
const check = (v, lo, hi, what) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} weekday must be an integer ${lo}–${hi} (got ${JSON.stringify(v)}).`);
  return v;
};

/** ISO weekday (1 = Monday … 7 = Sunday) of an engine day number. 1970-01-01 (day 0) was a Thursday. */
export const isoWeekday = (n) => mod7(n + 3) + 1;

/** Sunday-first (0 = Sunday, legacy markets/business/locale) → ISO. */
export const fromSundayIndex = (d) => { check(d, 0, 6, "Sunday-first"); return d === 0 ? 7 : d; };
/** ISO → Sunday-first (0 = Sunday). */
export const toSundayIndex = (iso) => check(iso, 1, 7, "ISO") % 7;
/** Saturday-first (0 = Saturday, legacy index.js) → ISO. */
export const fromSaturdayIndex = (d) => { check(d, 0, 6, "Saturday-first"); return mod7(d + 5) + 1; };
/** ISO → Saturday-first (0 = Saturday). */
export const toSaturdayIndex = (iso) => mod7(check(iso, 1, 7, "ISO") + 1);

/** Convert a weekday number between conventions: convertWeekday(5, "saturday0", "iso") === 3 (Wednesday). */
export function convertWeekday(v, from, to) {
  if (!(from in WEEKDAY_CONVENTIONS) || !(to in WEEKDAY_CONVENTIONS)) throw new RangeError(`Weekday conventions are ${Object.keys(WEEKDAY_CONVENTIONS).join(", ")}.`);
  const iso = from === "iso" ? check(v, 1, 7, "ISO") : from === "sunday0" ? fromSundayIndex(v) : fromSaturdayIndex(v);
  return to === "iso" ? iso : to === "sunday0" ? toSundayIndex(iso) : toSaturdayIndex(iso);
}

/* ------------------------------------------------------------------ name text */
// Arabic and Persian keyboards type different code points for the same letters: Arabic yeh ي / alef maksura ى vs
// Persian yeh ی, Arabic kaf ك vs Persian keheh ک; digits come in three sets; ZWNJ (U+200C) joins or splits words
// ("سه‌شنبه", "سه شنبه", "سهشنبه"). Names are matched after these are folded.
const ZWNJ = "\u200c";
/** Persian/Arabic text normalised for matching: Persian (۰–۹) and Arabic-Indic (٠–٩) digits → Latin; ي and ى → ی;
 *  ك → ک; bidi marks, ZWJ and tatweel removed; ZWNJ kept once between letters (dropped next to spaces or at
 *  either end); whitespace collapsed. */
export const normalizeText = (s) => String(s ?? "")
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[يى]/g, "ی").replace(/ك/g, "ک")
  .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069\u200d\u0640\ufeff]/g, "")
  .replace(/\s+/g, " ").replace(/\u200c+/g, ZWNJ).replace(/ ?\u200c ?/g, (m) => (m === ZWNJ ? m : " ")).trim()
  .replace(/^\u200c+|\u200c+$/g, "");
/** A lookup key for a month or weekday name: normalizeText, lower case, Arabic alef forms (أ إ آ ٱ) → ا, ة → ه,
 *  and spaces, ZWNJ, hyphens, apostrophes and dots removed. "ربيع الآخر" and "ربیع‌الاخر" share a key. */
export const foldName = (s) => normalizeText(s).toLowerCase()
  .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/[\s\u200c\-‐–'’ʼ`.]/g, "");

const NAMES = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
  "دوشنبه": 1, "سه‌شنبه": 2, "چهارشنبه": 3, "پنجشنبه": 4, "جمعه": 5, "شنبه": 6, "یکشنبه": 7,
  "الاثنين": 1, "الثلاثاء": 2, "الأربعاء": 3, "الخميس": 4, "الجمعة": 5, "السبت": 6, "الأحد": 7,
};
const FOLDED = new Map(Object.entries(NAMES).map(([k, v]) => [foldName(k), v]));
/** An ISO weekday from an ISO number (1–7) or a name in en (long/short), fa or ar; null when unknown. Names match
 *  across Arabic/Persian letter forms, digit sets and ZWNJ/space spellings ("يكشنبه", "سه شنبه", "الإثنين"). */
export function parseWeekday(v) {
  if (Number.isInteger(v)) return v >= 1 && v <= 7 ? v : null;
  const s = normalizeText(v);
  if (/^[1-7]$/.test(s)) return +s;
  return FOLDED.get(foldName(s)) ?? null;
}
