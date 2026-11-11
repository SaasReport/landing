// kit init --locales en,ar (a bilingual starter), and check, plan, render, publish for every locale.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/index.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";

let DIR;
const TMP = fileTempDir("kit-i18n-");
async function kit(argv, { cwd = DIR, fetch } = {}) {
  const out = [], err = [];
  const code = await main(argv, { cwd, env: { KIT_ADMIN_TOKEN: "t" }, out: (s) => out.push(s), err: (s) => err.push(s),
    fetch: fetch || (() => { throw new Error("no network in tests"); }), spawn: () => { throw new Error("no spawn in tests"); } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
before(async () => {
  const r = await kit(["init", "bi", "--locales", "en,ar", "--link"], { cwd: TMP });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /English and Arabic, en at \/ and ar at \/ar\//);
  DIR = join(TMP, "bi");
});

test("init --locales en,ar: bilingual config, content keyed per locale, an Arabic landing at public/ar/", async () => {
  for (const f of ["kit.config.js", "content/index.js", "content/weekly.js", "content/ar/weekly.js", "content/ar/glossary.js", "public/index.html", "public/ar/index.html", "public/kit/kit.js"]) assert.ok(existsSync(join(DIR, f)), f);
  assert.match(readFileSync(join(DIR, "kit.config.js"), "utf8"), /locales: \["en", "ar"\]/);
  assert.match(readFileSync(join(DIR, "public/ar/index.html"), "utf8"), /<html lang="ar" dir="rtl">/);
  assert.notEqual((await kit(["init", "x", "--locales", "en,de"], { cwd: TMP })).code, 0);
  const one = await kit(["init", "solo", "--locales", "fa", "--link"], { cwd: TMP });
  assert.match(one.out, /Persian, RTL, Jalali/, "one locale is a single-locale site");
});

test("check validates every locale and names the locale of each problem", async () => {
  const ok = await kit(["check"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^ok: Example Money Notes \(en, ar, gregorian\); config valid; content: \[en\] weekly 2, monthly 2, daily 6; \[ar\] weekly 2, monthly 2, daily 6; no problems\.$/);
  writeFileSync(join(DIR, "content/broken.js"), `import c from "./index.js";\nconst x = structuredClone(c);\nx.ar.daily.terms[0].short = "خلال 2 يوم: " + x.ar.daily.terms[0].short;\nexport default x;\n`);
  const bad = await kit(["check", "--content", "content/broken.js"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /\[ar\] daily settlement: short contains a figure/);
});

test("plan covers both locales; render and publish take --locale", async () => {
  const plan = await kit(["plan", "--from", "2026-09-28", "--days", "64", "--json", "--out", "false"]);
  assert.equal(plan.code, 0, plan.err);
  const j = JSON.parse(plan.out);
  assert.deepEqual(Object.keys(j.stats), ["en", "ar"]);
  const arWeek = j.items.find((x) => x.locale === "ar" && x.series === "weekly");
  assert.equal(arWeek.post.title, "موضوع نموذجي: ما هو يوم العمل، ولماذا يحرّك أموالك");
  assert.match(arWeek.post.body_md, /\(\/ar\/podcasts\/week-2026-09-28\)/);
  assert.equal(arWeek.episode.slug, "ar/week-2026-09-28");
  assert.match(arWeek.episode.lines[0].text, /^مرحبًا! معكم المال في دقيقتين من ملاحظات مالية نموذجية\. أنا سلمى، ومعي سامي\.$/);
  const md = await kit(["plan", "--from", "2026-09-28", "--days", "7", "--out", "-", "--locale", "ar"]);
  assert.match(md.out, /^# جدول نشر ملاحظات مالية نموذجية/);
  const r = await kit(["render", "daily", "inflation", "--locale", "ar", "--speakable"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ar\/term-inflation · مصطلح كل يوم/);
  assert.match(r.out, /سلمى: /);
  const pub = await kit(["publish", "daily", "inflation", "--locale", "ar", "--dry-run"]);
  assert.match(pub.out, /POST https:\/\/example.org\/ar\/api\/podcasts\/generate/);
  assert.notEqual((await kit(["render", "daily", "inflation", "--locale", "fr"])).code, 0);
});
