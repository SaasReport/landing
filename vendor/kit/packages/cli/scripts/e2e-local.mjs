#!/usr/bin/env node
// End-to-end check of the starter, entirely local (no Cloudflare account, nothing remote):
//   kit init (linked to this checkout) → kit check → kit migrate (local D1) → wrangler dev --local → curl the pages
//   → run the daily cron for a sample Monday → the blog shows the post → stop wrangler.
//   node packages/cli/scripts/e2e-local.mjs [--locale en|fa] [--port 8799] [--keep]
// Needs wrangler (the site's own, or `npx wrangler`, which may download it once). Not part of `npm test`.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../../../sdk/kit/index.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LOCALE = arg("--locale", "en"), PORT = Number(arg("--port", 8799)), KEEP = process.argv.includes("--keep");
const BIN = fileURLToPath(new URL("../bin/kit.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "kit-e2e-"));
const dir = join(tmp, "site");
const base = `http://127.0.0.1:${PORT}`;
const api = createClient({ baseUrl: base });         // the generated SDK of the Worker contract (sdk/kit)
const kit = (...a) => { const r = spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf8" }); process.stdout.write(r.stdout); process.stderr.write(r.stderr); return r.status; };
const failures = [];
const expect = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };

let dev;
async function main() {
  const init = spawnSync(process.execPath, [BIN, "init", "site", "--locale", LOCALE, "--link"], { cwd: tmp, encoding: "utf8" });
  expect(init.status === 0, `kit init --locale ${LOCALE} --link`);
  expect(kit("check") === 0, "kit check");
  expect(kit("plan", "--out", "agenda.md") === 0, "kit plan");
  expect(kit("migrate") === 0, "kit migrate (local D1)");
  writeFileSync(join(dir, ".dev.vars"), 'ADMIN_TOKEN="e2e-token"\nIP_SALT="e2e-salt"\n');

  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1", "--test-scheduled"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  dev.stdout.on("data", (d) => { log += d; }); dev.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 90; i++) {
    try { await api.ops.health(); break; } catch { /* not up yet: retry in a second */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const lang = LOCALE === "fa" ? { html: /<html lang="fa" dir="rtl">/, blog: /بلاگ/ } : { html: /<html lang="en" dir="ltr">/, blog: /Blog/ };
  const checks = [
    ["/", "text/html", (b) => lang.html.test(b) && b.includes("/kit/kit.css") && b.includes("data-glossary-today")],
    ["/blog/", "text/html", (b) => lang.html.test(b) && lang.blog.test(b)],
    ["/podcasts/", "text/html", (b) => b.includes('id="weekly"') && b.includes('id="daily"')],
    ["/glossary/", "text/html", (b) => (b.match(/data-gterm/g) || []).length === 6 && (b.match(/data-gcat/g) || []).length >= 2],
    ["/sitemap.xml", "xml", (b) => b.includes("<urlset") && b.includes("/glossary/")],
    ["/llms.txt", "text/", (b) => b.startsWith("# ") && b.includes("/api/glossary/today")],
    ["/api/glossary/today", "application/json", (b) => { const j = JSON.parse(b); return j.ok === true && typeof j.term?.slug === "string"; }],
    ["/kit/kit.css", "text/css", (b) => b.includes("--accent")],
  ];
  for (const [path, type, ok] of checks) {
    let res, body = "";
    try { res = await fetch(base + path); body = await res.text(); } catch (e) { body = String(e); }
    expect(res?.status === 200 && (res.headers.get("content-type") || "").includes(type) && ok(body), `GET ${path} → ${res?.status} ${res?.headers.get("content-type")} (${body.length} bytes)`);
  }
  // The daily cron for the first sample weekly slot publishes the weekly post.
  const monday = LOCALE === "fa" ? "2026-09-26T02:00:00Z" : "2026-09-28T05:00:00Z";
  const slug = LOCALE === "fa" ? "week-2026-09-26" : "week-2026-09-28";
  const cron = await fetch(`${base}/cdn-cgi/handler/scheduled?time=${Date.parse(monday)}`).then((r) => r.status).catch(() => 0);   // a refused connection is status 0, which the expect below reports
  expect(cron === 200, `scheduled() for ${monday}`);
  await new Promise((r) => setTimeout(r, 1500));
  const post = await fetch(`${base}/blog/${slug}`);
  expect(post.status === 200 && (await post.text()).includes("<h1"), `GET /blog/${slug} after the cron → ${post.status}`);
  const listed = await api.blog.blogPosts().catch((e) => ({ error: e.message }));
  expect(listed.posts?.some((p) => p.slug === slug), `the post is listed by the blog posts operation${listed.error ? ` (${listed.error})` : ""}`);
  if (failures.length) console.log(log.split("\n").slice(-40).join("\n"));
}

try { await main(); }
finally {
  if (dev) { try { process.kill(-dev.pid, "SIGTERM"); } catch { /* the dev server already exited: nothing to stop */ } await new Promise((r) => setTimeout(r, 1000)); try { process.kill(-dev.pid, "SIGKILL"); } catch { /* the dev server already exited: nothing to stop */ } }
  if (!KEEP) rmSync(tmp, { recursive: true, force: true }); else console.log(`kept ${dir}`);
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall local end-to-end checks passed");
process.exit(failures.length ? 1 : 0);
