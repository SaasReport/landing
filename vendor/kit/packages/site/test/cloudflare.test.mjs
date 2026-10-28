// Behind Cloudflare (docs/SITE.md): Rocket Loader and Email Address Obfuscation are on in the zone, so every page the kit
// builds says what to leave alone. Proven on the generated HTML of the sample project (landing, inner pages, both locales).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildSite, checkProject } from "../src/index.js";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
const sample = (await import(`${SAMPLE}site.config.js`)).default;
const html = (files) => Object.entries(files).filter(([f]) => f.endsWith(".html"));

test("Rocket Loader: every executable script tag has data-cfasync=false before src, on every built page", () => {
  const { files } = buildSite(sample, { root: SAMPLE, write: false });
  let n = 0;
  for (const [f, body] of html(files)) {
    for (const [tag] of body.matchAll(/<script\b[^>]*>/g)) {
      if (/type="application\/(?:ld\+)?json"/.test(tag)) continue;
      n++;
      assert.match(tag, /^<script data-cfasync="false"/, `${f}: ${tag}`);
      if (tag.includes(" src=")) assert.ok(tag.indexOf("data-cfasync") < tag.indexOf(" src="), `${f}: ${tag}`);
    }
  }
  assert.ok(n > 20, `scripts checked: ${n}`);
});

test("Rocket Loader: a script a project writes into its own content gets it too (inline module included)", () => {
  const p = structuredClone(sample);
  p.content.en.sections[0].lead = `${p.content.en.sections[0].lead || "Lead"} <script type="module">window.x = 1</script><script src="/own.js"></script>`;
  const { files } = buildSite(p, { root: SAMPLE, write: false });
  assert.match(files["index.html"], /<script data-cfasync="false" type="module">window\.x = 1<\/script>/);
  assert.match(files["index.html"], /<script data-cfasync="false" src="\/own\.js"><\/script>/);
});

test("email obfuscation: mailto links are wrapped in email_off by default; cloudflare.emailOff=false leaves them", () => {
  const { files } = buildSite(sample, { root: SAMPLE, write: false });
  for (const f of ["index.html", "ar/index.html"]) {
    assert.match(files[f], /<!--email_off--><a [^>]*href="mailto:info@example\.org"[^>]*>[\s\S]*?<\/a><!--\/email_off-->/, f);
    for (const m of files[f].matchAll(/<a\b[^>]*href="mailto:[^"]*"[^>]*>/g)) {
      assert.ok(files[f].lastIndexOf("<!--email_off-->", m.index) > files[f].lastIndexOf("<!--/email_off-->", m.index), `${f}: unwrapped ${m[0]}`);
    }
  }
  const off = buildSite({ ...structuredClone(sample), cloudflare: { emailOff: false } }, { root: SAMPLE, write: false }).files;
  assert.doesNotMatch(off["index.html"], /email_off/);
  assert.ok(off["index.html"].includes('href="mailto:info@example.org"'));
});

test("the cloudflare option is validated", () => {
  assert.deepEqual(checkProject({ ...structuredClone(sample), cloudflare: { emailOff: true } }), []);
  assert.match(checkProject({ ...structuredClone(sample), cloudflare: { emailOff: "no" } }).join("\n"), /cloudflare\/emailOff|cloudflare.*emailOff/);
  assert.match(checkProject({ ...structuredClone(sample), cloudflare: { rocket: 1 } }).join("\n"), /cloudflare/);
});
