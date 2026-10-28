/**
 * The Persian normalizer: one canonical spelling, so a rule is written once and matches every way the text was typed.
 *
 *   normalize(text) → text with Persian ی and ک, Persian digits for Arabic-Indic ones, presentation forms folded, ZWNJ in
 *                     compounds (می\u200C، \u200Cها، \u200Cای، \u200Cتر …), Persian punctuation between Persian words and single spaces.
 *
 * Newlines are kept, so a line number found in the normalized text is the line in the source. Latin text, Latin digits,
 * URLs and code are left alone: the digit rule of the constitution is enforced on rendered output (kit check digits).
 *
 * Parts of this file are derived from Virastar 0.22.1 (https://github.com/brothersincode/virastar),
 * Copyright (c) 2011 Allen A. Bargi, Copyright (c) 2025 Brothers in Code, MIT License (packages/fa-lint/NOTICE):
 * the non-Persian character map (fixMiscNonPersianChars), the ZWNJ clean-up (cleanupZWNJ, cleanupZWNJLate), the prefix
 * and suffix spacing (fixPerfixSpacing, fixSuffixSpacing, fixSuffixSpacingHamzeh) and the kashida clean-up. Changes:
 * rewritten as one pure function over a segment; «بی» is not joined (it is often a separate word: «بی آن\u200Cکه»); Latin
 * digits are not converted; presentation forms are folded with NFKC instead of a glyph table; the HTML/URI preservers are
 * not needed (the extractor hands over plain text).
 */

/** Persian letters (and the Arabic letters Persian text uses). */
export const FA_LETTERS = "\\u0621-\\u063A\\u0641-\\u064A\\u067E\\u0686\\u0698\\u06A9\\u06AF\\u06CC";
/** Combining marks that sit on Persian letters (harakat, hamza above, superscript alef). */
export const FA_MARKS = "\\u064B-\\u0655\\u0670";
export const ZWNJ = "\u200C";

const FA = `[${FA_LETTERS}${FA_MARKS}]`;
const re = (s, f = "gu") => new RegExp(s, f);

// Virastar fixMiscNonPersianChars: 'كڪيےىۍېہە' → 'ککیییییههه'
const MISC_FROM = "كڪيےىۍېہە", MISC_TO = "ککیییییههه";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩", FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const MAP = new Map([...MISC_FROM].map((c, i) => [c, MISC_TO[i]]).concat([...AR_DIGITS].map((c, i) => [c, FA_DIGITS[i]])));

// Virastar fixSuffixSpacing: the suffixes that join their word with a ZWNJ when typed with a space.
// Changed from Virastar: the person and indefinite endings (ام، ای، اند …) join with a ZWNJ only after a silent «ه»
// («رفته\u200Cاند», «خانه\u200Cای»); after other letters they join directly, and a free-standing «ای» is a word («ای کاش»).
const SUFFIXES = "ها|های|هایی|هایم|هایت|هایش|هایمان|هایتان|هایشان|تر|تری|ترین";
const AFTER_HEH = "ام|ات|اش|ای|اید|ایم|اند|مان|تان|شان";
const SHORT_HEH = new Set(["که", "چه", "نه", "به"]);
const AFTER = "(?=$|[\\s.,;،؛:!؟?\"'()\\[\\]{}«»…])";

export function normalize(input) {
  let t = String(input ?? "");
  // presentation forms (ﻫ, ﻼ, ﯾ …) → base letters
  t = t.replace(/[ﭐ-﷿ﹰ-\uFEFF]/g, (c) => (c === "\uFEFF" ? "" : c.normalize("NFKC")));
  t = t.replace(/[كڪيےىۍېہە٠-٩]/g, (c) => MAP.get(c));
  // invisible direction marks carry no text (RLM, LRM, ALM); a ZWJ is a mistyped ZWNJ; a narrow no-break space is a space
  t = t.replace(/[\u200E\u200F\u061C]/g, "").replace(/\u200D/g, ZWNJ).replace(/\u202F/g, " ");
  // ZWNJ: soft hyphen is a mistyped ZWNJ; one at a time; none next to spaces, punctuation or digits; none at line ends
  t = t.replace(/\u00AD/g, ZWNJ).replace(/\u200C{2,}/g, ZWNJ)
    .replace(/\u200C(?=[\sA-Za-z0-9۰-۹[\](){}«»“”.…,:;?!$%@#*=+\-/\\،؛٫٬×٪؟ـ])/g, "")
    .replace(/([\sA-Za-z0-9۰-۹[\](){}«»“”.…,:;?!$%@#*=+\-/\\،؛٫٬×٪؟ـ])\u200C/g, "$1")
    .replace(/^\u200C|\u200C$/gm, "");
  // kashida between letters is decoration, not text
  t = t.replace(re(`(${FA})\\u0640+(?=${FA})`), "$1");
  // spaces: one, never before Persian punctuation
  t = t.replace(/[ \t ]+/g, " ").replace(re(`(${FA}) ([،؛:!؟.])(?!\\.)`), "$1$2");
  // Latin , ; ? between or after Persian words → Persian marks
  t = t.replace(re(`(${FA}) ?, ?(?=${FA})`), "$1، ").replace(re(`(${FA}) ?; ?(?=${FA})`), "$1؛ ").replace(re(`(${FA}) ?\\?`), "$1؟");
  // Virastar fixPerfixSpacing (without «بی»): «می شود» / «نمی شود» → «می\u200Cشود»
  // (not the month «می», May: «ماه می گذشته»)
  t = t.replace(re(`(^|[\\s«(])(?<!ماه[ \\u2028])(ن?می) (?=${FA})`), `$1$2${ZWNJ}`);
  // Virastar fixSuffixSpacingHamzeh: «خانه ی» → «خانه\u200Cی»
  t = t.replace(re(`(${FA})ه[ \\u200c]+ی${AFTER}`), `$1ه${ZWNJ}ی`);
  // Virastar fixSuffixSpacing: «کتاب ها» → «کتاب\u200Cها», «بیش تر» → «بیش\u200Cتر», «رفته اند» → «رفته\u200Cاند»
  t = t.replace(re(`(${FA}) (${SUFFIXES})${AFTER}`), `$1${ZWNJ}$2`);
  t = t.replace(re(`(${FA}*ه) (${AFTER_HEH})${AFTER}`), (m, w, x) => (SHORT_HEH.has(w) ? m : `${w}${ZWNJ}${x}`));
  // Virastar cleanupZWNJLate: no ZWNJ after letters that do not join the next one
  t = t.replace(/([إأةؤورزژاآدذ])\u200C/g, "$1");
  return t;
}

/** Persian letters in a string? (a segment without any is not Persian copy) */
export const hasPersian = (s) => re(`[${FA_LETTERS}]`, "u").test(String(s ?? ""));

/**
 * Is a segment Arabic rather than Persian? Arabic copy (an ar locale in a shared strings file, a quoted verse or legal
 * maxim) is not checked against Persian rules. Arabic: it has a Persian-only letter (پ چ ژ گ) or a Persian ی/ک nowhere,
 * and it has a mark of Arabic (ة, the article «ال»; not tanwin, which Persian writes too). A Persian sentence mistyped with Arabic ي/ك has no ة or «ال»
 * and stays Persian, so the ی/ک rules still catch it. With broad (a file mixing fa and ar strings), any Arabic ي/ك/ى without a
 * Persian letter (or an Arabic-Indic digit ٠–٩) marks Arabic.
 */
export function isArabic(s, { broad = false } = {}) {
  const t = String(s ?? "");
  if (/[\u067E\u0686\u0698\u06AF\u06A9\u06CC]/u.test(t)) return false;
  // broad (a file that holds fa and ar side by side): any Arabic ي/ك/ى without a Persian letter is Arabic
  // tanwin is not a mark of Arabic: Persian writes «دقیقاً», «اصلاً»
  return /\u0629|(?:^|[\s«(])ال[\u0621-\u064A]{2,}/u.test(t) || (broad && /[\u064A\u0643\u0649\u0660-\u0669]/u.test(t));
}
