// The ar locale pack (numbers, dates, percent, currencies, terms) and the English additions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { speakable, unspeakable, numberWordsAr, ordinalWordsAr, ordinalWordsEn, yearWordsEn, termsFor } from "../src/index.js";

const ar = (s) => speakable(s, { locale: "ar" });

test("Arabic numbers: cardinals with the dual, plurals and accusative scales; ordinals", () => {
  const cases = { 0: "صفر", 2: "اثنان", 11: "أحد عشر", 21: "واحد وعشرون", 100: "مئة", 102: "مئة واثنان", 250: "مئتان وخمسون", 1000: "ألف", 2000: "ألفان",
    2026: "ألفان وستة وعشرون", 3000: "ثلاثة آلاف", 11000: "أحد عشر ألفًا", 100000: "مئة ألف", 1447: "ألف وأربعمئة وسبعة وأربعون", 2500000: "مليونان وخمسمئة ألف", [-5]: "سالب خمسة" };
  for (const [n, w] of Object.entries(cases)) assert.equal(numberWordsAr(+n), w, n);
  assert.deepEqual([1, 5, 11, 12, 20, 21, 30, 31].map(ordinalWordsAr), ["الأول", "الخامس", "الحادي عشر", "الثاني عشر", "العشرون", "الحادي والعشرون", "الثلاثون", "الحادي والثلاثون"]);
});

test("ar: Arabic-Indic and Latin digits, percent, decimals", () => {
  assert.equal(ar("نما السوق ٢٥٪ في عام 2026."), "نما السوق خمسة وعشرون بالمئة في عام ألفين وستة وعشرين.");
  assert.equal(ar("سعر الفائدة 4.25% و٣٫٥ نقاط."), "سعر الفائدة أربعة فاصلة خمسة وعشرون بالمئة وثلاثة فاصلة خمسة نقاط.");
  assert.equal(ar("بلغ العدد 1,500,000 و١٢٬٠٠٠."), "بلغ العدد مليون وخمسمئة ألف واثنا عشر ألفًا.");
});

test("ar: currencies by code, symbol and scale (USD, SAR, AED, MYR, GBP, EUR)", () => {
  assert.equal(ar("الرسوم 250 SAR أو AED 40 أو 12.5 EUR."), "الرسوم مئتان وخمسون ريال سعودي أو أربعون درهم إماراتي أو اثنا عشر فاصلة خمسة يورو.");
  assert.equal(ar("$100 و £3 و RM 7 و 3.5 مليار MYR"), "مئة دولار أمريكي و ثلاثة جنيه إسترليني و سبعة رينغيت ماليزي و ثلاثة فاصلة خمسة مليار رينغيت ماليزي");
  assert.equal(ar("أصدرت سندات بقيمة 2 مليار USD."), "أصدرت سندات بقيمة اثنان مليار دولار أمريكي.");
});

test("ar: Gregorian and Hijri dates as ordinals with the month and the year", () => {
  assert.equal(ar("يبدأ في 2026-02-18."), "يبدأ في الثامن عشر من فبراير عام ألفين وستة وعشرين.");
  assert.equal(ar("الموعد 18/02/2026 م."), "الموعد الثامن عشر من فبراير عام ألفين وستة وعشرين.");
  assert.equal(ar("رمضان 1447/09/01 هـ."), "رمضان الأول من رمضان عام ألف وأربعمئة وسبعة وأربعين للهجرة.");
  assert.equal(ar("في 5 مارس 2026 و1 شوال 1447 هـ"), "في الخامس من مارس عام ألفين وستة وعشرين والأول من شوال عام ألف وأربعمئة وسبعة وأربعين للهجرة");
  assert.equal(ar("تأسس عام 1445 هـ"), "تأسس عام ألف وأربعمئة وخمسة وأربعين للهجرة");
});

test("ar: Latin acronyms through the terms map (project terms win), T+n, the rest spelled or dropped", () => {
  assert.equal(ar("نوفر API وKYC وT+1."), "نوفر إيه بي آي وكيه واي سي وتي زائد واحد.");
  assert.equal(ar("الخدمات عبر Open Banking وsukuk."), "الخدمات عبر الخدمات المصرفية المفتوحة والصكوك.");
  assert.equal(speakable("منصة XYZ", { locale: "ar", terms: [["XYZ", "إكس واي زد"]] }), "منصة إكس واي زد");
  assert.equal(ar("رمز QR"), "رمز كيو آر");
  assert.ok(termsFor("ar").some(([k]) => k === "API"));
});

test("speakable(text, { locale: \"ar\" }): no Latin letters or digits are left", () => {
  const lines = ["نما السوق 12% في 2025 عبر API.", "الدفعة $100 أو 250 SAR في 2026-03-05.", "رمضان 1447/09/01 هـ وT+2.", "**مهم:** راجع https://example.org الآن 😀", "رقم ٣٤٥ و 6.75%"];
  for (const l of lines) assert.equal(unspeakable(l, { locale: "ar" }), "", l);
  assert.equal(unspeakable("مثال", "ar-SA"), "");
});

test("en: ordinals, years, ISO and Hijri dates, currencies and decimal percent", () => {
  assert.deepEqual([1, 2, 3, 5, 12, 20, 21, 40].map(ordinalWordsEn), ["first", "second", "third", "fifth", "twelfth", "twentieth", "twenty-first", "fortieth"]);
  assert.deepEqual([2026, 2000, 2005, 1999, 1447, 1900].map(yearWordsEn), ["twenty twenty-six", "two thousand", "two thousand five", "nineteen ninety-nine", "fourteen forty-seven", "nineteen hundred"]);
  const en = (s) => speakable(s, "en");
  assert.equal(en("Pay $100 or 250 SAR by 2026-03-05."), "Pay one hundred US dollars or two hundred fifty Saudi riyals by March fifth, twenty twenty-six.");
  assert.equal(en("Rates rose 4.25% on the 3rd."), "Rates rose four point two five percent on the third.");
  assert.equal(en("Ramadan starts 1447/09/01 AH."), "Ramadan starts the first of Ramadan, fourteen forty-seven AH.");
  assert.equal(en("It costs EUR 1, GBP 2 or 3.5 billion MYR."), "It costs one euro, two pounds sterling or three point five billion Malaysian ringgit.");
  for (const l of ["Pay $100 by 2026-03-05.", "Up 12% on the 21st.", "1447/09/01 AH"]) assert.equal(unspeakable(l, "en"), "", l);
});
