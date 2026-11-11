// kit podcast drill: today's episode generated in dry mode through the project's own Worker, its scheduled handler and its workflow, on a fresh
// local D1 built from its migrations; the row, the audio, the feed item and the page asserted. The outage of 2026-10-07..13 is a must-fail here too:
// the project's migrations carrying the 65-byte GLOB trigger make the drill fail before any episode exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { podcastDrill, declaredSeries, proofPath } from "../src/podcast-drill.js";
import { loadProject } from "../src/project.js";
import { bundled } from "../src/canon/index.js";
import { main } from "../src/index.js";

const KIT = fileURLToPath(new URL("../../../", import.meta.url));
const BASE = fileTempDir("kit-drill-");
let SEQ = 0;
const AT = "2026-10-14T03:00:00Z";   // the daily series started on 2026-09-30

/** The kit's example site (a real Worker module, config, content, wrangler.toml) as a project of its own, with the kit's migrations in its migrations/. */
function project(mutate = () => {}) {
  const root = join(BASE, `p${SEQ++}`);
  cpSync(join(KIT, "examples/podcast-site"), root, { recursive: true });
  symlinkSync(join(KIT, "node_modules"), join(root, "node_modules"));   // the same install this test runs from
  mkdirSync(join(root, "migrations"));
  for (const f of readdirSync(join(KIT, "packages/cloudflare/migrations"))) cpSync(join(KIT, "packages/cloudflare/migrations", f), join(root, "migrations", f));
  writeFileSync(join(root, "wrangler.toml"), readFileSync(join(root, "wrangler.toml"), "utf8").replace('migrations_dir = "node_modules/@saasreport/cloudflare/migrations"', 'migrations_dir = "migrations"'));
  mutate(root);
  return root;
}
const drill = (root, extra = {}) => podcastDrill(root, { series: "daily", at: AT, proof: "resilience/drills/proof.json", ...extra });
const failed = (r) => r.proof.checks.filter((c) => !c.ok).map((c) => c.id);

test("a project whose chain works: the cron makes today's episode, published, with its audio, feed item and page", () => {
  const root = project();
  const r = drill(root);
  assert.deepEqual(failed(r), [], JSON.stringify(r.proof.checks));
  assert.equal(r.ok, true);
  assert.deepEqual(r.proof.checks.map((c) => c.id), ["migrations", "cron-ran", "no-errors", "row", "provenance", "audio", "feed-item", "page"]);
  assert.equal(r.proof.dry, true);
  assert.equal(r.proof.series, "daily");
  assert.match(r.proof.slug, /^term-/);
  assert.ok(r.proof.migrations.length >= 10, "the project's own migrations ran, in order");
  assert.ok(existsSync(join(root, "resilience/drills/proof.json")), "the proof is written");
  const doc = JSON.parse(readFileSync(join(root, "resilience/drills/proof.json"), "utf8"));
  assert.deepEqual(bundled().validator.validate(doc, bundled().byName("podcast-drill")), [], "and it is kit.podcast-drill.v1");
});

test("MUST FAIL: the migrations of the outage (the 65-byte GLOB trigger of 0008..0010 as the schema's last word) fail the drill before any episode exists", () => {
  const root = project((p) => rmSync(join(p, "migrations/0011_podcast_provenance_triggers.sql")));
  const r = drill(root);
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["migrations"]);
  assert.match(r.proof.checks[0].detail, /LIKE or GLOB pattern too complex/);
  assert.equal(r.proof.slug, "");
});

test("MUST FAIL: a day on which the series is not due makes no episode, and the drill says so (no row)", () => {
  const r = drill(project(), { at: "2026-09-01T03:00:00Z" });
  assert.equal(r.ok, false);
  assert.ok(failed(r).includes("row"), JSON.stringify(r.proof.checks));
});

test("MUST FAIL: an episode the pipeline parks (longer than the series allows) is not a published episode", () => {
  const root = project((p) => writeFileSync(join(p, "kit.config.js"), readFileSync(join(p, "kit.config.js"), "utf8").replace("maxSeconds: 80, marginSeconds: 8", "maxSeconds: 1, marginSeconds: 0")));
  const r = drill(root);
  assert.equal(r.ok, false);
  assert.ok(failed(r).includes("row"), JSON.stringify(r.proof.checks));
});

test("MUST FAIL: a series the project does not declare is not drilled", () => {
  const r = podcastDrill(project(), { series: "nope", at: AT, proof: "resilience/drills/proof.json" });
  assert.equal(r.ok, false);
  assert.match(r.proof.checks[0].detail, /declares no podcast series "nope"/);
});

test("no provider is called: only the TTS fixture is answered, anything else is refused and restored afterwards", async () => {
  const { fixtureTts, offline } = await import("../src/podcast-drill/fixtures.js");
  const before = globalThis.fetch;
  const restore = offline(fixtureTts());
  try {
    const ok = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent", { method: "POST", body: "{}" });
    assert.equal((await ok.json()).candidates[0].content.parts[0].inlineData.mimeType, "audio/L16;rate=24000");
    const modern = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", { method: "POST", body: "{}" });
    const modernPayload = await modern.json();
    assert.equal(modernPayload.steps[0].type, "model_output");
    assert.equal(modernPayload.steps[0].content[0].mime_type, "audio/l16;rate=24000");
    assert.ok(modernPayload.steps[0].content[0].data.length > 100, "fixture PCM is real audio, not a fake success marker");
    await assert.rejects(fetch("https://api.telegram.org/bot/sendMessage"), /outbound request refused/);
    await assert.rejects(fetch("https://generativelanguage.googleapis.com.evil.example/v1beta/models/x:generateContent"), /outbound request refused/);
  } finally { restore(); }
  assert.equal(globalThis.fetch, before);
});

test("declaredSeries: the daily podcast series of kit.config.js are the subjects a project's drills must cover", async () => {
  const root = project();
  assert.deepEqual(await declaredSeries(root), [{ id: "weekly", show: "weekly", every: "week" }, { id: "daily", show: "daily", every: "day" }]);
  assert.equal(proofPath("daily", "2026-10-14"), "resilience/drills/publish-daily-2026-10-14.json");
});

test("kit podcast drill: exit 0 and a line per check when it passes, exit 1 and the failing check when it does not", async () => {
  const root = project();
  const out = [], err = [];
  const io = (cwd) => ({ cwd, env: {}, out: (s) => out.push(s), err: (s) => err.push(s) });
  assert.equal(await main(["podcast", "drill", "--series", "daily", "--at", AT], io(root)), 0, err.join("\n"));
  assert.match(out.join("\n"), /ok feed-item/);
  assert.ok(existsSync(join(root, proofPath("daily", "2026-10-14"))), "default proof path");
  err.length = 0;
  assert.equal(await main(["podcast", "drill", "--series", "daily", "--at", "2026-09-01T03:00:00Z"], io(project())), 1);
  assert.match(err.join("\n"), /FAIL row/);
});

test("MUST FAIL (review of e865a625): the child that imports the project's Worker sees an allow-listed environment, never a provider key or token of the parent", async () => {
  const { childEnv, CHILD_ENV } = await import("../src/podcast-drill.js");
  const parent = { PATH: "/bin", HOME: "/h", GITHUB_SHA: "a".repeat(40), TZ: "UTC", GEMINI_API_KEY: "real", CLOUDFLARE_API_TOKEN: "t", OPS_NOTIFY_TO: "x", GH_TOKEN: "g" };
  const kid = childEnv({ ...parent, NODE_OPTIONS: "--require /tmp/preload.js" }, "/tmp/fresh-home");
  assert.deepEqual(Object.keys(kid).sort(), ["GITHUB_SHA", "HOME", "NODE_ENV", "PATH", "TZ"]);
  assert.equal(kid.HOME, "/tmp/fresh-home", "HOME is the drill's own temporary directory, never the parent's");
  assert.ok(!CHILD_ENV.includes("NODE_OPTIONS") && !CHILD_ENV.includes("HOME"));
  assert.ok(!CHILD_ENV.some((k) => /KEY|TOKEN|SECRET|NOTIFY/.test(k)));
  // and in the real child: the project's Worker module throws when it can see the probe, and the drill still passes
  const root = project((p) => writeFileSync(join(p, "src/worker.js"), `${readFileSync(join(p, "src/worker.js"), "utf8")}\nif (process.env.GEMINI_API_KEY_PARENT_PROBE) throw new Error("the parent's environment leaked into the project's Worker");\n`));
  const r = drill(root, { env: { ...process.env, GEMINI_API_KEY_PARENT_PROBE: "secret-probe" } });
  assert.equal(r.ok, true, JSON.stringify(r.proof.checks));
});

test("MUST FAIL (review of e865a625): the drill covers weekly series too: the pinned clock is the next day the planner publishes an item, and a series whose content ran out has nothing to drill", async () => {
  const { defaultAt } = await import("../src/podcast-drill.js");
  const root = project();   // the example's weekly scripts pass the Persian gate as they are: no gate is turned off
  const now = new Date("2026-10-14T08:00:00Z");
  assert.equal(await defaultAt(root, "daily", now), now.toISOString(), "daily: now");
  const weekly = await defaultAt(root, "weekly", now);
  assert.ok(Date.parse(weekly) >= now.getTime() - 864e5, weekly);
  const r = podcastDrill(root, { series: "weekly", at: weekly, proof: "resilience/drills/weekly.json" });
  assert.deepEqual(failed(r), [], JSON.stringify(r.proof.checks));
  assert.equal(r.ok, true);
  assert.match(r.proof.slug, /^week-/);
  assert.equal(r.proof.series, "weekly");
  await assert.rejects(defaultAt(root, "weekly", new Date("2030-01-01T00:00:00Z")), /content ran out/);
});

test("MUST FAIL (review of 7fa30afa): a monthly podcast series gets a pinned clock too (the 1st of a month, as the planner publishes it) (the config accepts day, week, month)", async () => {
  const { defaultAt } = await import("../src/podcast-drill.js");
  const now = new Date("2026-10-14T08:00:00Z");
  for (const every of ["month"]) {
    const root = project((p) => { const f = join(p, "kit.config.js"); const t = readFileSync(f, "utf8"); assert.ok(t.includes('every: "week", on: "sat"')); writeFileSync(f, t.replace('every: "week", on: "sat"', `every: "${every}", on: 1`)); });
    const at = await defaultAt(root, "weekly", now);
    assert.notEqual(at, now.toISOString(), `${every}: not "now" (a monthly series is due on one day of the month)`);
    assert.ok(Date.parse(at) >= now.getTime() - 864e5, at);
  }
});

test("MUST FAIL: a workflow that throws (here a line spoken by a host who does not exist, refused when the episode is created) is a failed proof naming the error, not a crash of the drill", async () => {
  const { defaultAt } = await import("../src/podcast-drill.js");
  const root = project((p) => {   // a speaker with no voice: the workflow throws before any audio exists
    const f = join(p, "content/weekly.js");
    const t = readFileSync(f, "utf8");
    assert.ok(t.includes('["host","What is the difference between gross and net?"]'));
    writeFileSync(f, t.replace('["host","What is the difference between gross and net?"]', '["ghost","What is the difference between gross and net?"]'));
  });
  const r = podcastDrill(root, { series: "weekly", at: await defaultAt(root, "weekly", new Date("2026-10-14T08:00:00Z")), proof: "resilience/drills/weekly.json" });
  assert.equal(r.ok, false);
  assert.ok(failed(r).includes("cron-ran"), JSON.stringify(r.proof.checks));
  assert.match(r.proof.checks.find((c) => c.id === "cron-ran").detail, /unknown speaker "ghost"/s);
});

test("CLI and drill use the same composite content pack as the deployed Worker", async () => {
  const root = project((p) => {
    mkdirSync(join(p, "src/kit"), { recursive: true });
    writeFileSync(join(p, "src/kit/content.js"),
      'import base from "../../content/index.js"; export default { ...base, daily: [] };\n');
  });
  const workerContent = await loadProject(root);
  const fallback = await loadProject(root, { content: "content/index.js" });
  assert.ok(Array.isArray(workerContent.content.daily), "composed module is resolved");
  assert.equal(workerContent.content.daily.length, 0, "the Worker\'s override is what the CLI checks");
  assert.notDeepEqual(fallback.content.daily, workerContent.content.daily, "an explicit content override remains supported");
});
