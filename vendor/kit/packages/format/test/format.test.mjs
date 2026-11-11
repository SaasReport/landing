// @saasreport/format: one formatter for every reader-facing number (Persian digits and separators for fa), and the
// scanner behind `kit check digits`: positives (what it must report) and negatives (what it must leave alone).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  digits, toLatinDigits, formatNumber, formatInteger, formatPercent, formatOrdinal, formatRange, formatList, formatTime,
  formatDuration, formatDate, formatter, localizeText, localizeHtml, faWords, lang,
} from "../src/index.js";
import { scanHtml, scanMarkdown, scanText, scanDigits, isPersianHtml, decodeEntities } from "../src/scan.js";

test("digits: any script in, the locale's digits out", () => {
  assert.equal(digits(1405, "fa"), "۱۴۰۵");
  assert.equal(digits("٢٠٢٦", "fa-IR"), "۲۰۲۶");
  assert.equal(digits("۱۴۰۵", "en"), "1405");
  assert.equal(digits(12, "ar"), "١٢");
  assert.equal(digits(7, { site: { locale: "fa-IR" } }), "۷");
  assert.equal(toLatinDigits("۱۴۰۴/۱۲/۲۸ و ٣"), "1404/12/28 و 3");
  assert.equal(lang("fa_IR"), "fa");
});

test("numbers: Persian digits with ٬ thousands and ٫ decimal; en untouched", () => {
  assert.equal(formatNumber(1234567.5, "fa"), "۱٬۲۳۴٬۵۶۷٫۵");
  assert.equal(formatNumber(1234567.5, "en"), "1,234,567.5");
  assert.equal(formatNumber(2.5, "fa", { decimals: 2 }), "۲٫۵۰");
  assert.equal(formatNumber(2.456, "fa", { maxDecimals: 1 }), "۲٫۵");
  assert.equal(formatNumber(1405, "fa", { grouping: false }), "۱۴۰۵");
  assert.equal(formatNumber(-3, "fa"), "−۳");
  assert.equal(formatNumber(0, "fa"), "۰");
  assert.equal(formatNumber(5, "fa", { minInt: 2 }), "۰۵");
  assert.equal(formatInteger(1405.9, "fa"), "۱۴۰۵");
  assert.doesNotMatch(formatNumber(98765.4321, "fa"), /[0-9٠-٩,.]/);
});

test("percent, ordinal, range, list, time, duration, date", () => {
  assert.equal(formatPercent(12.5, "fa"), "۱۲٫۵٪");
  assert.equal(formatPercent(40, "en"), "40%");
  assert.deepEqual([1, 2, 3, 4, 10, 21, 23, 30, 100, 1000].map((n) => formatOrdinal(n, "fa")),
    ["یکم", "دوم", "سوم", "چهارم", "دهم", "بیست و یکم", "بیست و سوم", "سی‌ام", "صدم", "هزارم"]);
  assert.equal(formatOrdinal(1, "fa", { first: "اول" }), "اول");
  assert.equal(formatOrdinal(21, "fa", { style: "numeric" }), "۲۱ام");
  assert.deepEqual([1, 2, 3, 11, 22].map((n) => formatOrdinal(n, "en")), ["1st", "2nd", "3rd", "11th", "22nd"]);
  assert.equal(faWords(1405), "هزار و چهارصد و پنج");
  assert.equal(formatRange(1, 5, "fa"), "۱ تا ۵");
  assert.equal(formatRange(1, 5, "en"), "1–5");
  assert.equal(formatList(["الف", "ب", 3], "fa"), "الف، ب و ۳");
  assert.equal(formatTime("06:00", "fa"), "۰۶:۰۰");
  assert.equal(formatTime({ minutes: 545 }, "fa"), "۰۹:۰۵");
  assert.equal(formatTime(new Date("2026-10-01T02:30:00Z"), "fa", { timeZone: "Asia/Tehran" }), "۰۶:۰۰");
  assert.equal(formatDuration(95, "fa"), "۱:۳۵");
  assert.equal(formatDuration(3725, "en"), "1:02:05");
  // Solar Hijri never goes through ICU's Persian calendar (a day off on Workers in 1405): @saasreport/calendar owns it
  assert.throws(() => formatDate("2026-10-01", "fa", { calendar: "jalali" }), /@saasreport\/calendar/);
  assert.throws(() => formatDate("2026-10-01", "fa", { calendar: "persian" }), /@saasreport\/calendar/);
  assert.match(formatDate("2026-10-01", "en"), /October 1, 2026|1 October 2026/);
  const f = formatter("fa");
  assert.equal(f.number(1200), "۱٬۲۰۰");
  assert.equal(f.percent(3), "۳٪");
});

test("localizeText: prose takes Persian digits; URLs, e-mails and Latin identifiers stay", () => {
  assert.equal(localizeText("تسویه T+1 در 1404/12/28", "fa"), "تسویه T+1 در ۱۴۰۴/۱۲/۲۸");
  assert.equal(localizeText("نسخه v1.2.0 و saasreport-cal و ISO-4217 و PSD2", "fa"), "نسخه v1.2.0 و saasreport-cal و ISO-4217 و PSD2");
  assert.equal(localizeText("https://saasreport.ai/api/v1 و a1@example.org و 3", "fa"), "https://saasreport.ai/api/v1 و a1@example.org و ۳");
  assert.equal(localizeText("3 کار", "en"), "3 کار");
});

test("localizeHtml: text and reader attributes localized; code, URLs, other attributes and marked elements kept", () => {
  const out = localizeHtml('<p title="قسمت 3" data-n="3"><a href="/blog/2">بخش 2</a> <code>v 12</code> &#8206;5 <time datetime="2026-10-01">1 مهر</time> <span data-digits="latin" data-digits-reason="ISBN">978</span><script>let a=1</script></p>', "fa");
  assert.equal(out, '<p title="قسمت ۳" data-n="3"><a href="/blog/2">بخش ۲</a> <code>v 12</code> &#8206;۵ <time datetime="2026-10-01">۱ مهر</time> <span data-digits="latin" data-digits-reason="ISBN">978</span><script>let a=1</script></p>');
  assert.equal(localizeHtml("<p>3</p>", "en"), "<p>3</p>");
  assert.deepEqual(scanHtml(out), []);
});

test("scanHtml: reports Latin and Arabic-Indic digits in text, reader attributes, meta and Persian JSON-LD", () => {
  const html = `<!doctype html><html lang="fa"><head><title>سال 2026</title><meta name="description" content="۱۰ واژه و 5 قسمت">
<meta property="og:url" content="https://x.example/2"><script type="application/ld+json">{"name":"قسمت 7","url":"https://a/1","alternateName":"Episode 7"}</script></head>
<body><p aria-label="مرحله 3">٣ روز</p><img alt="نمودار 4" src="/a/1.png"><input placeholder="مثلاً 1404/01/01"></body></html>`;
  const f = scanHtml(html);
  assert.deepEqual(f.map((x) => [x.kind, x.where, x.match]), [
    ["latin-digit", "text", "2026"], ["latin-digit", "meta:description", "5"], ["latin-digit", "json-ld:name", "7"],
    ["latin-digit", "attr:aria-label", "3"], ["arabic-digit", "text", "٣"], ["latin-digit", "attr:alt", "4"],
    ["latin-digit", "attr:placeholder", "1404"], ["latin-digit", "attr:placeholder", "01"], ["latin-digit", "attr:placeholder", "01"],
  ]);
  assert.equal(f[0].line, 1);
  assert.equal(f[3].line, 3);
  assert.equal(isPersianHtml(html), true);
  assert.equal(isPersianHtml('<html lang="en">'), false);
});

test("scanHtml negatives: code, pre, kbd, samp, scripts, styles, hrefs, data-*, identifiers, entities, marked elements", () => {
  const html = `<html lang="fa"><body><pre>curl /api/v1?t=1</pre><code>T+2</code><kbd>Ctrl+1</kbd><samp>exit 0</samp>
<script>var x = 12;</script><style>.a{width:10px}</style><a href="/blog/2026" data-id="9" class="c2">saasreport-cal و ISO-4217 و v1.2.0 و T+1</a>
<span>&#1777;&#x6F2; &amp; &nbsp;</span><svg viewBox="0 0 24 24"><path d="M0 0h24v24"/></svg>
<div data-digits="latin" data-digits-reason="شماره ثبت رسمی به همان شکل سند"><b>123</b></div><!-- 99 --></body></html>`;
  assert.deepEqual(scanHtml(html), []);
});

test("scanHtml: a data-digits marker without a reason is a finding (and does not exempt)", () => {
  const f = scanHtml('<p data-digits="latin">12</p><p data-digits="persian">۱</p>');
  assert.deepEqual(f.map((x) => x.kind), ["marker", "latin-digit", "marker"]);
});

test("scanHtml: «·» next to a Persian digit is a bidi finding; elsewhere it is fine", () => {
  assert.deepEqual(scanHtml("<p>۱۴۰۵ · پنج دقیقه</p>").map((x) => x.kind), ["bidi-dot"]);
  assert.deepEqual(scanHtml("<p>بلاگ · پادکست</p>"), []);
});

test("scanHtml: SVG text is read, SVG geometry is not", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect x="10" y="20"/><text x="40" y="80">قسمت 12</text><title>۱۲</title></svg>';
  assert.deepEqual(scanDigits(svg, { file: "og.svg" }).map((x) => x.match), ["12"]);
});

test("scanMarkdown: prose and front matter title/description; code, links, URLs and other keys exempt", () => {
  const md = `---
title: قسمت 3
url: https://x.example/3
date: 2026-10-01
description: "۵ نکته"
---
# بخش 2

متن با \`v1 2\` و [پیوند](https://x.example/9) و <https://y.example/8> و saasreport-cal-2.

\`\`\`
1 2 3
\`\`\`
- مورد ٤
[ref]: https://x.example/7
`;
  assert.deepEqual(scanMarkdown(md).map((x) => [x.line, x.kind, x.where, x.match]), [
    [2, "latin-digit", "front-matter:title", "3"], [7, "latin-digit", "md", "2"], [14, "arabic-digit", "md", "٤"],
  ]);
});

test("scanText (llms.txt): only the lines in Persian are Persian copy", () => {
  const txt = "# SaasReport\n> 379 terms\n- [واژه 12](https://x.example/12): تعریف ۱۲\n- [Term 4](https://x.example/4)\n";
  assert.deepEqual(scanText(txt).map((x) => [x.line, x.match]), [[3, "12"]]);
});

test("decodeEntities: numeric references decode (so &#49; is a digit 1), named ones too", () => {
  assert.equal(decodeEntities("&#49;&#x31;&amp;&laquo;&unknown;"), "11&« ");
  assert.deepEqual(scanHtml("<p>&#49;</p>").map((x) => x.match), ["1"]);
});

test("scanDigits rejects unknown types", () => {
  assert.throws(() => scanDigits("x", { file: "a.css" }), /unknown type/);
});

test("pack overrides: numerals and separators of a site locale pack", () => {
  assert.equal(formatNumber(1234.5, "ar", { numerals: "latin" }), "1٬234٫5");
  assert.equal(formatPercent(5, "fa", { separators: { percent: "%" } }), "۵%");
});

test("browser module: same exports as the package, sets globalThis.KitFormat", async () => {
  const { formatForBrowser, NAMES } = await import("../src/browser.js");
  const mod = await import("../src/index.js");
  assert.deepEqual([...NAMES].sort(), Object.keys(mod).sort());
  const src = formatForBrowser();
  assert.doesNotMatch(src, /^\s*(import|export)\b/m);
  const { runInNewContext } = await import("node:vm");
  const g = { Intl, Number, String, Math, Object, Array, Date, RegExp, Error };
  g.globalThis = g;
  runInNewContext(src, g);
  assert.deepEqual(Object.keys(g.KitFormat).sort(), [...NAMES].sort());
  assert.equal(g.KitFormat.formatNumber(1200, "fa"), "۱٬۲۰۰");
  assert.equal(g.KitFormat.localizeText("قسمت 3", "fa"), "قسمت ۳");
  assert.equal(g.KitFormat.formatPercent(12.5, "fa"), "۱۲٫۵٪");
});

test("calendar's digit tables are copies of this package's (calendar has no dependencies; tested against the source)", async () => {
  const cal = await import("@saasreport/calendar/locale");
  const idx = await import("@saasreport/calendar");
  assert.deepEqual({ ...cal.DIGITS }, { ...(await import("../src/index.js")).DIGIT_SETS });
  assert.equal(idx.fa("1405/07/09"), digits("1405/07/09", "fa"));
  assert.equal(idx.latin("۱۴۰۵ ٣"), toLatinDigits("۱۴۰۵ ٣"));
});

test("localizeMarkdown: prose, front matter and ordered items localized; code, links, URLs kept; checker agrees", async () => {
  const { localizeMarkdown } = await import("../src/index.js");
  const md = "---\ntitle: قسمت 3\nurl: https://x.example/3\n---\n# بخش 2\n\n1. [خانه](https://x.example/1)\n2. ۲ گام دوم\n\nمتن 12 با `v1 2` و <https://y.example/8> و T+1\n```\n1 2\n```\n";
  const out = localizeMarkdown(md, "fa");
  assert.equal(out, "---\ntitle: قسمت ۳\nurl: https://x.example/3\n---\n# بخش ۲\n\n- ۱. [خانه](https://x.example/1)\n- ۲ گام دوم\n\nمتن ۱۲ با `v1 2` و <https://y.example/8> و T+1\n```\n1 2\n```\n");
  assert.deepEqual(scanMarkdown(out), []);
  assert.equal(localizeMarkdown("# Title 2\n- [واژه 3](https://x/3)", "fa", { persianLinesOnly: true }), "# Title 2\n- [واژه ۳](https://x/3)");
});

test("localizeHtml: meta descriptions and Persian JSON-LD values too (what the checker reads)", () => {
  const html = '<html lang="fa"><head><meta name="description" content="۱۰ واژه و 5 قسمت"><meta property="og:url" content="https://x/5"><script type="application/ld+json">{"name":"قسمت 7","url":"https://a/1","alternateName":"Episode 7","x":"\\u003c"}</script></head><body></body></html>';
  const out = localizeHtml(html, "fa");
  assert.match(out, /content="۱۰ واژه و ۵ قسمت"/);
  assert.match(out, /content="https:\/\/x\/5"/);
  assert.match(out, /"name":"قسمت ۷","url":"https:\/\/a\/1","alternateName":"Episode 7"/);
  assert.deepEqual(scanHtml(out), []);
});

test("scopeSource for Latin-script locales drops a comment that quotes Arabic script and keeps every other comment; Arabic script anywhere else is an error, not a leftover", async () => {
  const { scopeSource } = await import("../src/browser.js");
  const AR = "مثال";   // an Arabic word, written as escapes so this file holds none
  const src = [
    "/** Doc comment with an example: " + AR + " */",
    "// " + AR + " alone on a line",
    "// the reason: a failed probe is the answer",
    "export function f() {",
    "  try { return g(); }",
    "  catch { /* the probe failing is the answer: false */ }",
    "  // another reason kept beside the code",
    "}",
  ].join("\n");
  const latin = scopeSource(src, { persian: false });
  assert.doesNotMatch(latin, /[؀-ۿ]/, "no Arabic script is left");
  assert.match(latin, /the reason: a failed probe is the answer/, "a line comment without Arabic script stays");
  assert.match(latin, /catch \{ \/\* the probe failing is the answer: false \*\/ \}/, "the reason written inside a catch stays (the swallowed-error gate reads it in a built site)");
  assert.match(latin, /another reason kept beside the code/);
  assert.equal(scopeSource(src, { persian: true }), src, "a Persian build keeps every line as it is");
  assert.throws(() => scopeSource("export const w = \"" + AR + "\";\n", { persian: false }), /still holds Arabic-script text at line 1/, "Arabic script in code, outside a region, fails the build loudly");
  assert.doesNotThrow(() => scopeSource("//#if fa,ar\nexport const w = \"" + AR + "\";\n//#else\n//| export const w = \"\";\n//#end\n", { persian: false }), "the same text inside a region is the region's business");
});

test("browser build scoped to Latin-script locales: no Persian or Arabic script at all, the same English output, a loud refusal for Persian words; a Persian site keeps everything", async () => {
  const { formatForBrowser, NAMES } = await import("../src/browser.js");
  const { runInNewContext } = await import("node:vm");
  const load = (opts) => { const g = { Intl, Number, String, Math, Object, Array, Date, RegExp, Error, RangeError }; g.globalThis = g; runInNewContext(formatForBrowser(opts), g); return g.KitFormat; };
  const latin = formatForBrowser({ locales: [{ code: "en" }] });
  assert.doesNotMatch(latin, /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/, "no Arabic-script character is left in an English-only format.js");
  assert.doesNotMatch(latin, /^\s*\/\/[#|]/m, "no region marker is left");
  const en = load({ locales: ["en", "de-DE"] }), full = load();
  assert.deepEqual(Object.keys(en).sort(), [...NAMES].sort(), "the same API");
  for (const [fn, args] of [["formatNumber", [1234567.5, "en"]], ["formatPercent", [12.5, "en"]], ["formatOrdinal", [22, "en"]], ["formatRange", [1, 5, "en"]], ["formatList", [["a", "b", "c"], "en"]], ["formatTime", ["06:00", "en"]], ["formatDuration", [95, "en"]], ["digits", [1405, "en"]], ["toLatinDigits", ["1405"]]]) {
    assert.equal(en[fn](...args), full[fn](...args), fn);
  }
  assert.equal(en.formatJalali(new Date("2026-10-03T12:00:00Z"), { locale: "en", timeZone: "UTC" }), full.formatJalali(new Date("2026-10-03T12:00:00Z"), { locale: "en", timeZone: "UTC" }), "the Jalali calendar in English transliteration still works");
  assert.throws(() => en.faWords(3), /not built into this format\.js/);
  // the full build still has the Persian tables, for a site that serves fa or ar (and for no locales given)
  for (const opts of [undefined, { locales: ["fa"] }, { locales: [{ code: "ar-SA" }, { code: "en" }] }]) assert.match(formatForBrowser(opts), /۰۱۲۳۴۵۶۷۸۹/);
  assert.equal(load({ locales: ["fa"] }).formatNumber(1200, "fa"), "۱٬۲۰۰");
});
