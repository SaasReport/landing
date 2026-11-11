// Behind Cloudflare: Rocket Loader and Email Address Obfuscation (docs/SITE.md, "Behind Cloudflare").
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudflareSafe, cfasyncScripts, emailOff, scriptTag, CFASYNC } from "../src/cloudflare-safe.js";

test("every executable script carries data-cfasync=false BEFORE src; data blocks are left alone; idempotent", () => {
  const h = '<script data-cfasync="false" src="/a.js" defer></script><script type="module" src="/m.js"></script><script type="module">import "/x.js"</script><script>1</script><script nonce="n" src="/b.js" data-cfasync="true"></script><script type="application/ld+json">{}</script>';
  const o = cfasyncScripts(h);
  const tags = [...o.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  for (const t of tags.filter((x) => !/ld\+json/.test(x))) {
    assert.ok(t.includes(CFASYNC), t);
    if (t.includes("src=")) assert.ok(t.indexOf(CFASYNC) < t.indexOf("src="), `before src: ${t}`);
    assert.equal(t.match(/data-cfasync/g).length, 1, t);
  }
  assert.ok(tags.includes('<script type="application/ld+json">'));
  assert.equal(cfasyncScripts(o), o);
  assert.equal(scriptTag({ src: "/a.js" }), '<script data-cfasync="false" src="/a.js" defer></script>');
});

test("mailto links and mailto forms are wrapped in email_off; code, comments and other links are not", () => {
  const h = '<a class="btn" href="mailto:a@b.c">a@b.c</a> <a href="/x">x</a> <form action="mailto:x@y.z"><a href="mailto:q@r.s">q</a></form><!-- <a href="mailto:c@c.c">c</a> --><script>var s=\'<a href="mailto:j@j.j">\'</script>';
  const o = emailOff(h);
  assert.match(o, /<!--email_off--><a class="btn" href="mailto:a@b\.c">a@b\.c<\/a><!--\/email_off-->/);
  assert.match(o, /<!--email_off--><form action="mailto:x@y\.z"><a href="mailto:q@r\.s">q<\/a><\/form><!--\/email_off-->/);
  assert.equal((o.match(/<!--email_off-->/g) || []).length, 2);
  assert.ok(o.includes('<a href="/x">x</a>'));
  assert.equal(emailOff(o), o);
  assert.equal(cloudflareSafe(h, { emailOff: false }).includes("email_off"), false);
});
