// Persian digits on every page, twin and llms.txt the Worker renders for a fa site (CONSTITUTION.md §7): content from
// the database with Latin digits comes out in Persian digits, by the same rules kit check digits applies; an en site's
// pages keep Latin digits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, seed } from "./helpers.mjs";
import { scanHtml, scanMarkdown, scanText } from "@saasreport/format/scan";

test("fa: pages, twins and llms.txt rendered by the Worker show no Latin or Arabic-Indic digit", async () => {
  const { env, get } = makeKit("fa");
  await seed(env, { lang: "fa" });
  await env.DB.prepare("UPDATE posts SET title = ?, summary = ?, body_md = ? WHERE slug = ?")
    .bind("سال 2026 در ۱۰ نکته", "خلاصه با 3 عدد و ٤", "## بخش 1\nتسویه T+1 در 1404/12/28، کد `v1 2`.\n\n1. گام اول\n2. گام دوم\n", "hello-world").run();
  const pages = ["/blog/", "/blog/hello-world", "/podcasts/", "/glossary/", "/events/", "/no-such-page"];
  for (const p of pages) {
    const r = await get(p);
    const html = await r.text();
    assert.deepEqual(scanHtml(html).map((f) => `${f.where} «${f.match}» ${f.context}`), [], p);
  }
  const post = await (await get("/blog/hello-world")).text();
  assert.match(post, /سال ۲۰۲۶ در ۱۰ نکته/);
  assert.match(post, /T\+1/);                             // a Latin identifier stays Latin
  assert.match(post, /<code dir="ltr">v1 2<\/code>/);              // code stays as written
  const md = await (await get("/blog/hello-world.md")).text();
  assert.deepEqual(scanMarkdown(md), [], md);
  assert.match(md, /- ۱\. گام اول/);
  for (const p of ["/llms.txt", "/llms-full.txt"]) {
    const r = await get(p);
    if (r.status === 200) assert.deepEqual(scanText(await r.text()), [], p);
  }
});

test("en: the Worker leaves Latin digits alone", async () => {
  const { env, get } = makeKit("en");
  await seed(env, { lang: "en" });
  await env.DB.prepare("UPDATE posts SET title = ? WHERE slug = ?").bind("2026 in 10 points", "hello-world").run();
  assert.match(await (await get("/blog/hello-world")).text(), /2026 in 10 points/);
});
