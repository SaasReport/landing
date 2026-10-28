// The normalizer, the engine (classes, registers, unless, Arabic segments) and the extractor (JSON keys, JS literals,
// Markdown front matter, HTML) of @saasreport/fa-lint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, isArabic, compile, expand, persianLinter, checkScript, checkExamples, segments, rewriteSegments, plainText, KIT_RULES } from "../src/index.js";
import { literals } from "../../cli/src/canon/files.js";

const Z = "‌";

test("normalize: Persian ی/ک and digits, ZWNJ in compounds, Persian punctuation; newlines kept", () => {
  assert.equal(normalize("كتاب ها مي شود"), `کتاب${Z}ها می${Z}شود`);
  assert.equal(normalize("خانه ای بزرگ"), `خانه${Z}ای بزرگ`);
  assert.equal(normalize("که ای کاش"), "که ای کاش");
  assert.equal(normalize("رفته اند و بیش تر"), `رفته${Z}اند و بیش${Z}تر`);
  assert.equal(normalize("سال ١٤٠٥ , آیا?"), "سال ۱۴۰۵ , آیا؟");
  assert.equal(normalize("الف , ب"), "الف، ب");
  assert.equal(normalize(`تصمیم${Z} ها\nدوم`), `تصمیم${Z}ها\nدوم`);
  assert.equal(normalize("ﻫﻤﻪ"), "همه");
  assert.equal(normalize("بـــانک"), "بانک");
});

test("isArabic: an Arabic quotation is not Persian copy; a Persian sentence with Arabic ي/ك still is", () => {
  assert.equal(isArabic("لا ضرر ولا ضرار في الإسلام"), true);
  assert.equal(isArabic("بانك مركزي"), false);
  assert.equal(isArabic("بانک مرکزی"), false);
  assert.equal(isArabic("يناير"), false);
  assert.equal(isArabic("يناير", { broad: true }), true);
  const l = persianLinter();
  assert.deepEqual(l.lint("الرئيسية، و التقويم"), []);
  assert.ok(l.lint("بانك مركزي").some((f) => f.rule === "fa-arabic-kaf"));
});

test("classes: {{name}} expands longest first, unknown classes throw, an empty class makes its rule inactive", () => {
  const { source } = expand("{{<}}{{x}}{{>}}", { x: ["حق", "حق بیمه"] });
  assert.ok(source.indexOf("حق[ \\u200c]+بیمه") < source.indexOf("|حق)"));
  assert.throws(() => expand("{{nope}}", {}), /unknown class/);
  const l = compile([KIT_RULES]);
  assert.equal(l.rules.find((r) => r.id === "fa-brand-before-head").inactive, true);
  assert.deepEqual(l.lint("اکمی پروتکل").filter((f) => f.rule === "fa-brand-before-head"), []);
  const p = persianLinter({ classes: { brand: ["اکمی"] } });
  assert.deepEqual(p.lint("اکمی پروتکل").filter((f) => f.rule === "fa-brand-before-head").map((f) => f.suggestion), ["پروتکل اکمی"]);
});

test("a project pack adds rules and words; it proves itself with the kit's checkExamples", () => {
  const pack = { pack: "p", version: 1, classes: { commonHead: ["درگاه"] }, rules: [{ id: "fa-p-glossary", layer: "glossary", on: "normalized", pattern: "{{<}}پایلوت{{>}}", fix: "دوره آزمایشی", reason: "واژه‌نامه پروژه: pilot = دوره آزمایشی", source: { kind: "proofread", ref: "glossary.md" }, severity: "error", examples: { fail: ["پایلوت سه‌ماهه"], pass: ["دوره آزمایشی سه‌ماهه"] } }] };
  assert.deepEqual(checkExamples([KIT_RULES, pack], { brand: ["اکمی"] }).filter((s) => s.startsWith("fa-p-")), []);
  const l = persianLinter({ packs: [pack], classes: { brand: ["اکمی"] } });
  assert.ok(l.lint("اکمی درگاه").some((f) => f.rule === "fa-brand-before-head"));
  assert.ok(l.lint("پایلوت").some((f) => f.rule === "fa-p-glossary"));
  assert.throws(() => persianLinter({ packs: [{ ...pack, rules: [{ ...pack.rules[0], id: "fa-bi-calque" }] }] }), /defined twice/);
});

test("registers: written-only rules skip spoken scripts; line numbers are segment-relative", () => {
  const l = persianLinter();
  assert.ok(l.lint("این پرسش‌ها را پاسخ داد.").some((f) => f.rule === "fa-ra-pasokh"));
  assert.ok(!l.lint("این پرسش‌ها را پاسخ داد.", { register: "spoken" }).some((f) => f.rule === "fa-ra-pasokh"));
  const [f] = l.lint("خط اول\nخط دوم، و سوم");
  assert.equal(f.line, 1);
});

test("checkScript: the podcast gate fails a script with an error and names the line and speaker", () => {
  const r = checkScript([{ speaker: "host", text: "سلام!" }, { speaker: "expert", text: "مثلاً قسط ماشین، چک، یا سپرده." }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.findings.map((f) => [f.line, f.speaker, f.rule]), [[2, "expert", "fa-comma-before-conj"]]);
  // a clause comma is an error too (no warning level): the script is not voiced
  const w = checkScript([{ speaker: "host", text: "یه لایه‌ی اختیار، و یه ردپای شواهد." }]);
  assert.equal(w.ok, false);
  assert.deepEqual(w.findings.map((f) => [f.rule, f.severity]), [["fa-comma-before-conj-clause", "error"]]);
});

test("segments: JSON values (not keys) with their key, JS literals, Markdown front matter per item, HTML text and attributes", () => {
  const json = '{\n  "title": "سلام",\n  "سلام": 1,\n  "list": ["یک", "two"]\n}';
  assert.deepEqual(segments("a.json", json).map((s) => [s.line, s.text, s.key]), [[2, "سلام", "title"], [4, "یک", null]]);
  const js = 'const a = { quote: "نقل قول", body: `متن ${x} و <b>پررنگ</b>` };';
  assert.deepEqual(segments("a.js", js, { literals }).map((s) => [s.text, s.key]), [["نقل قول", "quote"], ["متن ￼ و پررنگ", "body"]]);
  const md = "---\ntitle: پرداخت خسارت\ntags: [تقویم مالی, تسویه, API]\n---\nبند اول\nادامه `کد` [پیوند](https://x.example)\n\n```\nکد فارسی\n```\nبند دوم\n";
  const segs = segments("a.md", md);
  assert.deepEqual(segs.map((s) => [s.line, s.text, s.key ?? null]), [[2, "پرداخت خسارت", "title"], [3, "تقویم مالی", "tags"], [3, "تسویه", "tags"], [5, "بند اول ادامه ￼ پیوند", undefined], [11, "بند دوم", undefined]].map((x) => [x[0], x[1], x[2] ?? null]));
  // the YAML list keeps its commas when a fix rewrites the items
  const fixed = rewriteSegments(md, segs, (raw) => raw.replace("تسویه", "تسویهٔ"));
  assert.match(fixed, /tags: \[تقویم مالی, تسویهٔ, API\]/);
  const html = '<p title="عنوان">متن <b>پررنگ</b>،و</p><script>var s="اسکریپت"</script><pre>کد</pre>';
  assert.deepEqual(segments("a.html", html).map((s) => s.text.trim()), ["عنوان", "\u2029متن پررنگ،و\u2029\uFFFC"].map((x) => x.trim()));
  assert.equal(plainText("&laquo;سلام&raquo;&zwnj;ها"), `«سلام»${Z}ها`);
});

test("rewriteSegments + fix: typography autofix rewrites JSON strings in place and leaves the rest of the file alone", () => {
  const l = persianLinter();
  const src = '{\n  "a": "پرداخت ، رد، و ارجاع می شود",\n  "url": "https://x.example/a,b"\n}\n';
  const out = rewriteSegments(src, segments("x.json", src), (raw) => l.fix(raw));
  assert.equal(JSON.parse(out).a, `پرداخت، رد و ارجاع می${Z}شود`);
  assert.equal(JSON.parse(out).url, "https://x.example/a,b");
});

test("safeFix: markup, URLs, link targets, image paths, scripts and code are never rewritten (the reviewer's cases)", async () => {
  const { safeFix } = await import("../src/index.js");
  const l = persianLinter();
  const same = (s) => assert.equal(safeFix(s, l).text, s, s);
  same("[بانک‌ها](https://fa.wikipedia.org/wiki/بانک_ها)");
  same("ببین ![تصویر](/img/فارسی ها.png)");
  same('<img src="/img/فارسی ها.png" alt="نقشه">');
  same("<script>const t = \"کتاب ها گرفته شد\";</script>");
  same("`می شود` و ${x}");
  same("یادت نره ها");
  same("ماه می گذشته");
  // the prose around them is still fixed, and the skeleton stays byte-identical
  assert.equal(safeFix("ببین ![تصویر](/img/فارسی ها.png) کتاب ها گرفته شد", l).text, "ببین ![تصویر](/img/فارسی ها.png) کتاب\u200cها گرفته شد");
  assert.equal(safeFix("[ویکی‌پدیا](https://fa.wikipedia.org/wiki/بانک_ها) را دیدم، مثلاً پرداخت، رد، و ارجاع", l).text, "[ویکی‌پدیا](https://fa.wikipedia.org/wiki/بانک_ها) را دیدم، مثلاً پرداخت، رد و ارجاع");
  assert.equal(safeFix('"\\u200cمی شود"', l).text, '"\\u200cمی\u200cشود"');
});

test("patterns match across invisible marks, U+202F and Markdown line breaks; tanwin does not make Persian Arabic", () => {
  const l = persianLinter({ classes: { brand: ["اکمی"] } });
  const has = (s, id) => l.lint(s).some((f) => f.rule === id);
  assert.ok(has("اکمی\u200f پروتکل", "fa-brand-before-head"));
  assert.ok(has("اکمی\u202fپروتکل", "fa-brand-before-head"));
  assert.ok(has("تصمیم‌ها بی\u200dپاسخ به یک پرسش", "fa-bi-calque"));
  assert.ok(has(plainText("تصمیم‌ها بی‌پاسخ  \nبه یک پرسش ساده"), "fa-bi-calque"));
  assert.ok(has(plainText("خسارت\nپرداخت"), "fa-object-before-verbal-noun"));
  assert.ok(has("تصمیم‌ها بی پاسخ به یک پرسش", "fa-bi-calque"));
  assert.equal(isArabic("دقیقاً همین"), false);
  assert.ok(has("اصلاً بانك", "fa-arabic-kaf"));
});

test("safeFix: a link target with parentheses is one opaque span (B2); an inline <code> before punctuation is not prose (B3)", async () => {
  const { safeFix, segments } = await import("../src/index.js");
  const l = persianLinter();
  const link = "[لینک](/a/(b) ها/می رود.png)";
  assert.equal(safeFix(link, l).text, link);
  assert.equal(safeFix(`${link} کتاب ها گرفته شد`, l).text, `${link} کتاب‌ها گرفته شد`);
  assert.equal(safeFix("![نقشه](/img/a (1) ها.png) و کتاب ها گرفته", l).text, "![نقشه](/img/a (1) ها.png) و کتاب\u200cها گرفته");
  assert.equal(safeFix("[x](/a/(b ها", l).text, "[x](/a/(b ها", "an unclosed target runs to the end of the line");
  // B3: «موفق <code>#15803D</code>، هشدار» has no «word space comma»
  const html = "<p>موفق <code>#15803D</code>، هشدار</p>";
  const segs = segments("a.html", html);
  assert.equal(segs.length, 1);
  assert.deepEqual(l.lint(segs[0].text).filter((f) => f.rule === "fa-space-before-punct"), []);
  // offsets are kept: the region of the segment still points into the source
  assert.ok(html.slice(segs[0].start, segs[0].end).includes("<code>#15803D</code>"));
});

test("the linter masks balanced-parenthesis link targets: nothing inside «](…)» is prose", () => {
  const l = persianLinter();
  const rules = (s) => l.lint(plainText(s)).map((f) => f.rule);
  assert.deepEqual(rules("[لینک](/a/(b) ها/می رود.png) کتاب‌ها"), []);
  assert.deepEqual(rules("![نقشه](/img/a (1) ها.png) و پرونده‌ها"), []);
  assert.equal(plainText("[لینک](/a/(b) ها/می رود.png) و ادامه"), "لینک و ادامه");
  assert.equal(plainText("[الف](/x) و [ب](/y/(z))"), "الف و ب");
  assert.equal(plainText("[x](/a/(b ها\nبعد"), "x\u2028بعد", "an unclosed target runs to the end of the line");
  // prose after the link is still checked
  assert.ok(rules("[لینک](/a/(b) ها) کتاب ها گرفته شد").includes("fa-plural-space"));
  // through the extractor, as kit check persian reads a Markdown file
  const segs = segments("a.md", "ببین [لینک](/a/(b) ها/می رود.png) را\n");
  assert.deepEqual(l.lint(segs[0].text).map((f) => f.rule), []);
});
