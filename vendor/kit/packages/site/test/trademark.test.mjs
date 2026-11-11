import { test } from "node:test";
import assert from "node:assert/strict";
import { trademarker } from "../src/index.js";

const tm = trademarker({ names: ["Acme", "اکمی"] });

test("HTML: text, title and meta content get the mark; scripts, URLs, ids and classes do not", () => {
  const html = `<title>Acme | Home</title><meta property="og:site_name" content="Acme">
<a href="https://acme.example/" class="Acme" id="Acme">Acme terminal</a>
<script type="application/ld+json">{"name":"Acme"}</script><script>window.AcmeNotify=1;</script>
<p>Write to info@acme.example. Acme™ already marked.</p><p>اکمی، یک دقیقه</p>`;
  const out = tm("index.html", html);
  assert.match(out, /<title>Acme™ \| Home<\/title>/);
  assert.match(out, /content="Acme™"/);
  assert.match(out, />Acme™ terminal</);
  assert.match(out, /class="Acme" id="Acme"/);
  assert.match(out, /\{"name":"Acme"\}/);
  assert.match(out, /window\.AcmeNotify=1/);
  assert.match(out, /Acme™ already marked/);
  assert.doesNotMatch(out, /™™/);
  assert.match(out, /اکمی™، یک دقیقه/);
  assert.equal(tm("index.html", out), out, "idempotent");
});

test("JS and JSON: whole words only; CSS and XML untouched; no names means no transform", () => {
  assert.equal(tm("app.js", 'const t = "Acme lab"; window.AcmeNotify; fetch("/acme")'),
    'const t = "Acme™ lab"; window.AcmeNotify; fetch("/acme")');
  assert.equal(tm("styles.css", ".x::after{content:'Acme'}"), ".x::after{content:'Acme'}");
  assert.equal(trademarker({}), null);
});

test("JS: the mark goes into strings, templates and comments, never into code", async () => {
  const { markScriptText } = await import("../src/trademark.js");
  const tm2 = trademarker({ names: ["Acme"] });
  const src = [
    "/* Acme: layer */",
    "const Acme = window.Acme || {};",
    "const a = 'Acme lab', b = \"x\\\" Acme\";",
    "const r = /[\"']Acme/g, q = 1 / 2;",
    "const t = `by Acme ${Acme.name + `Acme`} end`;",
    "// Acme",
  ].join("\n");
  const out = tm2("x.js", src);
  assert.ok(out.includes("/* Acme™: layer */"));
  assert.ok(out.includes("const Acme = window.Acme || {};"));
  assert.ok(out.includes("'Acme™ lab'"));
  assert.ok(out.includes("x\\\" Acme™\""));
  assert.ok(out.includes("/[\"']Acme/g"), "regex literals are code");
  assert.ok(out.includes("`by Acme™ ${Acme.name + `Acme™`} end`"));
  assert.ok(out.endsWith("// Acme™"));
  new Function(out);
  assert.equal(markScriptText("a(1)", (s) => s.toUpperCase()), "a(1)");
});
