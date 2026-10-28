/* @saasreport/calendar/markets — market profiles: weekend days, holiday rules with their official sources,
   and settlement cycles where an official source states one.

   Days are the engine's day numbers (days since 1970-01-01, UTC). Weekdays in this module count from
   Sunday, like Date#getUTCDay and kit.config.js: 0 = Sunday … 5 = Friday, 6 = Saturday. That is a legacy
   convention kept for compatibility; the canonical one is ISO (1 = Monday … 7 = Sunday, weekday.js), which
   isoDow() and weekendIsoOf() return and every new API (time.js, parse.js) uses.

   Each profile also carries `timeZone` (its default IANA zone for time.js) and `dataVersion` (the version of
   its holiday data); holidayPacks() lists every pack with its sources, checked date and coverage.

   Every holiday derived from the Hijri calendar is `predicted: true`: it is computed from the profile's
   Hijri variant (Umm al-Qura by default) while the authorities fix it by moon sighting or announcement,
   so it can move by a day. registerOfficial() replaces a prediction with the announced dates.

   Holidays on the Chinese lunisolar calendar (chinese.js: Chinese New Year, Dragon Boat, Mid-Autumn) and the Qingming
   solar term are computed from the Hong Kong Observatory's tables and are `predicted` as well: the date is
   astronomical, but the authority decides the break around it each year.

   Published lists. A profile may name the years whose official list was read (`published: { 2026: url }`) and give
   a rule a `table` of that list's dates per year ({ 2026: ["2026-11-10"] }). In a published year such a rule takes
   exactly its table (nothing when the year has no entry: the holiday is not on that list, e.g. on a Sunday), with
   `predicted: false` and the year's source. In other years the rule computes (a Hijri or Chinese date, predicted)
   or, for kind "table" (festivals with no algorithm here, such as Hindu ones), yields nothing.

   Make-up working days. A profile may list weekend days that are working days (`workdays: { 2026: [["2026-02-14",
   "spring-festival"]] }`, China's 调休); business.js counts them as open, and makeUpWorkdays() lists them.

   Verification status (checked 2026-09-30, see `sources` on each profile):
   - "verified":   the fixed and Islamic holidays follow an official list or law that was read.
   - "partial":    an official source was read, but some holidays cannot be computed (lunisolar ones, or
                   break lengths announced every year) and are left out; see `notes`.
   - "unverified": no official list could be read; only the weekend and clearly predicted Islamic
                   holidays are included.
   Iran ("ir", the Iran profile) delegates to the engine in index.js unchanged. */
import * as IR from "./index.js";
import { COPY } from "./copy.js";
import { toHijri, tryFromHijri, hijriYearsOf, hijriMonthLength } from "./hijri.js";
import { fromLunar, qingming as qingmingDay, LUNAR_RANGE } from "./chinese.js";

const DAY = 86400000;
export const CHECKED = "2026-09-30";
export const dow = (n) => (((n + 4) % 7) + 7) % 7; // 0 = Sunday
const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const dayOf = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const dayOfISO = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY);
const gYear = (n) => new Date(n * DAY).getUTCFullYear();

export class MarketError extends Error { constructor(code, message) { super(message); this.code = code; } }

export const PREDICTED_NOTE = {
  en: "Predicted from the Hijri calendar; the date is confirmed by moon sighting or official announcement and may move by a day.",
  ar: "تاريخ متوقع وفق التقويم الهجري؛ يُعتمد برؤية الهلال أو بإعلان رسمي وقد يتغير بيوم واحد.",
};

/** The note on a predicted Chinese-calendar holiday (lunisolar date or solar term). */
export const LUNISOLAR_NOTE = {
  en: "Computed from the Chinese lunisolar calendar (Hong Kong Observatory tables); the official list for the year fixes the holiday and the days around it.",
  ar: "تاريخ محسوب وفق التقويم الصيني القمري الشمسي (جداول مرصد هونغ كونغ)؛ القائمة الرسمية للسنة تحدد العطلة والأيام المحيطة بها.",
};

/* ------------------------------------------------------------------ holiday names */
export const NAMES = {
  "new-year": { en: "New Year's Day", ar: "رأس السنة الميلادية" },
  "eid-al-fitr": { en: "Eid al-Fitr", ar: "عيد الفطر" },
  "eid-al-adha": { en: "Eid al-Adha", ar: "عيد الأضحى" },
  "arafah": { en: "Arafah Day", ar: "يوم عرفة" },
  "islamic-new-year": { en: "Islamic New Year", ar: "رأس السنة الهجرية" },
  "mawlid": { en: "Prophet's Birthday", ar: "المولد النبوي الشريف" },
  "ashura": { en: "Ashura", ar: "عاشوراء" },
  "isra-miraj": { en: "Isra and Mi'raj", ar: "الإسراء والمعراج" },
  "nuzul-quran": { en: "Nuzul al-Quran", ar: "نزول القرآن" },
  "last-friday-ramadan": { en: "Jumu'atul-Wida (last Friday of Ramadan)", ar: "الجمعة اليتيمة" },
  "labour-day": { en: "Labour Day", ar: "عيد العمال" },
  "christmas": { en: "Christmas Day", ar: "عيد الميلاد" },
  "boxing-day": { en: "Boxing Day", ar: "يوم الصناديق" },
  "good-friday": { en: "Good Friday", ar: "الجمعة العظيمة" },
  "easter-monday": { en: "Easter Monday", ar: "اثنين الفصح" },
  "national-day": { en: "National Day", ar: "اليوم الوطني" },
};

/* ------------------------------------------------------------------ rule helpers */
// fixed Gregorian date · nth weekday of a month (n = -1: last) · offset from Western Easter ·
// Hijri date (optionally a span of `days`, or `through` another Hijri date) · last given weekday of a Hijri month ·
// Chinese lunisolar date (lm, ld; `offset` days, e.g. -1 for the eve) · the Qingming solar term · dates from
// published tables only. Any rule may carry `table` (per-year published dates, see above) and `observe` (its own
// substitution: false = none, "instead" = a weekend date moves to the next free weekday, or a profile policy name;
// `observeSince` limits it to dates from then on).
const fixed = (id, month, day, extra = {}) => ({ id, kind: "fixed", month, day, ...extra });
const nth = (id, month, weekday, n, extra = {}) => ({ id, kind: "nth", month, weekday, n, ...extra });
const easter = (id, offset, extra = {}) => ({ id, kind: "easter", offset, ...extra });
const hijri = (id, hm, hd, extra = {}) => ({ id, kind: "hijri", hm, hd, ...extra });
const hijriLastWeekday = (id, hm, weekday, extra = {}) => ({ id, kind: "hijri-last-weekday", hm, weekday, ...extra });
const dates = (id, list, extra = {}) => ({ id, kind: "dates", dates: list, ...extra });
const chinese = (id, lm, ld, extra = {}) => ({ id, kind: "chinese", lm, ld, ...extra });
const qingming = (id, extra = {}) => ({ id, kind: "qingming", ...extra });
const table = (id, tab, extra = {}) => ({ id, kind: "table", table: tab, ...extra });

/* ------------------------------------------------------------------ markets */
const SRC = {
  ae: "https://u.ae/en/information-and-services/public-holidays-and-religious-affairs/public-holidays",
  aeWeekend: "https://www.mediaoffice.abudhabi/en/government-affairs/abu-dhabi-government-adopts-changing-weekly-work-system-to-make-the-weekend-saturday-sunday-and-friday-half-working-day/",
  sa: "https://saudipedia.com/en/official-holidays-in-saudi-arabia",
  bh: "https://www.cbb.gov.bh/official-bank-holidays/",
  om: "https://decree.om/2022/rd20220088/",
  om2025: "https://decree.om/2025/rd20250015/",
  my: "https://www.bnm.gov.my/upcoming-events",
  pk: "https://www.psx.com.pk/psx/exchange/general/calendar-holidays",
  tr: "https://www.mevzuat.gov.tr/mevzuat?MevzuatNo=2429&MevzuatTur=1&MevzuatTertip=5",
  uk: "https://www.gov.uk/bank-holidays.json",
  ukT1: "https://www.gov.uk/government/publications/accelerated-settlement-t1",
  us: "https://www.federalreserve.gov/aboutthefed/k8.htm",
  usT1: "https://www.federalregister.gov/documents/2023/03/06/2023-03566/shortening-the-securities-transaction-settlement-cycle",
  eu: "https://www.ecb.europa.eu/paym/target/t2/html/index.en.html",
  euT1: "https://www.esma.europa.eu/esmas-activities/markets-and-infrastructure/shortening-settlement-cycle-t1-eu",
  // Asia-Pacific (read 2026-10-01)
  in: "https://www.rbi.org.in/Scripts/HolidayMatrixDisplay.aspx",
  cnRules: "https://www.gov.cn/zhengce/content/202411/content_6986380.htm",
  cn2025: "https://www.gov.cn/zhengce/content/202411/content_6986382.htm",
  cn2026: "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
  sg: "https://www.mom.gov.sg/employment-practices/public-holidays",
  au: "https://www.nsw.gov.au/about-nsw/public-holidays",
  au2024: "https://www.nsw.gov.au/sites/default/files/noindex/2024-08/NSW-Public-Holiday-Guide-2024-2025-2026.pdf",
  au2021: "https://www.nsw.gov.au/sites/default/files/noindex/2024-08/NSW-Public-Holidays-2021-2023.pdf",
  hko: "https://www.hko.gov.hk/en/gts/time/conversion.htm",
};
// Consecutive ISO dates from `from`, `n` of them (published breaks).
const run = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10));
const APAC_CHECKED = "2026-10-01";

const MARKETS = {
  sa: {
    id: "sa", name: { en: "Saudi Arabia", ar: "المملكة العربية السعودية" }, currency: "SAR", timezone: "Asia/Riyadh",
    weekend: [5, 6], hijri: "umalqura", status: "partial",
    sources: [{ title: "Saudipedia: Official holidays in Saudi Arabia (weekend, Founding Day, National Day, Eid rules)", url: SRC.sa }],
    notes: [
      "Weekend Friday–Saturday since June 2013 (before that Thursday–Friday); earlier dates use the current weekend.",
      "Eid breaks are set each year (at least four working days for each Eid); only the Eid day itself is included, as a prediction. my.gov.sa and SAMA could not be read (bot protection), so the bank Eid break is not modelled.",
    ],
    holidays: [
      fixed("founding-day", 2, 22, { name: { en: "Founding Day", ar: "يوم التأسيس" }, since: "2022-01-27", source: SRC.sa }),
      fixed("national-day", 9, 23, { name: { en: "Saudi National Day", ar: "اليوم الوطني السعودي" }, source: SRC.sa }),
      hijri("eid-al-fitr", 10, 1, { source: SRC.sa }),
      hijri("eid-al-adha", 12, 10, { source: SRC.sa }),
    ],
  },
  ae: {
    id: "ae", name: { en: "United Arab Emirates", ar: "الإمارات العربية المتحدة" }, currency: "AED", timezone: "Asia/Dubai",
    weekend: [{ from: "2022-01-01", days: [6, 0] }, { days: [5, 6] }], hijri: "umalqura", status: "verified",
    sources: [
      { title: "u.ae: Public holidays (public and private sectors); Cabinet Resolution No. 27 of 2024", url: SRC.ae },
      { title: "Abu Dhabi Media Office: weekend becomes Saturday–Sunday (from 1 January 2022)", url: SRC.aeWeekend },
    ],
    notes: [
      "Saturday–Sunday weekend from 1 January 2022 (government; Friday is a half working day). Friday–Saturday before.",
      "Holidays are not moved when they fall on the weekend or on another holiday (Cabinet Resolution No. 27 of 2024, Art. 3).",
      "30 Ramadan is a holiday only when Ramadan has 30 days; the prediction follows the Umm al-Qura month length.",
    ],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.ae }),
      hijri("eid-al-fitr-30-ramadan", 9, 30, { name: { en: "Eid al-Fitr (30 Ramadan)", ar: "عطلة عيد الفطر (30 رمضان)" }, source: SRC.ae }),
      hijri("eid-al-fitr", 10, 1, { days: 3, source: SRC.ae }),
      hijri("arafah", 12, 9, { source: SRC.ae }),
      hijri("eid-al-adha", 12, 10, { days: 3, source: SRC.ae }),
      hijri("islamic-new-year", 1, 1, { source: SRC.ae }),
      hijri("mawlid", 3, 12, { source: SRC.ae }),
      fixed("national-day", 12, 2, { days: 2, name: { en: "National Day", ar: "عيد الاتحاد" }, source: SRC.ae }),
    ],
  },
  bh: {
    id: "bh", name: { en: "Bahrain", ar: "مملكة البحرين" }, currency: "BHD", timezone: "Asia/Bahrain",
    weekend: [5, 6], hijri: "umalqura", status: "verified",
    sources: [{ title: "Central Bank of Bahrain: Official Bank Holidays", url: SRC.bh }],
    notes: ["Bank holidays as published by the CBB. The Friday–Saturday weekend is not stated on that page."],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.bh }),
      fixed("labour-day", 5, 1, { source: SRC.bh }),
      fixed("national-day", 12, 16, { days: 2, source: SRC.bh }),
      hijri("eid-al-fitr", 10, 1, { days: 3, source: SRC.bh }),
      hijri("eid-al-adha", 12, 10, { days: 3, source: SRC.bh }),
      hijri("islamic-new-year", 1, 1, { source: SRC.bh }),
      hijri("ashura", 1, 9, { days: 2, source: SRC.bh }),
      hijri("mawlid", 3, 12, { source: SRC.bh }),
    ],
  },
  qa: {
    id: "qa", name: { en: "Qatar", ar: "دولة قطر" }, currency: "QAR", timezone: "Asia/Qatar",
    weekend: [5, 6], hijri: "umalqura", status: "unverified", sources: [],
    notes: ["hukoomi.gov.qa and qcb.gov.qa could not be read (bot protection / TLS); only the weekend and the two Eid days (predicted) are included."],
    holidays: [hijri("eid-al-fitr", 10, 1), hijri("eid-al-adha", 12, 10)],
  },
  kw: {
    id: "kw", name: { en: "Kuwait", ar: "دولة الكويت" }, currency: "KWD", timezone: "Asia/Kuwait",
    weekend: [5, 6], hijri: "umalqura", status: "unverified", sources: [],
    notes: ["csc.gov.kw and e.gov.kw publish no readable holiday list; only the weekend and predicted Islamic holidays are included."],
    holidays: [hijri("eid-al-fitr", 10, 1), hijri("eid-al-adha", 12, 10), hijri("islamic-new-year", 1, 1), hijri("mawlid", 3, 12)],
  },
  om: {
    id: "om", name: { en: "Oman", ar: "سلطنة عُمان" }, currency: "OMR", timezone: "Asia/Muscat",
    weekend: [5, 6], hijri: "umalqura", status: "verified",
    sources: [
      { title: "Royal Decree 88/2022 determining the official holidays (English text, Decree.om)", url: SRC.om },
      { title: "Royal Decree 15/2025 moving National Day to 20–21 November (English text, Decree.om)", url: SRC.om2025 },
    ],
    notes: [
      "Rules of Royal Decree 88/2022 as amended by Royal Decree 15/2025; the official text is the Arabic Official Gazette.",
      "The decree compensates a weekend day that falls within the holidays with one day, and Friday on the first day of an Eid; those compensation days are announced and not modelled.",
    ],
    holidays: [
      hijri("islamic-new-year", 1, 1, { source: SRC.om }),
      hijri("mawlid", 3, 12, { source: SRC.om }),
      hijri("isra-miraj", 7, 27, { source: SRC.om }),
      fixed("national-day", 11, 18, { days: 2, until: "2024-12-31", source: SRC.om }),
      fixed("national-day", 11, 20, { days: 2, since: "2025-01-21", source: SRC.om2025 }),
      fixed("accession-day", 1, 11, { name: { en: "Sultan's Accession Day", ar: "ذكرى تولي السلطان مقاليد الحكم" }, since: "2023-01-01", source: SRC.om }),
      hijri("eid-al-fitr", 9, 29, { through: [10, 3], source: SRC.om }),
      hijri("eid-al-adha", 12, 9, { through: [12, 12], source: SRC.om }),
    ],
  },
  my: {
    id: "my", name: { en: "Malaysia (Kuala Lumpur)", ar: "ماليزيا (كوالالمبور)" }, currency: "MYR", timezone: "Asia/Kuala_Lumpur",
    weekend: [6, 0], hijri: "umalqura", status: "partial", observe: "sunday-next",
    sources: [{ title: "Bank Negara Malaysia: holidays observed by the BNM Head Office, Kuala Lumpur", url: SRC.my }],
    notes: [
      "Federal Territory of Kuala Lumpur (BNM Head Office). Kedah, Kelantan and Terengganu keep a Friday–Saturday weekend and different holidays.",
      "Thaipusam, Chinese New Year, Wesak and Deepavali follow lunisolar calendars and are announced by the Prime Minister's Department each year; they are not included.",
      "A holiday on Sunday moves to the next working day (Holidays Act 1951, s.3).",
    ],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.my }),
      fixed("federal-territory-day", 2, 1, { name: { en: "Federal Territory Day", ar: "يوم الإقليم الاتحادي" }, source: SRC.my }),
      fixed("labour-day", 5, 1, { source: SRC.my }),
      nth("agong-birthday", 6, 1, 1, { name: { en: "Birthday of the Yang di-Pertuan Agong", ar: "عيد ميلاد الملك" }, since: "2020-01-01", source: SRC.my }),
      fixed("national-day", 8, 31, { source: SRC.my }),
      fixed("malaysia-day", 9, 16, { name: { en: "Malaysia Day", ar: "يوم ماليزيا" }, source: SRC.my }),
      fixed("christmas", 12, 25, { source: SRC.my }),
      hijri("nuzul-quran", 9, 17, { source: SRC.my }),
      hijri("eid-al-fitr", 10, 1, { days: 2, source: SRC.my }),
      hijri("eid-al-adha", 12, 10, { source: SRC.my }),
      hijri("islamic-new-year", 1, 1, { source: SRC.my }),
      hijri("mawlid", 3, 12, { source: SRC.my }),
    ],
  },
  id: {
    id: "id", name: { en: "Indonesia", ar: "إندونيسيا" }, currency: "IDR", timezone: "Asia/Jakarta",
    weekend: [6, 0], hijri: "umalqura", status: "unverified", sources: [],
    notes: ["The yearly joint ministerial decree (SKB 3 Menteri) could not be read from an official site (kemenkopmk.go.id, bi.go.id and idx.co.id refused the connection); only the weekend and predicted Islamic holidays are included."],
    holidays: [hijri("eid-al-fitr", 10, 1), hijri("eid-al-adha", 12, 10), hijri("islamic-new-year", 1, 1), hijri("mawlid", 3, 12)],
  },
  pk: {
    id: "pk", name: { en: "Pakistan", ar: "باكستان" }, currency: "PKR", timezone: "Asia/Karachi",
    weekend: [6, 0], hijri: "umalqura", status: "verified",
    sources: [{ title: "Pakistan Stock Exchange: calendar holidays", url: SRC.pk }],
    notes: [
      "Holidays of the Pakistan Stock Exchange. Islamic dates are fixed by the Ruet-e-Hilal committee and are often a day after Umm al-Qura (PSX 2026: Eid-ul-Fitr 21–23 March); register the announced dates with registerOfficial().",
    ],
    holidays: [
      fixed("kashmir-day", 2, 5, { name: { en: "Kashmir Day", ar: "يوم كشمير" }, source: SRC.pk }),
      fixed("pakistan-day", 3, 23, { name: { en: "Pakistan Day", ar: "يوم باكستان" }, source: SRC.pk }),
      fixed("labour-day", 5, 1, { source: SRC.pk }),
      fixed("youm-e-takbeer", 5, 28, { name: { en: "Youm-e-Takbeer", ar: "يوم التكبير" }, since: "2024-01-01", source: SRC.pk }),
      fixed("independence-day", 8, 14, { name: { en: "Independence Day", ar: "يوم الاستقلال" }, source: SRC.pk }),
      fixed("iqbal-day", 11, 9, { name: { en: "Allama Iqbal Day", ar: "يوم إقبال" }, source: SRC.pk }),
      fixed("quaid-day", 12, 25, { name: { en: "Quaid-e-Azam Day / Christmas", ar: "يوم القائد الأعظم" }, source: SRC.pk }),
      hijriLastWeekday("last-friday-ramadan", 9, 5, { source: SRC.pk }),
      hijri("eid-al-fitr", 10, 1, { days: 3, source: SRC.pk }),
      hijri("eid-al-adha", 12, 10, { days: 3, source: SRC.pk }),
      hijri("ashura", 1, 9, { days: 2, source: SRC.pk }),
      hijri("mawlid", 3, 12, { source: SRC.pk }),
    ],
  },
  tr: {
    id: "tr", name: { en: "Türkiye", ar: "تركيا" }, currency: "TRY", timezone: "Europe/Istanbul",
    weekend: [6, 0], hijri: "umalqura", status: "verified",
    sources: [{ title: "Law No. 2429 on national holidays and general holidays (Mevzuat)", url: SRC.tr }],
    notes: [
      "The eves (arefe) of both Bayrams and 28 October are half days from 13:00; they are marked `half: true` and stay business days.",
      "Türkiye sets religious holidays by the Diyanet's calculated calendar, which can differ from Umm al-Qura by a day.",
    ],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.tr }),
      fixed("sovereignty-day", 4, 23, { name: { en: "National Sovereignty and Children's Day", ar: "عيد السيادة الوطنية والطفل" }, source: SRC.tr }),
      fixed("labour-day", 5, 1, { name: { en: "Labour and Solidarity Day", ar: "عيد العمل والتضامن" }, source: SRC.tr }),
      fixed("youth-day", 5, 19, { name: { en: "Commemoration of Atatürk, Youth and Sports Day", ar: "يوم إحياء ذكرى أتاتورك والشباب والرياضة" }, source: SRC.tr }),
      fixed("democracy-day", 7, 15, { name: { en: "Democracy and National Unity Day", ar: "يوم الديمقراطية والوحدة الوطنية" }, since: "2017-01-01", source: SRC.tr }),
      fixed("victory-day", 8, 30, { name: { en: "Victory Day", ar: "عيد النصر" }, source: SRC.tr }),
      fixed("republic-day-eve", 10, 28, { half: true, name: { en: "Republic Day eve (from 13:00)", ar: "عشية عيد الجمهورية (من الساعة 13:00)" }, source: SRC.tr }),
      fixed("republic-day", 10, 29, { name: { en: "Republic Day", ar: "عيد الجمهورية" }, source: SRC.tr }),
      hijri("eid-al-fitr-eve", 9, "last", { half: true, name: { en: "Ramadan Bayramı eve (from 13:00)", ar: "وقفة عيد الفطر (من الساعة 13:00)" }, source: SRC.tr }),
      hijri("eid-al-fitr", 10, 1, { days: 3, name: { en: "Ramadan Bayramı", ar: "عيد الفطر" }, source: SRC.tr }),
      hijri("eid-al-adha-eve", 12, 9, { half: true, name: { en: "Kurban Bayramı eve (from 13:00)", ar: "وقفة عيد الأضحى (من الساعة 13:00)" }, source: SRC.tr }),
      hijri("eid-al-adha", 12, 10, { days: 4, name: { en: "Kurban Bayramı", ar: "عيد الأضحى" }, source: SRC.tr }),
    ],
  },
  uk: {
    id: "uk", name: { en: "United Kingdom (England and Wales)", ar: "المملكة المتحدة (إنجلترا وويلز)" }, currency: "GBP", timezone: "Europe/London",
    weekend: [6, 0], status: "verified", observe: "substitute",
    sources: [{ title: "GOV.UK bank holidays (England and Wales)", url: SRC.uk }, { title: "HM Treasury: Accelerated Settlement (T+1)", url: SRC.ukT1 }],
    notes: ["England and Wales; Scotland and Northern Ireland have other bank holidays. A holiday on a weekend gets a substitute weekday. One-off holidays are listed from GOV.UK."],
    settlement: [{ t: 2, scope: "securities", source: SRC.ukT1 }, { t: 1, from: "2027-10-11", scope: "securities", source: SRC.ukT1 }],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.uk }),
      easter("good-friday", -2, { source: SRC.uk }),
      easter("easter-monday", 1, { source: SRC.uk }),
      nth("early-may", 5, 1, 1, { name: { en: "Early May bank holiday", ar: "عطلة مطلع مايو" }, except: ["2020"], source: SRC.uk }),
      nth("spring", 5, 1, -1, { name: { en: "Spring bank holiday", ar: "عطلة الربيع" }, except: ["2022"], source: SRC.uk }),
      nth("summer", 8, 1, -1, { name: { en: "Summer bank holiday", ar: "عطلة الصيف" }, source: SRC.uk }),
      fixed("christmas", 12, 25, { source: SRC.uk }),
      fixed("boxing-day", 12, 26, { source: SRC.uk }),
      dates("one-off", [
        ["2020-05-08", "Early May bank holiday (VE day)", "عطلة مطلع مايو (يوم النصر في أوروبا)"], ["2022-06-02", "Spring bank holiday", "عطلة الربيع"],
        ["2022-06-03", "Platinum Jubilee bank holiday", "عطلة اليوبيل البلاتيني"], ["2022-09-19", "Bank Holiday for the State Funeral of Queen Elizabeth II", "عطلة الجنازة الرسمية للملكة إليزابيث الثانية"],
        ["2023-05-08", "Bank holiday for the coronation of King Charles III", "عطلة تتويج الملك تشارلز الثالث"],
      ], { source: SRC.uk }),
    ],
  },
  us: {
    id: "us", name: { en: "United States (Federal Reserve)", ar: "الولايات المتحدة (الاحتياطي الفيدرالي)" }, currency: "USD", timezone: "America/New_York",
    weekend: [6, 0], status: "verified", observe: "fed",
    sources: [{ title: "Federal Reserve K.8: Holidays observed by the Federal Reserve System", url: SRC.us }, { title: "SEC: Shortening the securities transaction settlement cycle (T+1)", url: SRC.usT1 }],
    notes: ["Federal Reserve Banks: a holiday on Sunday is observed on Monday; on Saturday the Banks are open the Friday before (only the Board closes)."],
    settlement: [{ t: 2, scope: "securities", source: SRC.usT1 }, { t: 1, from: "2024-05-28", scope: "securities", source: SRC.usT1 }],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.us }),
      nth("mlk-day", 1, 1, 3, { name: { en: "Birthday of Martin Luther King, Jr.", ar: "ذكرى ميلاد مارتن لوثر كينغ" }, source: SRC.us }),
      nth("washington-birthday", 2, 1, 3, { name: { en: "Washington's Birthday", ar: "ذكرى ميلاد واشنطن" }, source: SRC.us }),
      nth("memorial-day", 5, 1, -1, { name: { en: "Memorial Day", ar: "يوم الذكرى" }, source: SRC.us }),
      fixed("juneteenth", 6, 19, { name: { en: "Juneteenth National Independence Day", ar: "يوم جونتينث" }, since: "2022-01-01", source: SRC.us }),
      fixed("independence-day", 7, 4, { name: { en: "Independence Day", ar: "يوم الاستقلال" }, source: SRC.us }),
      nth("labor-day", 9, 1, 1, { name: { en: "Labor Day", ar: "عيد العمال" }, source: SRC.us }),
      nth("columbus-day", 10, 1, 2, { name: { en: "Columbus Day", ar: "يوم كولومبوس" }, source: SRC.us }),
      fixed("veterans-day", 11, 11, { name: { en: "Veterans Day", ar: "يوم المحاربين القدامى" }, source: SRC.us }),
      nth("thanksgiving", 11, 4, 4, { name: { en: "Thanksgiving Day", ar: "عيد الشكر" }, source: SRC.us }),
      fixed("christmas", 12, 25, { source: SRC.us }),
    ],
  },
  eu: {
    id: "eu", name: { en: "Euro area (T2)", ar: "منطقة اليورو (T2)" }, currency: "EUR", timezone: "Europe/Frankfurt",
    weekend: [6, 0], status: "verified",
    sources: [{ title: "ECB: T2 opening days", url: SRC.eu }, { title: "ESMA: shortening the settlement cycle to T+1 in the EU", url: SRC.euT1 }],
    notes: ["T2 closing days for euro settlement; national holidays of euro-area countries are not included."],
    settlement: [{ t: 2, scope: "securities", source: SRC.euT1 }, { t: 1, from: "2027-10-11", scope: "securities", source: SRC.euT1 }],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.eu }),
      easter("good-friday", -2, { source: SRC.eu }),
      easter("easter-monday", 1, { source: SRC.eu }),
      fixed("labour-day", 5, 1, { source: SRC.eu }),
      fixed("christmas", 12, 25, { source: SRC.eu }),
      fixed("boxing-day", 12, 26, { name: { en: "26 December", ar: "26 ديسمبر" }, source: SRC.eu }),
    ],
  },
  in: {
    id: "in", name: { en: "India (Mumbai, RBI NI Act bank holidays)", ar: "الهند (مومباي، عطل البنوك)" }, currency: "INR", timezone: "Asia/Kolkata",
    weekend: [6, 0], hijri: "umalqura", status: "partial", checked: APAC_CHECKED,
    published: { 2025: SRC.in, 2026: SRC.in },
    sources: [{ title: "Reserve Bank of India: holidays of the Mumbai regional office under the Negotiable Instruments Act (2025, 2026)", url: SRC.in }],
    notes: [
      "Bank holidays in Mumbai under the Negotiable Instruments Act, as listed by the RBI for its Mumbai regional office. Central government offices in Delhi (DoPT list) are a different calendar and not modelled.",
      "Banks also close on the second and fourth Saturdays; financial markets keep a Saturday–Sunday weekend, which is the weekend here.",
      "The RBI lists only holidays that fall on working days; a holiday on a Sunday or a second or fourth Saturday is not on its list and not shown.",
      "Hindu, Jain, Sikh, Buddhist and Parsi festivals (Holi, Gudhi Padwa, Ram Navami, Mahavir Jayanti, Buddha Pournima, Ganesh Chaturthi, Dasara, Diwali, Guru Nanak Jayanti and others) are shown only for 2025 and 2026, the years of the RBI lists; later years have no data for them until the RBI publishes its list.",
      "Islamic holidays after 2026 are predicted from Umm al-Qura; in India they are often a day later (2026: Ramzan-Id 21 March, Bakri Id 28 May).",
    ],
    holidays: [
      fixed("republic-day", 1, 26, { name: { en: "Republic Day", ar: "يوم الجمهورية" }, source: SRC.in }),
      fixed("shivaji-jayanti", 2, 19, { name: { en: "Chhatrapati Shivaji Maharaj Jayanti", ar: "ذكرى ميلاد شيفاجي ماهاراج" }, source: SRC.in }),
      fixed("annual-closing", 4, 1, { name: { en: "Annual closing of bank accounts", ar: "الإقفال السنوي لحسابات البنوك" }, source: SRC.in }),
      fixed("ambedkar-jayanti", 4, 14, { name: { en: "Dr. Babasaheb Ambedkar Jayanti", ar: "ذكرى ميلاد أمبيدكار" }, source: SRC.in }),
      fixed("maharashtra-day", 5, 1, { name: { en: "Maharashtra Din (Maharashtra Day)", ar: "يوم ماهاراشترا" }, source: SRC.in }),
      fixed("independence-day", 8, 15, { name: { en: "Independence Day", ar: "يوم الاستقلال" }, source: SRC.in }),
      fixed("gandhi-jayanti", 10, 2, { name: { en: "Mahatma Gandhi Jayanti", ar: "ذكرى ميلاد المهاتما غاندي" }, source: SRC.in }),
      fixed("christmas", 12, 25, { source: SRC.in }),
      easter("good-friday", -2, { source: SRC.in }),
      hijri("eid-al-fitr", 10, 1, { name: { en: "Ramzan-Id (Id-ul-Fitr)", ar: "عيد الفطر" }, table: { 2025: ["2025-03-31"], 2026: ["2026-03-21"] }, source: SRC.in }),
      hijri("eid-al-adha", 12, 10, { name: { en: "Bakri Id (Id-uz-Zuha)", ar: "عيد الأضحى" }, table: { 2025: ["2025-06-07"], 2026: ["2026-05-28"] }, source: SRC.in }),
      hijri("muharram", 1, 10, { name: { en: "Muharram", ar: "عاشوراء" }, table: { 2026: ["2026-06-26"] }, source: SRC.in }),
      hijri("mawlid", 3, 12, { name: { en: "Id-e-Milad", ar: "المولد النبوي الشريف" }, table: { 2025: ["2025-09-08"], 2026: ["2026-08-26"] }, source: SRC.in }),
      table("mahashivratri", { 2025: ["2025-02-26"] }, { name: { en: "Mahashivratri", ar: "ماها شيفاراتري" }, source: SRC.in }),
      table("holi", { 2025: ["2025-03-14"], 2026: ["2026-03-03"] }, { name: { en: "Holi (second day)", ar: "هولي (اليوم الثاني)" }, source: SRC.in }),
      table("gudhi-padwa", { 2026: ["2026-03-19"] }, { name: { en: "Gudhi Padwa", ar: "غودي بادوا" }, source: SRC.in }),
      table("ram-navami", { 2026: ["2026-03-26"] }, { name: { en: "Shree Ram Navami", ar: "رام نافامي" }, source: SRC.in }),
      table("mahavir-jayanti", { 2025: ["2025-04-10"], 2026: ["2026-03-31"] }, { name: { en: "Mahavir Janmakalyanak (Mahavir Jayanti)", ar: "ذكرى ميلاد ماهافير" }, source: SRC.in }),
      table("buddha-pournima", { 2025: ["2025-05-12"], 2026: ["2026-05-01"] }, { name: { en: "Buddha Pournima", ar: "بوذا بورنيما" }, source: SRC.in }),
      table("parsi-new-year", { 2025: ["2025-08-15"], 2026: ["2026-08-15"] }, { name: { en: "Parsi New Year (Shahenshahi)", ar: "رأس السنة البارسية" }, source: SRC.in }),
      table("ganesh-chaturthi", { 2025: ["2025-08-27"], 2026: ["2026-09-14"] }, { name: { en: "Ganesh Chaturthi", ar: "غانيش تشاتورثي" }, source: SRC.in }),
      table("dasara", { 2025: ["2025-10-02"], 2026: ["2026-10-20"] }, { name: { en: "Dasara (Vijaya Dashami)", ar: "دسهرا (فيجايا داشامي)" }, source: SRC.in }),
      table("diwali-laxmi-pujan", { 2025: ["2025-10-21"] }, { name: { en: "Diwali Amavasya (Laxmi Pujan)", ar: "ديوالي (لاكشمي بوجان)" }, source: SRC.in }),
      table("diwali-bali-pratipada", { 2025: ["2025-10-22"], 2026: ["2026-11-10"] }, { name: { en: "Diwali (Bali Pratipada)", ar: "ديوالي (بالي براتيبادا)" }, source: SRC.in }),
      table("guru-nanak-jayanti", { 2025: ["2025-11-05"], 2026: ["2026-11-24"] }, { name: { en: "Guru Nanak Jayanti", ar: "ذكرى ميلاد غورو ناناك" }, source: SRC.in }),
      dates("one-off", [["2026-01-15", "Makar Sankranti; elections to municipal corporations in Maharashtra", "ماكار سانكرانتي؛ انتخابات المجالس البلدية في ماهاراشترا"]], { source: SRC.in }),
    ],
  },
  cn: {
    id: "cn", name: { en: "China (mainland)", ar: "الصين", zh: "中国大陆" }, currency: "CNY", timezone: "Asia/Shanghai",
    weekend: [6, 0], status: "partial", checked: APAC_CHECKED,
    published: { 2025: SRC.cn2025, 2026: SRC.cn2026 },
    sources: [
      { title: "国务院关于修改《全国年节及纪念日放假办法》的决定 (State Council Decree No. 795, in force 1 January 2025)", url: SRC.cnRules },
      { title: "国务院办公厅关于2025年部分节假日安排的通知 (State Council General Office: 2025 holiday arrangements)", url: SRC.cn2025 },
      { title: "国务院办公厅关于2026年部分节假日安排的通知 (State Council General Office: 2026 holiday arrangements)", url: SRC.cn2026 },
      { title: "Hong Kong Observatory: Gregorian–lunar calendar conversion tables (lunar dates and Qingming)", url: SRC.hko },
    ],
    notes: [
      "2025 and 2026: every day off and every make-up working day (调休) from the State Council General Office's notice for the year.",
      "Other years from 2025: only the statutory days of the 2024 regulation (New Year's Day; Spring Festival eve to the third day; Qingming; 1–2 May; Dragon Boat; Mid-Autumn; 1–3 October). The bridge days, the make-up working days and the weekday given for a statutory day on a weekend are announced each year (usually in November) and are not modelled until then, so business days in those years are not final.",
      "Spring Festival, Qingming, Dragon Boat and Mid-Autumn outside the published years are computed from the Hong Kong Observatory's lunar tables and marked expected.",
      "Years before 2025 (the earlier regulation) have no data.",
    ],
    holidays: [
      fixed("new-year", 1, 1, { name: { en: "New Year's Day", ar: "رأس السنة الميلادية", zh: "元旦" }, since: "2025-01-01", source: SRC.cnRules,
        table: { 2025: ["2025-01-01"], 2026: run("2026-01-01", 3) } }),
      chinese("spring-festival", 1, 1, { offset: -1, days: 4, name: { en: "Spring Festival", ar: "عيد الربيع (رأس السنة الصينية)", zh: "春节" }, since: "2025-01-01", source: SRC.cnRules,
        table: { 2025: run("2025-01-28", 8), 2026: run("2026-02-15", 9) } }),
      qingming("qingming", { name: { en: "Qingming Festival", ar: "مهرجان تشينغمينغ", zh: "清明节" }, since: "2025-01-01", source: SRC.cnRules,
        table: { 2025: run("2025-04-04", 3), 2026: run("2026-04-04", 3) } }),
      fixed("labour-day", 5, 1, { days: 2, name: { en: "Labour Day", ar: "عيد العمال", zh: "劳动节" }, since: "2025-01-01", source: SRC.cnRules,
        table: { 2025: run("2025-05-01", 5), 2026: run("2026-05-01", 5) } }),
      chinese("dragon-boat", 5, 5, { name: { en: "Dragon Boat Festival", ar: "مهرجان قوارب التنين", zh: "端午节" }, since: "2025-01-01", source: SRC.cnRules,
        table: { 2025: run("2025-05-31", 3), 2026: run("2026-06-19", 3) } }),
      chinese("mid-autumn", 8, 15, { name: { en: "Mid-Autumn Festival", ar: "مهرجان منتصف الخريف", zh: "中秋节" }, since: "2025-01-01", source: SRC.cnRules,
        table: { 2025: ["2025-10-06"], 2026: run("2026-09-25", 3) } }),
      fixed("national-day", 10, 1, { days: 3, name: { en: "National Day", ar: "اليوم الوطني", zh: "国庆节" }, since: "2025-01-01", source: SRC.cnRules,
        table: { 2025: run("2025-10-01", 8).filter((d) => d !== "2025-10-06"), 2026: run("2026-10-01", 7) } }),
    ],
    workdays: {
      2025: [["2025-01-26", "spring-festival"], ["2025-02-08", "spring-festival"], ["2025-04-27", "labour-day"], ["2025-09-28", "national-day"], ["2025-10-11", "national-day"]],
      2026: [["2026-01-04", "new-year"], ["2026-02-14", "spring-festival"], ["2026-02-28", "spring-festival"], ["2026-05-09", "labour-day"], ["2026-09-20", "national-day"], ["2026-10-10", "national-day"]],
    },
  },
  sg: {
    id: "sg", name: { en: "Singapore", ar: "سنغافورة" }, currency: "SGD", timezone: "Asia/Singapore",
    weekend: [6, 0], hijri: "umalqura", status: "partial", observe: "sunday-next", checked: APAC_CHECKED,
    published: { 2025: SRC.sg, 2026: SRC.sg, 2027: SRC.sg },
    sources: [
      { title: "Ministry of Manpower: public holidays (2025, 2026, 2027)", url: SRC.sg },
      { title: "Hong Kong Observatory: Gregorian–lunar calendar conversion tables (Chinese New Year after 2027)", url: SRC.hko },
    ],
    notes: [
      "Public holidays gazetted under the Holidays Act, as listed by the Ministry of Manpower. A holiday on a Sunday makes the next Monday a public holiday.",
      "After 2027: Chinese New Year is computed from the Hong Kong Observatory's lunar tables and Hari Raya Puasa and Hari Raya Haji are predicted from Umm al-Qura (MUIS can differ by a day: 2026 Hari Raya Puasa was 21 March); all are marked expected.",
      "Vesak Day and Deepavali are shown only for 2025–2027, the years of the published list; later years have no data for them until the list is published.",
    ],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.sg }),
      chinese("chinese-new-year", 1, 1, { days: 2, name: { en: "Chinese New Year", ar: "رأس السنة الصينية" }, source: SRC.sg,
        table: { 2025: ["2025-01-29", "2025-01-30"], 2026: ["2026-02-17", "2026-02-18"], 2027: ["2027-02-06", "2027-02-07"] } }),
      hijri("eid-al-fitr", 10, 1, { name: { en: "Hari Raya Puasa", ar: "عيد الفطر" }, source: SRC.sg, table: { 2025: ["2025-03-31"], 2026: ["2026-03-21"], 2027: ["2027-03-10"] } }),
      easter("good-friday", -2, { source: SRC.sg }),
      fixed("labour-day", 5, 1, { source: SRC.sg }),
      table("vesak-day", { 2025: ["2025-05-12"], 2026: ["2026-05-31"], 2027: ["2027-05-20"] }, { name: { en: "Vesak Day", ar: "يوم فيساك" }, source: SRC.sg }),
      hijri("eid-al-adha", 12, 10, { name: { en: "Hari Raya Haji", ar: "عيد الأضحى" }, source: SRC.sg, table: { 2025: ["2025-06-07"], 2026: ["2026-05-27"], 2027: ["2027-05-17"] } }),
      fixed("national-day", 8, 9, { source: SRC.sg }),
      table("deepavali", { 2025: ["2025-10-20"], 2026: ["2026-11-08"], 2027: ["2027-10-28"] }, { name: { en: "Deepavali", ar: "ديبافالي" }, source: SRC.sg }),
      fixed("christmas", 12, 25, { source: SRC.sg }),
      dates("one-off", [["2025-05-03", "Polling Day", "يوم الاقتراع"]], { source: SRC.sg }),
    ],
  },
  au: {
    id: "au", name: { en: "Australia (New South Wales)", ar: "أستراليا (نيو ساوث ويلز)" }, currency: "AUD", timezone: "Australia/Sydney",
    weekend: [6, 0], status: "verified", observe: "substitute", checked: APAC_CHECKED,
    sources: [
      { title: "NSW Government: NSW public holidays 2026 to 2027 (Public Holidays Act 2010)", url: SRC.au },
      { title: "NSW Guide to Public Holidays 2024, 2025 and 2026", url: SRC.au2024 },
      { title: "NSW Public Holidays 2021–2023", url: SRC.au2021 },
    ],
    notes: [
      "Standard public holidays of New South Wales (Sydney), which include the national days, plus the Bank Holiday on the first Monday of August: not a public holiday, but retail banks and certain financial institutions must close.",
      "New Year's Day, Christmas Day and Boxing Day on a weekend give an additional day on the following Monday or Tuesday. Australia Day on a weekend moves to the following Monday. Easter Saturday and Easter Sunday are public holidays with no additional day.",
      "Anzac Day on a weekend gives an additional day on the following Monday from 2026, as on the NSW 2026–2027 list; until 2025 it had none (NSW guide 2024–2026).",
      "Local public holidays, local event days and one-off holidays (such as the National Day of Mourning on 22 September 2022) are not included.",
    ],
    holidays: [
      fixed("new-year", 1, 1, { source: SRC.au }),
      fixed("australia-day", 1, 26, { name: { en: "Australia Day", ar: "يوم أستراليا" }, observe: "instead", source: SRC.au }),
      easter("good-friday", -2, { source: SRC.au }),
      easter("easter-saturday", -1, { name: { en: "Easter Saturday", ar: "سبت الفصح" }, observe: false, source: SRC.au }),
      easter("easter-sunday", 0, { name: { en: "Easter Sunday", ar: "أحد الفصح" }, observe: false, source: SRC.au }),
      easter("easter-monday", 1, { source: SRC.au }),
      fixed("anzac-day", 4, 25, { name: { en: "Anzac Day", ar: "يوم أنزاك" }, observe: "substitute", observeSince: "2026-01-01", source: SRC.au }),
      nth("queens-birthday", 6, 1, 2, { name: { en: "Queen's Birthday", ar: "عيد ميلاد الملكة" }, until: "2022-12-31", source: SRC.au2021 }),
      nth("kings-birthday", 6, 1, 2, { name: { en: "King's Birthday", ar: "عيد ميلاد الملك" }, since: "2023-01-01", source: SRC.au }),
      nth("bank-holiday", 8, 1, 1, { name: { en: "Bank Holiday (banks and financial institutions)", ar: "عطلة البنوك (البنوك والمؤسسات المالية)" }, source: SRC.au }),
      nth("labour-day", 10, 1, 1, { source: SRC.au }),
      fixed("christmas", 12, 25, { source: SRC.au }),
      fixed("boxing-day", 12, 26, { source: SRC.au }),
    ],
  },
};

// Iran: the original profile, delegated to index.js without changing it. Weekday numbers there count from
// Saturday (0 = Saturday), here from Sunday.
const IR_SOURCE = "@saasreport/calendar (index.js): official Iranian holidays";
for (const [key, p] of Object.entries(IR.PROFILES)) {
  const id = key === "bank" ? "ir" : `ir:${key}`;
  MARKETS[id] = {
    id, name: { en: `Iran (${key})`, ar: `إيران (${key})`, fa: p.title }, currency: "IRR", timezone: IR.TZ,
    weekend: p.weekend.map((d) => (d + 6) % 7), hijri: "civil", status: "verified", iran: key,
    sources: [{ title: IR_SOURCE, url: "" }], notes: ["The Iran profile. Holidays and business days come from index.js, unchanged."], holidays: [],
  };
}

/* ------------------------------------------------------------------ time zones and data versions */
// `timeZone` is each profile's default IANA time zone for the time layer (time.js). It equals the older
// `timezone` field except where that is not an IANA zone: T2 runs on CET, and "Europe/Frankfurt" does not
// exist in the tz database, so the euro area uses Europe/Berlin. `timezone` itself is kept as it was.
const TZ_FIX = { eu: "Europe/Berlin" };
// Holiday data versions: "<pack>-<yyyy.mm.dd>" — the pack and the day its data was last revised.
export const IRAN_DATA_VERSION = "iran-2026.10.01";
const versionOf = (id, date) => `${id}-${date.replace(/-/g, ".")}`;
const BUILTIN = new Set(Object.keys(MARKETS));
for (const m of Object.values(MARKETS)) {
  m.timeZone = TZ_FIX[m.id] || m.timezone;
  m.dataVersion = m.iran ? IRAN_DATA_VERSION : versionOf(m.id, m.checked || CHECKED);
}
/** Default IANA time zone of every built-in profile. */
export const MARKET_TIME_ZONES = Object.freeze(Object.fromEntries(Object.values(MARKETS).map((m) => [m.id, m.timeZone])));

/* ------------------------------------------------------------------ registry */
export const MARKET_IDS = Object.keys(MARKETS);
export function market(id) {
  if (id && typeof id === "object") return id;
  const m = MARKETS[String(id || "").toLowerCase()];
  if (!m) throw new MarketError("unknown_market", `Unknown market profile "${id}" (known: ${MARKET_IDS.join(", ")}).`);
  return m;
}
export const markets = () => MARKET_IDS.map((id) => MARKETS[id]);
/** Add or replace a profile: { id, name, weekend, holidays: [rules], hijri?, status?, sources?, notes?, observe?, settlement? }. */
export function registerMarket(profile) {
  if (!profile || typeof profile.id !== "string" || !profile.id) throw new MarketError("invalid_market", "A market profile needs an id.");
  MARKETS[profile.id] = { hijri: "umalqura", status: "unverified", sources: [], notes: [], holidays: [], weekend: [6, 0], timeZone: profile.timezone || "UTC", dataVersion: `${profile.id}-unversioned`, ...profile };
  if (!MARKET_IDS.includes(profile.id)) MARKET_IDS.push(profile.id);
  clearCache(profile.id);
}
export const rules = { fixed, nth, easter, hijri, hijriLastWeekday, dates, chinese, qingming, table };

/* Announced dates replace predictions: registerOfficial("pk", { 1447: { "eid-al-fitr": ["2026-03-21", "2026-03-22", "2026-03-23"] } }). */
const OFFICIAL = {};
export function registerOfficial(id, table) {
  const m = market(id);
  const o = (OFFICIAL[m.id] ||= {});
  for (const [hy, rows] of Object.entries(table || {})) o[+hy] = { ...(o[+hy] || {}), ...rows };
  clearCache(m.id);
}

/* ------------------------------------------------------------------ weekend */
/** Weekend days (0 = Sunday) of a profile on day n (profiles may change their weekend over time). */
export function weekendOf(id, n = 0) {
  const w = market(id).weekend;
  if (!w.length || typeof w[0] === "number") return w;
  for (const e of w) if (!e.from || n >= dayOfISO(e.from)) return e.days;
  return w[w.length - 1].days;
}
/** Is day n on the profile's weekly weekend? (A make-up working day is still a weekend day here; business.js and
 *  isMakeUpWorkday() say it is open.) */
export const isWeekend = (id, n) => weekendOf(id, n).includes(dow(n));
/** ISO weekday (1 = Monday … 7 = Sunday) of day n — the canonical convention of the new APIs. */
export const isoDow = (n) => (((n + 3) % 7) + 7) % 7 + 1;
/** Weekend days of a profile on day n as ISO weekdays (1 = Monday … 7 = Sunday), sorted. */
export const weekendIsoOf = (id, n = 0) => weekendOf(id, n).map((d) => (d === 0 ? 7 : d)).sort((a, b) => a - b);
/** Default IANA time zone of a profile (Asia/Riyadh, Europe/London, …). */
export const marketTimeZone = (id) => market(id).timeZone || market(id).timezone || "UTC";

/* ------------------------------------------------------------------ holiday computation */
function easterSunday(y) { // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return dayOf(y, Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
}
function nthWeekday(y, month, wd, k) {
  if (k > 0) { const first = dayOf(y, month, 1); return first + ((wd - dow(first) + 7) % 7) + (k - 1) * 7; }
  const last = dayOf(y, month + 1, 0); return last - ((dow(last) - wd + 7) % 7);
}
const inForce = (r, n) => (!r.since || n >= dayOfISO(r.since)) && (!r.until || n <= dayOfISO(r.until));
const titleOf = (r) => r.name || NAMES[r.id] || { en: r.id };

// A published year's source (profile `published: { year: url }`), or null when that year's list was not read.
const publishedSource = (m, gy) => (m.published && Object.prototype.hasOwnProperty.call(m.published, gy) ? m.published[gy] : null);
const HIJRI_RULES = new Set(["hijri", "hijri-last-weekday"]);

// Raw occurrences of one rule in Gregorian year gy: [{ n, rule, hy?, predicted }].
function occurrences(m, r, gy) {
  const out = [], span = r.days || 1;
  const push = (n, extra = {}) => { for (let i = 0; i < span; i++) out.push({ n: n + i, ...extra }); };
  // A published year: the rule's table is the list (nothing when the year has no entry).
  if (r.table && (publishedSource(m, gy) != null || r.table[gy])) {
    for (const d of r.table[gy] || []) {
      const n = dayOfISO(d), o = { n, published: true, source: publishedSource(m, gy) };
      if (HIJRI_RULES.has(r.kind)) o.hy = toHijri(dayOfISO(r.table[gy][0]), m.hijri).hy; // same UID key as the prediction
      if (HIJRI_RULES.has(r.kind) || LUNISOLAR_KINDS.has(r.kind)) o.official = true;   // an announced date replacing a prediction
      out.push(o);
    }
    return out.filter((o) => gYear(o.n) === gy && inForce(r, o.n));
  }
  switch (r.kind) {
    case "fixed": push(dayOf(gy, r.month, r.day)); break;
    case "nth": if (!(r.except || []).includes(String(gy))) push(nthWeekday(gy, r.month, r.weekday, r.n)); break;
    case "easter": push(easterSunday(gy) + r.offset); break;
    case "dates": for (const [d, en, ar] of r.dates) if (d.startsWith(`${gy}-`)) out.push({ n: dayOfISO(d), title: ar ? { en, ar } : { en } }); break;
    case "hijri": case "hijri-last-weekday": {
      for (const hy of hijriYearsOf(gy, m.hijri)) {
        const official = OFFICIAL[m.id]?.[hy]?.[r.id];
        if (official) { for (const d of official) out.push({ n: dayOfISO(d), hy, predicted: false, official: true }); continue; }
        if (r.kind === "hijri-last-weekday") {
          const end = tryFromHijri(hy, r.hm, "last", m.hijri);
          if (end != null) out.push({ n: end - ((dow(end) - r.weekday + 7) % 7), hy, predicted: true });
          continue;
        }
        const start = tryFromHijri(hy, r.hm, r.hd, m.hijri);
        if (start == null) continue; // e.g. 30 Ramadan in a 29-day Ramadan
        if (r.through) {
          const end = tryFromHijri(hy, r.through[0], r.through[1], m.hijri);
          for (let n = start; end != null && n <= end; n++) out.push({ n, hy, predicted: true });
        } else push(start, { hy, predicted: true });
      }
      break;
    }
    case "chinese": // lunar years gy - 1 and gy can both reach into gy
      for (const ly of [gy - 1, gy]) {
        const n = fromLunar(ly, r.lm, r.ld);
        if (n != null) push(n + (r.offset || 0), { predicted: true, note: LUNISOLAR_NOTE });
      }
      break;
    case "qingming": { const n = qingmingDay(gy); if (n != null) push(n, { predicted: true, note: LUNISOLAR_NOTE }); break; }
    case "table": break; // published years only (above)
    default: throw new MarketError("invalid_rule", `Unknown holiday rule kind "${r.kind}" in ${m.id}.`);
  }
  return out.filter((o) => gYear(o.n) === gy && inForce(r, o.n));
}

// Substitute days: "fed" (Sunday → Monday), "sunday-next" (Sunday → next free weekday),
// "substitute" (any weekend day → next free weekday; weekday holidays are placed first). A rule may set its own
// `observe` (false: never; "instead": a weekend date is replaced by the next free weekday) and `observeSince`.
function observe(m, list) {
  const rulesById = new Map(m.holidays.map((r) => [r.id, r]));
  const policyOf = (h) => {
    const r = rulesById.get(h.id);
    if (!r || r.observe === undefined) return m.observe;
    return r.observeSince && h.date < dayOfISO(r.observeSince) ? false : r.observe;
  };
  if (!m.observe && !m.holidays.some((r) => r.observe)) return list;
  const taken = new Set(list.filter((h) => !h.half && !isWeekend(m.id, h.date)).map((h) => h.date));
  const out = [];
  for (const h of list) {
    const wd = dow(h.date), policy = policyOf(h);
    const moves = !h.half && !!policy && (policy === "fed" ? wd === 0 : policy === "sunday-next" ? wd === 0 : isWeekend(m.id, h.date));
    if (!(moves && policy === "instead")) out.push(h);
    if (!moves) continue;
    let d = h.date + 1;
    if (policy !== "fed") while (isWeekend(m.id, d) || taken.has(d)) d++;
    taken.add(d);
    out.push({ ...h, date: d, iso: isoOf(d), observed: true, of: h.iso });
  }
  return out;
}

const cache = new Map();
function clearCache(id) { for (const k of [...cache.keys()]) if (k.startsWith(`${id}|`)) cache.delete(k); }

/** Holidays of a profile in Gregorian year gy, sorted, each
 *  { date, iso, id, title: { en, ar }, predicted, half?, observed?, note?, source, profile }.
 *  An observed (substitute) day repeats the holiday with `observed: true` and `of` (the original ISO date). */
export function yearHolidays(id, gy) {
  const m = market(id);
  const key = `${m.id}|${gy}`;
  let list = cache.get(key);
  if (list) return list;
  if (m.iran) list = iranYear(m, gy);
  else {
    list = [];
    for (const r of m.holidays) for (const o of occurrences(m, r, gy)) {
      const h = { date: o.n, iso: isoOf(o.n), id: r.id, title: o.title || titleOf(r), predicted: !!o.predicted, source: o.source || r.source || null, profile: m.id };
      if (r.half) h.half = true;
      if (o.hy != null) h.hijriYear = o.hy;
      if (o.predicted) h.note = o.note || PREDICTED_NOTE;
      if (o.official) h.official = true;
      list.push(h);
    }
    list.sort((a, b) => a.date - b.date);
    list = observe(m, list).sort((a, b) => a.date - b.date || !!a.observed - !!b.observed);
  }
  cache.set(key, list);
  return list;
}
function iranYear(m, gy) {
  const out = [];
  for (let n = dayOf(gy, 1, 1), end = dayOf(gy, 12, 31); n <= end; n++) for (const e of IR.holidaysOn(n)) {
    const h = { date: n, iso: isoOf(n), id: e.hijri ? `lunar-${e.hijri}` : "solar", title: { fa: e.title }, predicted: e.status === "predicted", source: IR_SOURCE, profile: m.id };
    if (h.predicted) h.note = PREDICTED_NOTE;
    out.push(h);
  }
  return out;
}
/** Closing holidays (not half days) of a profile on day n. */
export const holidaysOn = (id, n) => yearHolidays(id, gYear(n)).filter((h) => h.date === n);
/** Holidays of a profile between two day numbers, inclusive. */
export function holidaysBetween(id, a, b) {
  const out = [];
  for (let y = gYear(Math.min(a, b)); y <= gYear(Math.max(a, b)); y++) for (const h of yearHolidays(id, y)) if (h.date >= Math.min(a, b) && h.date <= Math.max(a, b)) out.push(h);
  return out;
}

/* ------------------------------------------------------------------ make-up working days */
/** Make-up working days (weekend days that are working days, e.g. China's 调休) of a profile in Gregorian year gy:
 *  [{ date, iso, id: "workday", for, title, source, profile }], sorted. Empty for most profiles. */
export function makeUpWorkdays(id, gy) {
  const m = market(id);
  const key = `${m.id}|w${gy}`;
  let list = cache.get(key);
  if (list) return list;
  list = (m.workdays?.[gy] || []).map(([d, of]) => {
    const n = dayOfISO(d), rule = m.holidays.find((r) => r.id === of), t = rule ? titleOf(rule) : null;
    const title = { en: t?.en ? `Working day (make-up for ${t.en})` : "Working day (make-up)", ar: COPY.holidays.makeUpAr };
    if (t?.zh) title.zh = `${t.zh}调休上班`;
    return { date: n, iso: isoOf(n), id: "workday", for: of || null, title, source: publishedSource(m, gy) || rule?.source || null, profile: m.id };
  }).sort((a, b) => a.date - b.date);
  cache.set(key, list);
  return list;
}
/** Is day n a make-up working day of the profile (a weekend day that is a working day)? */
export const isMakeUpWorkday = (id, n) => !!market(id).workdays && makeUpWorkdays(id, gYear(n)).some((w) => w.date === n);
/** Make-up working days of a profile between two day numbers, inclusive. */
export function makeUpWorkdaysBetween(id, a, b) {
  const out = [];
  if (!market(id).workdays) return out;
  for (let y = gYear(Math.min(a, b)); y <= gYear(Math.max(a, b)); y++) for (const w of makeUpWorkdays(id, y)) if (w.date >= Math.min(a, b) && w.date <= Math.max(a, b)) out.push(w);
  return out;
}

/* ------------------------------------------------------------------ settlement cycle */
/** Official settlement cycle (T+n) of a profile on day n, or null when no official source was verified. */
export function settlementCycle(id, n = Math.floor(Date.now() / DAY)) {
  const s = market(id).settlement;
  if (!s || !s.length) return null;
  let best = null;
  for (const e of s) if (!e.from || n >= dayOfISO(e.from)) best = e;
  return best;
}

/** A summary row per profile (id, name, weekend, status, sources, rule count). */
export const summary = () => markets().map((m) => ({ id: m.id, name: m.name, weekend: weekendOf(m.id, Math.floor(Date.now() / DAY)), status: m.status, hijri: m.hijri || null, holidays: m.holidays.length, settlement: m.settlement || null, sources: m.sources }));

export { toHijri, hijriMonthLength };

/** A holiday's name in a locale ("en" | "ar"; Iran's are "fa"), falling back to English. */
export const holidayTitle = (h, locale = "en") => h.title[String(locale).slice(0, 2)] || h.title.en || h.title.fa;

/* ------------------------------------------------------------------ holiday packs (provenance) */
const COVERAGE = { from: 1900, to: 2100 }; // years the rule engine is tested and supported for
const yearOfDay = (n) => new Date(n * DAY).getUTCFullYear();
const HIJRI_KINDS = new Set(["hijri", "hijri-last-weekday"]);
const LUNISOLAR_KINDS = new Set(["chinese", "qingming"]);
function coverageOf(m) {
  let { from, to } = COVERAGE;
  const basis = ["rules computed for Gregorian years 1900–2100"];
  if (m.iran) {
    from = Math.max(from, yearOfDay(IR.nowruz(IR.RANGE.min)) + 1);
    to = Math.min(to, yearOfDay(IR.nowruz(IR.RANGE.max)));
    basis.push(`Iran engine: Solar Hijri ${IR.RANGE.min}–${IR.RANGE.max}; lunar holidays from islamic-civil (predicted)`);
  } else if (m.holidays.some((r) => HIJRI_KINDS.has(r.kind)) && (m.hijri || "umalqura") === "umalqura") {
    from = Math.max(from, yearOfDay(tryFromHijri(1300, 1, 1, "umalqura")) + 1);
    to = Math.min(to, yearOfDay(tryFromHijri(1600, 12, "last", "umalqura")) - 1);
    basis.push("Hijri holidays: Umm al-Qura AH 1300–1600 (predicted)");
  }
  if (m.holidays.some((r) => LUNISOLAR_KINDS.has(r.kind))) {
    to = Math.min(to, LUNAR_RANGE.to);
    basis.push(`Chinese lunisolar dates and Qingming: Hong Kong Observatory tables, lunar years ${LUNAR_RANGE.from}–${LUNAR_RANGE.to} (predicted)`);
  }
  const pub = Object.keys(m.published || {}).map(Number).sort((a, b) => a - b);
  if (pub.length) basis.push(`published lists: ${pub.join(", ")}`);
  const tableOnly = m.holidays.filter((r) => r.kind === "table").map((r) => r.id);
  if (tableOnly.length) basis.push(`no data outside the published years for: ${[...new Set(tableOnly)].join(", ")}`);
  if (m.workdays) basis.push(`make-up working days: ${Object.keys(m.workdays).join(", ")}`);
  for (const r of m.holidays) if (r.kind === "dates") {
    const ys = r.dates.map(([d]) => +d.slice(0, 4));
    basis.push(`one-off dates ${Math.min(...ys)}–${Math.max(...ys)}`);
  }
  return { from, to, basis };
}
const checkedOf = (m) => m.checked ?? (BUILTIN.has(m.id) && !m.iran ? CHECKED : null);
function iranHolidayRules(m) {
  // The Iran engine keeps its tables private; read one reference Solar Hijri year (1405) to list them.
  const seen = new Map();
  for (const e of IR.holidays(1405)) {
    const j = IR.toJalali(e.date);
    const id = e.hijri ? `lunar-${e.hijri}` : `solar-${j.jm}-${j.jd}`;
    if (!seen.has(id)) seen.set(id, { id, kind: e.kind === "lunar" ? "hijri" : "jalali", title: { fa: e.title }, predicted: e.kind === "lunar", source: IR_SOURCE, checked: null });
  }
  return [...seen.values()];
}
/** One holiday pack: the data behind a profile's holidays, with version, sources and coverage. Deterministic. */
export function holidayPack(id) {
  const m = market(id);
  const checked = checkedOf(m);
  const holidays = m.iran ? iranHolidayRules(m) : m.holidays.map((r) => {
    // predicted: computed dates (Hijri, Chinese) outside the published years; `published`: the years taken from a list.
    const h = { id: r.id, kind: r.kind, title: titleOf(r), predicted: HIJRI_KINDS.has(r.kind) || LUNISOLAR_KINDS.has(r.kind), source: r.source || null, checked: r.checked ?? (r.source ? checked : null) };
    if (r.since) h.since = r.since;
    if (r.until) h.until = r.until;
    if (r.half) h.half = true;
    if (r.table) h.published = Object.keys(r.table).map(Number).sort((a, b) => a - b);
    return h;
  });
  const urls = [...m.sources.map((s) => s.url), ...m.holidays.map((r) => r.source), ...Object.values(m.published || {})].filter((u) => /^https?:\/\//.test(u || ""));
  const official = OFFICIAL[m.id] ? Object.keys(OFFICIAL[m.id]).map(Number).sort((a, b) => a - b) : [];
  return {
    id: m.id, pack: m.iran ? "iran" : m.id, dataVersion: m.dataVersion || `${m.id}-unversioned`, status: m.status, checked,
    timeZone: m.timeZone || m.timezone || "UTC", hijri: m.hijri || null,
    sources: m.sources.map((s) => ({ title: s.title, url: s.url || null })), sourceUrls: [...new Set(urls)],
    coverage: coverageOf(m), official: m.iran ? IR.officialYears() : official, holidays,
    ...(m.published ? { published: Object.keys(m.published).map(Number).sort((a, b) => a - b) } : {}),
    ...(m.workdays ? { workdays: Object.values(m.workdays).flat().map(([d, of]) => ({ date: d, for: of })) } : {}),
  };
}
/** Every profile's holiday pack, in MARKET_IDS order. */
export const holidayPacks = () => MARKET_IDS.map(holidayPack);
/** Where one holiday (an entry of yearHolidays / holidaysOn) comes from. */
export function holidayProvenance(h) {
  const m = market(h.profile);
  const rule = m.holidays.find((r) => r.id === h.id);
  const checked = rule?.checked ?? (h.source && /^https?:/.test(h.source) ? checkedOf(m) : null);
  return { profile: m.id, dataVersion: m.dataVersion || `${m.id}-unversioned`, source: h.source ?? null, checked, predicted: !!h.predicted, official: !!h.official };
}
