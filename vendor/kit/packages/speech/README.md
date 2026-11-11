# @saasreport/speech

Spoken-text normalizer for TTS scripts, plus small helpers for two-voice conversations. Pure, dependency-free,
runs in Workers, Node ≥ 20 and browsers. License: Apache-2.0.

```js
import { speakable, unspeakable, numberWords, ordinalWords, numbersIn, mergeTurns, estimateMs } from "@saasreport/speech";

speakable("پنجشنبه ۲۸ اسفند ۱۴۰۴ با T+1");      // "پنجشنبه بیست و هشتم اسفند هزار و چهارصد و چهار با تی پلاس یک"
speakable("نرخ ۲۳٪ و API", "fa");               // "نرخ بیست و سه درصد و ای‌پی‌آی"
speakable("Rates rose 23% in 2026", { locale: "en" }); // "Rates rose twenty-three percent in two thousand twenty-six"
unspeakable("سلام SDK12");                        // "" when a voice can read everything, else the leftover characters
numbersIn("۲۸ اسفند 1404 و ۱٬۲۰۰");               // [28, 1404, 1200] — for factual guards on generated scripts
mergeTurns([{ speaker: "host", text: "a" }, { speaker: "host", text: "b" }]); // [{ speaker: "host", text: "a b" }]
estimateMs(lines, 11);                             // duration estimate at 11 characters per second (default)
```

## Locales
- `fa` (default): strips Markdown, code, links and emoji; numbers, percentages, decimals and Jalali dates (`1405/01/05`) in words;
  day-before-month-name as an ordinal; `T+n` settlement notation; a generic list of finance/tech Latin terms (`TERMS_FA`:
  API, SDK, JSON, webhook, IBAN, KYC, Open Banking, …) in Persian; remaining short acronyms spelled letter by letter; other Latin words dropped.
- `en`: strips Markdown/links/emoji, numbers and percentages in words, `T+n` → "T plus n"; Latin text is kept.
- Any BCP-47 tag works (`fa-IR`, `en-US`); the language subtag picks the pack.

## Project terms
Brand names and project acronyms do not belong in the core list. Pass them per call or via the kit config
(`speech: { terms }`, which `@saasreport/core` forwards):

```js
speakable(text, { locale: "fa", terms: [["ACME", "اِکمی"]] });   // adds to / overrides the built-in list
speakable(text, { locale: "fa", terms: { API: "اِی پی آی" }, defaults: false }); // only your terms
```

## API
`speakable(text, locale | { locale, terms, defaults })`, `unspeakable(text, opts)`, `numberWords(n)`, `ordinalWords(n)` (Persian),
`numberWordsEn(n)`, `toLatinDigits(s)`, `termsFor(locale, { terms, defaults })`, `TERMS_FA`, `TERMS_EN`, `numbersIn(s)`,
`mergeTurns(lines)`, `estimateMs(lines, cps = 11)` (lines as `{text}` objects, `[speaker, text]` pairs or strings), `CHARS_PER_SECOND`.

## Arabic (`ar`) and English additions

```js
speakable("نما السوق ٢٥٪ في عام 2026 عبر API بقيمة 3.5 مليار SAR", { locale: "ar" });
// → "نما السوق خمسة وعشرون بالمئة في عام ألفين وستة وعشرين عبر إيه بي آي بقيمة ثلاثة فاصلة خمسة مليار ريال سعودي"
speakable("1447/09/01 هـ", "ar");   // → "الأول من رمضان عام ألف وأربعمئة وسبعة وأربعين للهجرة"
unspeakable(line, { locale: "ar" }); // "" when no Latin letter or digit is left
```

`ar`: Arabic-Indic and Latin digits in words (`numberWordsAr`, `ordinalWordsAr`), decimals and percent, currencies by code,
symbol and scale (USD, SAR, AED, MYR, GBP, EUR: `CURRENCIES`), Gregorian (ISO, d/m/yyyy, "5 مارس 2026") and Hijri dates
(`1447/09/01 هـ`, Hijri month names), T+n, Latin terms via `TERMS_AR` (project terms win), other acronyms spelled letter by letter.
`en` now also reads ordinals (`ordinalWordsEn`), years (`yearWordsEn`), ISO and Hijri dates and the same currencies.
