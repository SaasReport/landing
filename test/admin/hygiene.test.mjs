// No secret, no password and no personal address anywhere: the admin has no password and no user table, and the owner's address is a Worker
// secret that never enters the repository. The patterns are assembled at run time so this file does not contain what it forbids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean)
  .filter((f) => !f.startsWith("vendor/") && !f.startsWith("public/fonts/") && !f.startsWith("sdk/") && f !== "package-lock.json" && !/\.(png|svg|ttf|woff2?|ico)$/.test(f) && !f.startsWith("workers/admin/dist/"));
const text = (f) => { try { return readFileSync(ROOT + f, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } };   // a staged deletion has no file
const isTest = (f) => f.startsWith("test/");
const frag = (...p) => p.join("");

test("the repository holds files to scan", () => assert.ok(tracked.length > 40));

test("the owner's address and its domain appear nowhere in the repository", () => {
  const forbidden = [new RegExp(frag("gma", "il"), "i"), new RegExp(frag("mara", "ndi"), "i"), new RegExp(frag("m\\.", "ma", "randi"), "i")];
  for (const f of tracked) for (const re of forbidden) assert.ok(!re.test(text(f)), `${f} matches ${re.source.length} chars of a forbidden pattern`);
});

test("every email address in the repository belongs to the company or is a reserved example domain", () => {
  const ok = /@(saasreport\.ai|example\.(test|com|org)|anthropic\.com)$/i;
  const found = [];
  for (const f of tracked) for (const m of text(f).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!ok.test(m[0]) && !/@(types|babel|saasreport)\//.test(m[0])) found.push(`${f}: ${m[0].replace(/^[^@]*/, "…")}`);
  assert.deepEqual(found, []);
});

test("no password, secret value, token, key or certificate literal in code or configuration", () => {
  const assign = new RegExp(`(${frag("pass", "word")}|passwd|secret|token|api[_-]?key|private[_-]?key)["']?\\s*[:=]\\s*["'\`]([^"'\`\\s$]{8,})["'\`]`, "gi");
  const isName = (v) => /^[A-Z][A-Z0-9_]*$/.test(v);                      // OPS_NOTIFY_TO: the NAME of a secret, which is what the config may hold
  const shapes = [/-----BEGIN [A-Z ]*(PRIVATE|CERTIFICATE)/, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bxox[baprs]-/, /\bsk-[A-Za-z0-9]{20,}/];
  for (const f of tracked) {
    const t = text(f);
    for (const re of shapes) assert.ok(!re.test(t), `${f} holds a secret-shaped literal`);
    if (!isTest(f)) for (const m of t.matchAll(assign)) assert.ok(isName(m[2]), `${f} assigns a literal to a secret-like name`);
  }
});

test("the Worker has no password, no user table with credentials and no cookie of its own", () => {
  for (const f of tracked.filter((x) => x.startsWith("workers/admin/src/") || x.startsWith("workers/admin/migrations/"))) {
    const t = text(f);
    assert.ok(!new RegExp(frag("pass", "word"), "i").test(t.replace(/passwords? / , "")) || /no password|never a password|No password/i.test(t), `${f} mentions a password only to say there is none`);
    assert.ok(!/set-cookie|document\.cookie/i.test(t), `${f} sets no cookie`);
    assert.ok(!/\bhash(ed)?_?password|password_hash|bcrypt|scrypt|pbkdf2/i.test(t), `${f} stores no credential`);
  }
  assert.ok(!/credential|password/i.test(JSON.stringify(JSON.parse(text("workers/admin/admin.config.json")).secrets)), "the configured secrets are Access settings and the allowlist, nothing else");
});

test("the Access settings are read by name: no team domain, AUD tag or allowlist value is written in code, configuration or the wrangler file", () => {
  const code = tracked.filter((f) => f.startsWith("workers/admin/") && !f.endsWith(".md"));
  for (const f of code) {
    const t = text(f);
    assert.ok(!/[a-z0-9-]+\.cloudflareaccess\.com/.test(t.replace(/\\\.cloudflareaccess\\\.com\$/g, "")) || /teamDomainPattern/.test(t), `${f} names an Access team domain`);
    assert.ok(!/\b[0-9a-f]{64}\b/.test(t) || f.endsWith("snapshot.json") || f.endsWith("scenarios.json") || f.endsWith("widgets.generated.json"), `${f} holds a 64-hex value (an AUD tag?)`);
  }
});
