/**
 * @saasreport/speech — spoken-text normalizer for TTS scripts.
 * TTS voices stumble on digits, Latin terms, URLs and Markdown, so every line goes through
 * speakable() before synthesis. Locale packs:
 *   fa — Persian: numbers and ordinals in words, Jalali dates, T+n, Latin terms spelled in Persian
 *        ۱۴۰۵/۰۱/۰۵ → پنجم فروردین هزار و چهارصد و پنج    T+1 → تی پلاس یک    API → ای‌پی‌آی
 *   en — English: numbers, ordinals (1st), decimals, percent, currencies ($5, 10 USD), ISO and Hijri dates in words, T+n.
 *   ar — Arabic: Arabic-Indic and Latin digits → words, ordinal dates (Gregorian and Hijri: 1447/09/01 هـ), percent,
 *        currencies (USD, SAR, AED, MYR, GBP, EUR and their symbols), T+n, Latin acronyms spelled in Arabic
 *        2026-03-05 → الخامس من مارس ألفين وستة وعشرين    ٥٪ → خمسة بالمئة    API → إيه بي آي
 * speakable(text, { locale }) → text a voice can read; unspeakable() → what is still unreadable ("" when the line is fine:
 * no Latin letters or digits for fa and ar, no digits for en).
 * Pure, dependency-free; runs anywhere.
 */

/* ------------------------------------------------------------------ Persian numbers */
const ONES = ["صفر", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه", "ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نوزده"];
const TENS = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
const HUNDREDS = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];
const SCALES = [[1e12, "هزار میلیارد"], [1e9, "میلیارد"], [1e6, "میلیون"], [1e3, "هزار"]];
const J_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];

function below1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(HUNDREDS[Math.floor(n / 100)]); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]); n %= 10; }
  if (n > 0) parts.push(ONES[n]);
  return parts.join(" و ");
}

/** Cardinal number in Persian words (integers up to 10^15). */
export function numberWords(n) {
  n = Math.trunc(Number(n));
  if (!Number.isFinite(n)) return "";
  if (n < 0) return "منفی " + numberWords(-n);
  if (n < 20) return ONES[n];
  const parts = [];
  for (const [v, name] of SCALES) {
    if (n >= v) { const q = Math.floor(n / v); parts.push(q === 1 && v === 1e3 ? "هزار" : `${below1000(q)} ${name}`); n %= v; }
  }
  if (n > 0) parts.push(below1000(n));
  return parts.join(" و ");
}

/** Persian ordinal: یکم، دوم، سوم، بیست و سوم، سی‌ام. */
export function ordinalWords(n) {
  const w = numberWords(n);
  if (w.endsWith("سه")) return w.slice(0, -2) + "سوم";
  if (w.endsWith("سی")) return w + "‌ام";
  return w + "م";
}

/* ------------------------------------------------------------------ English numbers */
const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const EN_SCALES = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];
function enBelow1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(`${EN_ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) { parts.push(EN_TENS[Math.floor(n / 10)] + (n % 10 ? "-" + EN_ONES[n % 10] : "")); n = 0; }
  if (n > 0) parts.push(EN_ONES[n]);
  return parts.join(" ");
}
/** Cardinal number in English words (integers up to 10^15). */
export function numberWordsEn(n) {
  n = Math.trunc(Number(n));
  if (!Number.isFinite(n)) return "";
  if (n < 0) return "minus " + numberWordsEn(-n);
  if (n < 20) return EN_ONES[n];
  const parts = [];
  for (const [v, name] of EN_SCALES) if (n >= v) { parts.push(`${enBelow1000(Math.floor(n / v))} ${name}`); n %= v; }
  if (n > 0) parts.push(enBelow1000(n));
  return parts.join(" ");
}

const EN_ORD = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
/** English ordinal in words: 1 → first, 22 → twenty-second, 40 → fortieth. */
export function ordinalWordsEn(n) {
  const w = numberWordsEn(n);
  return w.replace(/([a-z]+)$/, (last) => EN_ORD[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`));
}
/** A year the way it is said: 2026 → twenty twenty-six, 2000 → two thousand, 2005 → two thousand five, 1447 → fourteen forty-seven. */
export function yearWordsEn(y) {
  y = Math.trunc(Number(y));
  if (y < 1100 || y > 2099 || (y >= 2000 && y < 2010) || y % 1000 === 0) return numberWordsEn(y);
  const hi = Math.floor(y / 100), lo = y % 100;
  return `${numberWordsEn(hi)} ${lo === 0 ? "hundred" : lo < 10 ? `oh ${numberWordsEn(lo)}` : numberWordsEn(lo)}`;
}
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HIJRI_EN = ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani", "Jumada al-Ula", "Jumada al-Akhirah", "Rajab", "Shaban", "Ramadan", "Shawwal", "Dhu al-Qadah", "Dhu al-Hijjah"];
/** Currencies read aloud: code → [English singular, English plural, Arabic]. Symbols map to codes. */
export const CURRENCIES = {
  USD: ["US dollar", "US dollars", "دولار أمريكي"], SAR: ["Saudi riyal", "Saudi riyals", "ريال سعودي"], AED: ["UAE dirham", "UAE dirhams", "درهم إماراتي"],
  MYR: ["Malaysian ringgit", "Malaysian ringgit", "رينغيت ماليزي"], GBP: ["pound sterling", "pounds sterling", "جنيه إسترليني"], EUR: ["euro", "euros", "يورو"],
};
const CURRENCY_SYMBOLS = { "$": "USD", "US$": "USD", "£": "GBP", "€": "EUR", "RM": "MYR", "﷼": "SAR", "ر.س": "SAR", "د.إ": "AED" };
const CODES = Object.keys(CURRENCIES).join("|");
const SYMBOLS = Object.keys(CURRENCY_SYMBOLS).sort((a, b) => b.length - a.length).map((x) => x.replace(/[.$]/g, "\\$&")).join("|");
// An amount, optionally with a scale word: 3.5 billion, ٣٫٥ مليار (the scale is read as written).
const AMOUNT = "(\\d+(?:\\.\\d+)?)(?:\\s?(thousand|million|billion|trillion|ألف|آلاف|مليون|ملايين|مليار|مليارات))?";
/** Rewrite "USD 100", "100 USD", "$100", "3.5 billion SAR", "100 ر.س" as `say(amount, code, scale)`. */
function currencies(s, say) {
  s = s.replace(new RegExp(`(?:^|(?<=[\\s(]))(${SYMBOLS})\\s?${AMOUNT}`, "g"), (_, sym, n, x) => say(n, CURRENCY_SYMBOLS[sym], x));
  s = s.replace(new RegExp(`\\b(${CODES})\\s?${AMOUNT}`, "g"), (_, c, n, x) => say(n, c, x));
  s = s.replace(new RegExp(`${AMOUNT}\\s?(${CODES})\\b`, "g"), (_, n, x, c) => say(n, c, x));
  s = s.replace(new RegExp(`${AMOUNT}\\s?(${SYMBOLS})(?=[\\s.,،؛)]|$)`, "g"), (_, n, x, sym) => say(n, CURRENCY_SYMBOLS[sym], x));
  return s;
}

/* ------------------------------------------------------------------ Arabic numbers */
const AR_ONES = ["صفر", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة",
  "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
const AR_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const AR_HUNDREDS = ["", "مئة", "مئتان", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة"];
// [value, one, two, plural (3-10), accusative (11-99)]
const AR_SCALES = [[1e12, "تريليون", "تريليونان", "تريليونات", "تريليونًا"], [1e9, "مليار", "ملياران", "مليارات", "مليارًا"],
  [1e6, "مليون", "مليونان", "ملايين", "مليونًا"], [1e3, "ألف", "ألفان", "آلاف", "ألفًا"]];
function arBelow1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(AR_HUNDREDS[Math.floor(n / 100)]); n %= 100; }
  if (n >= 20) { parts.push(n % 10 ? `${AR_ONES[n % 10]} و${AR_TENS[Math.floor(n / 10)]}` : AR_TENS[Math.floor(n / 10)]); n = 0; }
  if (n > 0) parts.push(AR_ONES[n]);
  return parts.join(" و");
}
/** Cardinal number in Arabic words, in the form used for counting aloud (integers up to 10^15): 2026 → ألفان وستة وعشرون. */
export function numberWordsAr(n) {
  n = Math.trunc(Number(n));
  if (!Number.isFinite(n)) return "";
  if (n < 0) return "سالب " + numberWordsAr(-n);
  if (n < 20) return AR_ONES[n];
  const parts = [];
  for (const [v, one, two, plural, acc] of AR_SCALES) {
    if (n < v) continue;
    const q = Math.floor(n / v), r = q % 100;
    n %= v;
    if (q === 1) parts.push(one);
    else if (q === 2) parts.push(two);
    else if (q <= 10) parts.push(`${arBelow1000(q)} ${plural}`);
    else parts.push(`${arBelow1000(q)} ${r >= 11 ? acc : one}`);
  }
  if (n > 0) parts.push(arBelow1000(n));
  return parts.join(" و");
}
/** A year after a month or "عام" is genitive: ألفان → ألفين, اثنان → اثنين, …ون → …ين. */
const arGenitive = (w) => w.replace(/(^|\s|و)(ألفان|مئتان|اثنان|مليونان|ملياران)(?=\s|$)/g, (_, p, x) => p + x.replace(/ان$/, "ين")).replace(/(عشر|ثلاث|أربع|خمس|ست|سبع|ثمان|تسع)ون(?=\s|$)/g, "$1ين");
const AR_ORD = ["", "الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
const AR_ORD_UNIT = ["", "الحادي", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع"];
/** Arabic ordinal (masculine, with the article) 1-99: الأول، الحادي عشر، الخامس والعشرون، الثلاثون. */
export function ordinalWordsAr(n) {
  n = Math.trunc(Number(n));
  if (n >= 1 && n <= 10) return AR_ORD[n];
  if (n > 10 && n < 20) return `${AR_ORD_UNIT[n - 10]} عشر`;
  if (n >= 20 && n < 100) { const t = `ال${AR_TENS[Math.floor(n / 10)]}`; return n % 10 ? `${AR_ORD_UNIT[n % 10]} و${t}` : t; }
  return numberWordsAr(n);
}
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const HIJRI_AR = ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];
const AR_MONTH_NAMES = [...AR_MONTHS, ...HIJRI_AR, "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"]
  .sort((a, b) => b.length - a.length);

/**
 * Generic Latin terms (finance and tech) and their Arabic spoken forms. Longest first when applied.
 * Project-specific names belong in config: speakable(text, { locale: "ar", terms }).
 */
export const TERMS_AR = [
  ["Open Banking", "الخدمات المصرفية المفتوحة"], ["Open Finance", "التمويل المفتوح"], ["OpenAPI", "أوبن إيه بي آي"], ["fintech", "التكنولوجيا المالية"], ["FinTech", "التكنولوجيا المالية"], ["Fintech", "التكنولوجيا المالية"],
  ["API", "إيه بي آي"], ["APIs", "واجهات إيه بي آي"], ["SDK", "إس دي كيه"], ["JSON", "جيسون"], ["REST", "ريست"], ["webhook", "ويب هوك"], ["Webhook", "ويب هوك"],
  ["sandbox", "البيئة التجريبية"], ["Sandbox", "البيئة التجريبية"], ["KYC", "كيه واي سي"], ["AML", "إيه إم إل"], ["OTP", "أو تي بي"], ["IBAN", "آيبان"], ["SWIFT", "سويفت"],
  ["ISO", "آيزو"], ["PSD2", "بي إس دي اثنان"], ["ESG", "إي إس جي"], ["SLA", "إس إل إيه"], ["RSS", "آر إس إس"], ["URL", "الرابط"], ["AI", "الذكاء الاصطناعي"], ["LLM", "نموذج لغوي"],
  ["Sukuk", "الصكوك"], ["sukuk", "الصكوك"], ["Takaful", "التكافل"], ["takaful", "التكافل"], ["Murabaha", "المرابحة"], ["Ijara", "الإجارة"], ["Shariah", "الشريعة"], ["Sharia", "الشريعة"],
  ["Cloudflare", "كلاودفلير"], ["Telegram", "تيليغرام"],
];
const AR_LETTERS = { a: "إيه", b: "بي", c: "سي", d: "دي", e: "إي", f: "إف", g: "جي", h: "إتش", i: "آي", j: "جيه", k: "كيه", l: "إل", m: "إم", n: "إن", o: "أو", p: "بي", q: "كيو", r: "آر", s: "إس", t: "تي", u: "يو", v: "في", w: "دبليو", x: "إكس", y: "واي", z: "زد" };

/* ------------------------------------------------------------------ helpers */
/** Persian and Arabic-Indic digits → ASCII digits. */
export const toLatinDigits = (s) => String(s).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

/**
 * Generic Latin terms (finance and tech) and their Persian spoken forms. Longest first when applied.
 * Project-specific names (brands, product acronyms) belong in config: speakable(text, { terms }).
 */
export const TERMS_FA = [
  ["OpenAPI", "اوپن ای‌پی‌آی"], ["Open Banking", "اوپن بنکینگ"], ["Open Finance", "اوپن فاینانس"],
  ["JSON-RPC", "جی‌سان آر‌پی‌سی"], ["webhook", "وب‌هوک"], ["Webhook", "وب‌هوک"], ["sandbox", "سندباکس"], ["Sandbox", "سندباکس"],
  ["API", "ای‌پی‌آی"], ["APIs", "ای‌پی‌آی‌ها"], ["MCP", "اِم‌سی‌پی"], ["SDK", "اِس‌دی‌کی"], ["CLI", "سی‌اِل‌آی"], ["JSON", "جی‌سان"], ["REST", "رِست"],
  ["ICS", "آی‌سی‌اِس"], ["iCal", "آی‌کَل"], ["RSS", "آر‌اِس‌اِس"], ["KYC", "کِی‌وای‌سی"], ["OTP", "او‌تی‌پی"],
  ["IBAN", "آیبَن"], ["PSP", "پی‌اِس‌پی"], ["UI", "رابط کاربری"], ["URL", "نشانی"], ["HTTP", "اِچ‌تی‌تی‌پی"], ["curl", "کِرل"], ["npm", "اِن‌پی‌اِم"],
  ["Telegram", "تلگرام"], ["Bale", "بله"], ["Cloudflare", "کلادفلر"], ["AI", "هوش مصنوعی"], ["LLM", "مدل زبانی"], ["SLA", "اِس‌اِل‌ای"],
];
/** English has no default term list (Latin terms are read as written). */
export const TERMS_EN = [];
const LETTERS = { a: "اِی", b: "بی", c: "سی", d: "دی", e: "ای", f: "اِف", g: "جی", h: "اِچ", i: "آی", j: "جِی", k: "کِی", l: "اِل", m: "اِم", n: "اِن", o: "او", p: "پی", q: "کیو", r: "آر", s: "اِس", t: "تی", u: "یو", v: "وی", w: "دابلیو", x: "اِکس", y: "وای", z: "زِد" };

const termList = (x) => (Array.isArray(x) ? x : Object.entries(x || {}));
/** Built-in terms for a locale merged with the caller's (the caller's spoken form wins); longest first. */
export function termsFor(locale = "fa", { terms, defaults = true } = {}) {
  const map = new Map(defaults ? termList({ fa: TERMS_FA, ar: TERMS_AR }[langOf(locale)] || TERMS_EN) : []);
  for (const [k, v] of termList(terms)) map.set(k, v);
  return [...map].sort((a, b) => b[0].length - a[0].length);
}
const langOf = (locale) => String(locale || "fa").toLowerCase().split(/[-_]/)[0];
const opts = (o) => (typeof o === "string" ? { locale: o } : o || {});
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const applyTerms = (s, list) => {
  for (const [en, spoken] of list) s = s.replace(new RegExp(`(^|[^A-Za-z])${escRe(en)}(?![A-Za-z])`, "g"), `$1${spoken}`);
  return s;
};
// Markdown, code, links, URLs and emoji never reach the voice.
const strip = (s) => String(s ?? "")
  .replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ")
  .replace(/[*_#>|~]+/g, " ").replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, " ");

function speakFa(input, o) {
  let s = strip(input);
  s = toLatinDigits(s).replace(/(\d)٬(?=\d{3})/g, "$1").replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/٫/g, ".");
  // Jalali dates: 1405/01/05 → پنجم فروردین هزار و چهارصد و پنج
  s = s.replace(/\b(1[34]\d\d)[/-](\d{1,2})[/-](\d{1,2})\b/g, (m, y, mo, d) =>
    +mo >= 1 && +mo <= 12 ? `${ordinalWords(+d)} ${J_MONTHS[mo - 1]} ${numberWords(+y)}` : m);
  s = s.replace(/\bT\s*\+\s*(\d+)/gi, (_, n) => `${SETTLEMENT.fa.plus} ${numberWords(+n)}`).replace(/\bT\s*\+\s*n\b/gi, SETTLEMENT.fa.plusN);
  s = applyTerms(s, termsFor("fa", o));
  // Day number before a month name is an ordinal: ۵ فروردین → پنجم فروردین
  s = s.replace(new RegExp(`(\\d{1,2})\\s+(${J_MONTHS.join("|")})`, "g"), (_, d, mo) => `${ordinalWords(+d)} ${mo}`);
  s = s.replace(/(\d+)\s*(%|٪)/g, (_, n) => `${numberWords(+n)} درصد`);
  s = s.replace(/(\d+)\.(\d+)/g, (_, a, b) => `${numberWords(+a)} ممیز ${numberWords(+b)}`);
  s = s.replace(/\d+/g, (n) => numberWords(+n));
  s = s.replace(/\b[A-Za-z]{1,4}\b/g, (w) => (/^[A-Z]+$/.test(w) || w.length <= 2 ? [...w.toLowerCase()].map((c) => LETTERS[c] || "").join("‌") : w));
  s = s.replace(/[A-Za-z][A-Za-z-]*/g, " "); // any Latin word left is dropped
  s = s.replace(/[()[\]{}"«»]/g, " ").replace(/\s*([،؛:.!?؟])\s*/g, "$1 ").replace(/\s+/g, " ").trim();
  return s;
}

const enDecimal = (a, b) => `${numberWordsEn(+a)} point ${[...b].map((d) => EN_ONES[+d]).join(" ")}`;
const enAmount = (n) => (n.includes(".") ? enDecimal(...n.split(".")) : numberWordsEn(+n));

function speakEn(input, o) {
  let s = strip(input);
  s = toLatinDigits(s).replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/٫/g, ".");
  // ISO dates: 2026-03-05 → March fifth, twenty twenty-six; Hijri: 1447/09/01 AH → the first of Ramadan, fourteen forty-seven AH
  s = s.replace(/\b(1[34]\d\d)[/-](\d{1,2})[/-](\d{1,2})\s*(AH|هـ)/g, (m, y, mo, d) =>
    +mo >= 1 && +mo <= 12 ? `the ${ordinalWordsEn(+d)} of ${HIJRI_EN[mo - 1]}, ${yearWordsEn(+y)} AH` : m);
  s = s.replace(/\b((?:19|20)\d\d)-(\d{1,2})-(\d{1,2})\b/g, (m, y, mo, d) =>
    +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? `${EN_MONTHS[mo - 1]} ${ordinalWordsEn(+d)}, ${yearWordsEn(+y)}` : m);
  s = s.replace(new RegExp(`\\b(\\d{1,2})\\s+(${[...EN_MONTHS, ...HIJRI_EN].join("|")})(?:\\s+((?:1[34]|19|20)\\d\\d))?(\\s*AH)?\\b`, "g"),
    (m, d, mo, y, ah) => (+d >= 1 && +d <= 31 ? `the ${ordinalWordsEn(+d)} of ${mo}${y ? `, ${yearWordsEn(+y)}` : ""}${ah ? " AH" : ""}` : m));
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/g, (_, n) => ordinalWordsEn(+n));
  s = currencies(s, (n, c, x) => `${enAmount(n)} ${x ? `${x} ` : ""}${n === "1" && !x ? CURRENCIES[c][0] : CURRENCIES[c][1]}`);
  s = s.replace(/\bT\s*\+\s*(\d+)/gi, (_, n) => `T plus ${numberWordsEn(+n)}`).replace(/\bT\s*\+\s*n\b/gi, "T plus n");
  s = applyTerms(s, termsFor("en", o));
  s = s.replace(/(\d+(?:\.\d+)?)\s*[%٪]/g, (_, n) => `${enAmount(n)} percent`);
  s = s.replace(/(\d+)\.(\d+)/g, (_, a, b) => `${numberWordsEn(+a)} point ${[...b].map((d) => EN_ONES[+d]).join(" ")}`);
  s = s.replace(/\d+/g, (n) => numberWordsEn(+n));
  // Dashes and ellipses make a TTS voice stop dead: read them as a comma or a full stop (pacing: no awkward pauses).
  s = s.replace(/\s*[—–]+\s*/g, ", ").replace(/\s*(\.{2,}|…)\s*/g, ". ").replace(/[()[\]{}"]/g, " ").replace(/\s*([,;:.!?])(?=\s|$)/g, "$1").replace(/,\s*,/g, ",").replace(/\s+/g, " ").trim();
  return s;
}

const arDecimal = (a, b) => `${numberWordsAr(+a)} فاصلة ${b.length <= 2 ? numberWordsAr(+b) : [...b].map((d) => AR_ONES[+d]).join(" ")}`;
const arAmount = (n) => (n.includes(".") ? arDecimal(...n.split(".")) : numberWordsAr(+n));
const arYear = (y) => arGenitive(numberWordsAr(+y));

function speakAr(input, o) {
  let s = strip(input);
  s = toLatinDigits(s).replace(/(\d)[٬,](?=\d{3}(?!\d))/g, "$1").replace(/(\d)٫(?=\d)/g, "$1.");
  // Hijri dates: 1447/09/01 هـ (or a 13xx-15xx year) → الأول من رمضان عام ألف وأربعمئة وسبعة وأربعين للهجرة
  s = s.replace(/(^|[^\d])(1[345]\d\d)[/-](\d{1,2})[/-](\d{1,2})(\s*هـ)?/g, (m, p, y, mo, d) =>
    +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 30 ? `${p}${ordinalWordsAr(+d)} من ${HIJRI_AR[mo - 1]} عام ${arYear(y)} للهجرة` : m);
  // Gregorian dates: 2026-03-05 or 05/03/2026 → الخامس من مارس عام ألفين وستة وعشرين
  s = s.replace(/(^|[^\d])((?:19|20)\d\d)-(\d{1,2})-(\d{1,2})(?!\d)(\s*م(?![\u0600-\u06FF]))?/g, (m, p, y, mo, d) =>
    +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? `${p}${ordinalWordsAr(+d)} من ${AR_MONTHS[mo - 1]} عام ${arYear(y)}` : m);
  s = s.replace(/(^|[^\d])(\d{1,2})\/(\d{1,2})\/((?:19|20)\d\d)(?!\d)(\s*م(?![\u0600-\u06FF]))?/g, (m, p, d, mo, y) =>
    +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? `${p}${ordinalWordsAr(+d)} من ${AR_MONTHS[mo - 1]} عام ${arYear(y)}` : m);
  // "5 مارس 2026" / "1 رمضان 1447 هـ": the day is an ordinal, the year genitive
  s = s.replace(new RegExp(`(^|[^\\d])(\\d{1,2})\\s+(${AR_MONTH_NAMES.join("|")})(?:\\s+(\\d{3,4}))?(\\s*هـ)?(\\s*م(?![\\u0600-\\u06FF]))?`, "g"),
    (m, p, d, mo, y, h) => (+d >= 1 && +d <= 31 ? `${p}${ordinalWordsAr(+d)} من ${mo}${y ? ` عام ${arYear(y)}` : ""}${h ? " للهجرة" : ""}` : m));
  s = s.replace(/(\d+)\s*هـ/g, (_, y) => `${arYear(y)} للهجرة`).replace(/(\d+)\s*م(?![\u0600-\u06FF])/g, (_, y) => `${arYear(y)} ميلادية`);
  s = currencies(s, (n, c, x) => `${arAmount(n)} ${x ? `${x} ` : ""}${CURRENCIES[c][2]}`);
  s = s.replace(/(^|[\s(])(عام|سنة|العام)\s+(\d{4})(?!\d)/g, (_, p, w, y) => `${p}${w} ${arYear(y)}`);
  s = s.replace(/\bT\s*\+\s*(\d+)/gi, (_, n) => `${SETTLEMENT.ar.plus} ${numberWordsAr(+n)}`).replace(/\bT\s*\+\s*n\b/gi, SETTLEMENT.ar.plusN);
  s = applyTerms(s, termsFor("ar", o));
  s = s.replace(/(\d+(?:\.\d+)?)\s*[%٪]/g, (_, n) => `${arAmount(n)} بالمئة`);
  s = s.replace(/(\d+)\.(\d+)/g, (_, a, b) => arDecimal(a, b));
  s = s.replace(/\d+/g, (n) => numberWordsAr(+n));
  s = s.replace(/\b[A-Za-z]{1,4}\b/g, (w) => (/^[A-Z]+$/.test(w) || w.length <= 2 ? [...w.toLowerCase()].map((c) => AR_LETTERS[c] || "").join(" ") : w));
  s = s.replace(/[A-Za-z][A-Za-z-]*/g, " "); // any Latin word left is dropped
  s = s.replace(/[()[\]{}"«»]/g, " ").replace(/\s*([،؛:.!?؟])\s*/g, "$1 ").replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Rewrite one line of script into text a TTS voice can read aloud.
 * @param {string} text
 * @param {string | {locale?: string, terms?: Array<[string,string]>|Record<string,string>, defaults?: boolean}} [options]
 *   locale "fa" (default), "en" or "ar" (or a BCP-47 tag such as "fa-IR", "ar-SA"); `terms` adds or overrides Latin terms;
 *   `defaults: false` drops the built-in term list.
 */
export function speakable(text, options) {
  const o = opts(options), l = langOf(o.locale);
  text = String(text).replace(/[™®℠]/g, "");   // brand marks are written, never spoken
  return l === "en" ? speakEn(text, o) : l === "ar" ? speakAr(text, o) : speakFa(text, o);
}

/** Characters a voice cannot read that survive speakable() (empty string when the line is fine). */
export function unspeakable(text, options) {
  const o = opts(options), l = langOf(o.locale);
  const sp = speakable(text, o);
  const re = l === "en" ? /[0-9٠-٩۰-۹]/g : l === "ar" ? /[A-Za-z0-9٠-٩۰-۹]/g : /[A-Za-z0-9۰-۹]/g;
  return (sp.match(re) || []).join("");
}

/** Numbers (as integers) mentioned with digits, for factual guards on generated scripts. */
export const numbersIn = (s) => (toLatinDigits(String(s)).replace(/(\d)[,٬](?=\d{3})/g, "$1").match(/\d+/g) || []).map(Number);

/** Same speaker twice in a row reads as one turn. Lines are {speaker, text}. */
export function mergeTurns(lines) {
  const out = [];
  for (const l of lines) { const prev = out[out.length - 1]; if (prev && prev.speaker === l.speaker) prev.text += " " + l.text; else out.push({ ...l }); }
  return out;
}

/** Default speaking rate (characters per second, pauses included), measured on Persian voices. */
export const CHARS_PER_SECOND = 11;
/** Estimated duration of lines ({text} objects, [speaker, text] pairs or strings) in milliseconds. */
export function estimateMs(lines, cps = CHARS_PER_SECOND) {
  const len = (l) => (typeof l === "string" ? l : Array.isArray(l) ? l[1] : l?.text || "").length;
  return Math.round((lines || []).reduce((s, l) => s + len(l), 0) / cps * 1000);
}

/** The language data of the normaliser (number words, month names, currency names, spelled letters) as one validated export (kit.canon.json: copy-pack). */
export const SETTLEMENT = { fa: { plus: "تی پلاس", plusN: "تی پلاس اِن" }, ar: { plus: "تي زائد", plusN: "تي زائد إن" } };
export const WORD_TABLES = { SETTLEMENT, CURRENCIES, TERMS_AR, TERMS_FA, ONES, TENS, HUNDREDS, SCALES, J_MONTHS, EN_ONES, EN_TENS, EN_SCALES, EN_ORD, EN_MONTHS, HIJRI_EN, CURRENCY_SYMBOLS, AMOUNT, AR_ONES, AR_TENS, AR_HUNDREDS, AR_SCALES, AR_ORD, AR_ORD_UNIT, AR_MONTHS, HIJRI_AR, AR_MONTH_NAMES, AR_LETTERS, LETTERS };
