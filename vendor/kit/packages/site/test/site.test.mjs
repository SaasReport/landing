// @saasreport/site: tokens, locale packs, content validation, the theme CSS templates and an en/ar smoke build of the
// sample project (examples/site-sample): LTR English at /, RTL Arabic at /ar/, from the same templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../core/test/support/temp.mjs";
import {
  DEFAULT_TOKENS, resolveTokens, checkTokens, rgb, fontFaces, LOCALES, createLocale, checkLocale, checkLanding, checkProject,
  buildSite, defineSite, renderCss, readTheme, placeholders, THEME_CSS, SECTIONS, REQUIRED,
} from "../src/index.js";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
const sample = (await import(`${SAMPLE}site.config.js`)).default;
const clone = (x) => structuredClone(x);

test("tokens: neutral defaults are complete; bad values are reported; rgb and @font-face helpers", () => {
  assert.deepEqual(checkTokens(resolveTokens({})), []);
  const bad = resolveTokens({ color: { accent: "orange" }, radius: { btn: "big" }, font: { sans: 'x"y' }, logo: { nav: { src: "/l.png", width: 0 } } });
  const p = checkTokens(bad).join("\n");
  assert.match(p, /color\.accent: "orange" is not a #RRGGBB colour/);
  assert.match(p, /radius\.btn/);
  assert.match(p, /font\.sans/);
  assert.match(p, /logo\.nav: needs src, width and height/);
  assert.equal(rgb("#FF5A00"), "255,90,0");
  assert.equal(fontFaces({ font: { faces: [{ family: "Sans X", weight: 400, src: "/fonts/SansX.woff2" }] } }),
    '@font-face{font-family:"Sans X";src:url("/fonts/SansX.woff2") format("woff2");font-weight:400;font-display:swap}');
  assert.equal(resolveTokens({ color: { accent: "#123456" } }).color.ink, DEFAULT_TOKENS.color.ink, "a partial override keeps the other defaults");
});

test("locale packs: fa, en and ar are complete, with direction, digits, numbers, calendars and dates", () => {
  for (const code of ["fa", "en", "ar"]) assert.deepEqual(checkLocale(createLocale(code), code), [], code);
  const fa = createLocale("fa"), en = createLocale("en"), ar = createLocale("ar");
  assert.deepEqual([fa.dir, en.dir, ar.dir], ["rtl", "ltr", "rtl"]);
  assert.equal(fa.number(1950), "۱٬۹۵۰");
  assert.equal(ar.number(1234567.5, { decimals: 1 }), "١٬٢٣٤٬٥٦٧٫٥");
  assert.equal(en.number(12480), "12,480");
  assert.equal(fa.percent(86), "۸۶٪");
  assert.equal(en.percent(86), "86%");
  assert.equal(fa.date("2026-03-25"), "۵ فروردین ۱۴۰۵", "Jalali");
  assert.equal(en.date("2026-03-25"), "25 March 2026", "Gregorian");
  assert.equal(ar.date("2026-03-25"), "٢٥ مارس ٢٠٢٦", "Gregorian, Arabic names and digits");
  assert.match(ar.date("2026-03-25", { calendar: "hijri" }), /^[٠-٩]+ شوال ١٤٤٧ هـ$/, "lunar Hijri");
  assert.equal(en.date("2026-03-25", { calendar: "hijri" }).split(" ").slice(1, 2)[0], "Shawwal");
  assert.equal(ar.t("consent", { privacy: "X" }), "أوافق على X.");
  assert.deepEqual([fa.counter, en.counter, ar.counter], ["persian", "decimal", "arabic-indic"]);
  assert.deepEqual([fa.arrow.next, en.arrow.next], ["←", "→"]);
  assert.equal(createLocale("ar", { digits: "latin" }).number(1950), "1٬950", "a project may switch Arabic to Latin digits");
  assert.throws(() => createLocale("xx"), /unknown locale "xx"/);
  assert.match(checkLocale({ ...LOCALES.en, dir: "up", strings: { ...LOCALES.en.strings, close: "" } }).join("\n"), /dir must be rtl or ltr[\s\S]*missing string close/);
});

test("content validation: the sample passes; unknown types, missing fields, duplicate ids and dangling modals are reported", () => {
  assert.deepEqual(checkProject(sample), []);
  assert.equal(defineSite(sample), sample);
  const bad = clone(sample.content.en);
  bad.sections.push({ type: "carousel", id: "x" }, { type: "cards", id: "problem" }, { type: "band", title: "t", actions: [{ label: "Go", modal: "demo" }] });
  delete bad.meta.title;
  const p = checkLanding(bad, "content.en").join("\n");
  assert.match(p, /content\.en\.meta\.title: missing/);
  assert.match(p, /unknown type "carousel"/);
  assert.match(p, /\(#problem\): cards needs items/);
  assert.match(p, /duplicate id "problem"/);
  assert.match(p, /opens modal "demo", which is not defined in modals/);
  assert.throws(() => defineSite({ ...sample, url: "http://x", locales: ["en", "zz"] }), /url: an https:\/\/ URL[\s\S]*unknown locale "zz"/);
  for (const type of Object.keys(SECTIONS)) assert.ok(REQUIRED[type], `REQUIRED lists ${type}`);
});

test("theme CSS templates: no project-specific values; every placeholder resolves for every locale", () => {
  const tokens = resolveTokens({});
  for (const f of THEME_CSS) {
    const tpl = readTheme(f);
    assert.doesNotMatch(tpl, /#FF5A00|Vazirmatn|Geist|[؀-ۿ]/, `${f} holds no brand values or Persian text`);
    for (const code of ["fa", "en", "ar"]) {
      const css = renderCss(tpl, { file: f, tokens, locale: createLocale(code), name: "Example" });
      assert.doesNotMatch(css, /\{\{/, `${f} (${code}) fully rendered`);
    }
  }
  assert.ok(placeholders(readTheme("styles.css")).includes("colorVars") || readTheme("styles.css").includes("{{colorVars}}"));
  const en = renderCss(readTheme("styles.css"), { file: "styles.css", tokens, locale: createLocale("en"), name: "Example" });
  const fa = renderCss(readTheme("styles.css"), { file: "styles.css", tokens, locale: createLocale("fa"), name: "Example" });
  assert.match(en, /counter\(v,decimal\)/); assert.match(fa, /counter\(v,persian\)/);
  assert.match(en, /content:" →"/); assert.match(fa, /content:" ←"/);
  assert.match(en, /--c-accent:#1D4ED8;/, "the accent token is declared once, as a colour role");
  assert.match(en, /--orange:var\(--c-accent\);/, "the theme's accent variable reads the role");
  assert.throws(() => renderCss("a{{nope.x}}", { file: "x.css", tokens, locale: createLocale("en"), name: "E" }), /unknown theme placeholder \{\{nope\.x\}\}/);
});

test("smoke build: English (LTR) at / and Arabic (RTL) at /ar/ from the same templates", (t) => {
  const { files, locales } = buildSite(sample, { root: SAMPLE, outDir: tempDir(t, "site-") });
  assert.deepEqual(locales, [{ code: "en", path: "/" }, { code: "ar", path: "/ar/" }]);
  assert.ok(files["index.html"] && files["ar/index.html"] && files["styles.css"] && files["styles.ar.css"]);
  const en = files["index.html"], ar = files["ar/index.html"];
  assert.match(en, /^<!doctype html>\n<html lang="en" dir="ltr">/);
  assert.match(ar, /^<!doctype html>\n<html lang="ar" dir="rtl">/);
  for (const html of [en, ar]) {
    assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/example\.org\/">\n<link rel="alternate" hreflang="ar" href="https:\/\/example\.org\/ar\/">\n<link rel="alternate" hreflang="x-default" href="https:\/\/example\.org\/">/);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1].trim());
    assert.deepEqual(inline, ['type="application/ld+json" data-seo-graph'], "CSP: only the JSON-LD block is inline");
    assert.doesNotMatch(html, /\son[a-z]+\s*=|javascript:/i, "CSP: no inline handlers");
    assert.equal(html.match(/<main id="main">/g).length, 1);
  }
  assert.match(en, /<link rel="canonical" href="https:\/\/example\.org\/">/);
  assert.match(ar, /<link rel="canonical" href="https:\/\/example\.org\/ar\/">/);
  assert.match(en, /<a class="btn btn--ghost btn--sm" href="\/ar\/" hreflang="ar" lang="ar" aria-label="Language: العربية">العربية<\/a>/, "language switcher");
  assert.match(ar, /href="\/" hreflang="en" lang="en" aria-label="اللغة: English">English<\/a>/);
  assert.match(en, /<span class="pcard__n">2<\/span>/); assert.match(ar, /<span class="pcard__n">٢<\/span>/, "Arabic-Indic digits");
  assert.match(en, /<a class="skip" href="#main">Skip to main content<\/a>/);
  assert.match(ar, /<a class="skip" href="#main">الانتقال إلى المحتوى الرئيسي<\/a>/);
  assert.match(ar, /<span>أوافق على <button type="button" class="link" data-modal="privacy">سياسة الخصوصية<\/button>.<\/span>/);
  assert.match(en, /<em>→<\/em>/); assert.match(ar, /<em>←<\/em>/, "flow arrows follow the reading direction");
  assert.match(en, /href="\/styles\.css\?v=[a-f0-9]{10}"/); assert.match(ar, /href="\/styles\.ar\.css\?v=[a-f0-9]{10}"/);
  assert.match(files["styles.ar.css"], /counter\(v,arabic-indic\)/);
  assert.match(files["styles.css"], /--c-accent:#0F766E;/, "the project's accent");
  const ld = JSON.parse(ar.match(/data-seo-graph>(.*?)<\/script>/)[1]);
  assert.deepEqual(ld["@graph"].map((x) => x["@type"]), ["Organization", "WebSite", "FAQPage"]);
  assert.equal(ld["@graph"][2].inLanguage, "ar");
  assert.equal(ld["@graph"][2].mainEntity[2].acceptedAnswer.text, "للرد على رسالتك فقط. اطّلع على سياسة الخصوصية .");
});

test("nav: a link with a menu renders a mega menu (disclosure button, labelled panel, grouped links, aside)", (t) => {
  const p = clone(sample);
  p.content.en.nav.links.unshift({ label: "Products", menu: { id: "products", label: "Products menu",
    columns: [{ title: "Core", links: [{ label: "Engine", href: "#engine", text: "Dates and business days" }, { label: "Contact", modal: "contact" }] }],
    aside: { title: "Start", text: "Free tier.", action: { label: "Sign up", href: "#start" } } } });
  const { files } = buildSite(p, { root: SAMPLE, outDir: tempDir(t, "site-") });
  const en = files["index.html"];
  assert.match(en, /<div class="nav__item" data-mega>\n\s*<button type="button" class="nav__toggle" aria-expanded="false" aria-controls="mega-products" data-mega-toggle>Products<svg class="ico ico--sm"><use href="#i-chevron"\/><\/svg><\/button>/);
  assert.match(en, /<div class="mega" id="mega-products" role="region" aria-label="Products menu">/);
  assert.match(en, /<a class="mega__link" href="#engine"><b>Engine<\/b><small>Dates and business days<\/small><\/a>/);
  assert.match(en, /<button type="button" class="mega__link" data-modal="contact"><b>Contact<\/b><\/button>/);
  assert.match(en, /<div class="mega__aside"><p class="mega__title">Start<\/p><p>Free tier\.<\/p><a class="btn btn--primary btn--sm" href="#start">Sign up<\/a><\/div>/);
  assert.match(en, /<symbol id="i-chevron"/);
  assert.match(files["styles.css"], /\.nav__toggle\[aria-expanded="true"\]\+\.mega/);
  assert.doesNotMatch(files["index.html"], /\son[a-z]+\s*=/i);
});

test("kit site build writes the files; --check passes on them and fails after a change", async (t) => {
  const { main } = await import("@saasreport/cli");
  const out = tempDir(t, "site-cli-");
  const logs = [];
  const io = { out: (s) => logs.push(s), err: (s) => logs.push(s) };
  assert.equal(await main(["site", "build", "--cwd", SAMPLE, "--out", out], io), 0, logs.join("\n"));
  assert.ok(existsSync(join(out, "ar", "index.html")));
  assert.equal(await main(["site", "build", "--check", "--cwd", SAMPLE, "--out", out], io), 0, logs.join("\n"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(out, "index.html"), "changed");
  assert.equal(await main(["site", "build", "--check", "--cwd", SAMPLE, "--out", out], io), 1);
  assert.match(logs.join("\n"), /differs: index\.html/);
  assert.equal(await main(["site", "check", "--cwd", SAMPLE], io), 0);
});

test("the package holds no project-specific names", () => {
  const dir = fileURLToPath(new URL("../", import.meta.url));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of ["src", "theme", "assets", "pages", "tools"].flatMap((d) => walk(join(dir, d)))) {
    // the kit's own names (@saasreport/*, the <kit-date-picker> element of @saasreport/calendar) are not project names
    assert.doesNotMatch(readFileSync(f, "utf8").replace(/@saasreport\/|kit-date-picker|kitdp/g, ""), /iran|ایران|فاینانس/i, f);
  }
});
