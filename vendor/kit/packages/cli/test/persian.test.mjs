// kit check persian, kit check fa-review and kit persian fix|review|approve|baseline (docs/PERSIAN.md) on a small repository.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { main } from "../src/index.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { readJson, writeJson, git, commit, initRepo, trustWith, run as runIn, keygen, setKeyDir, persianPins } from "./approvals-helpers.mjs";

const TMP = fileTempDir("kit-persian-");
let OWNER, OTHER, REG;
before(async () => {
  setKeyDir(join(TMP, "keys"));
  OWNER = await keygen(TMP, "owner"); OTHER = await keygen(TMP, "other");
  REG = trustWith("saasreport", { concepts: "general", persian: { ledger: "fa-review.json", anchor: null, roster: [{ name: "Owner Name", publicKey: OWNER.pub }] } });
});

const CANON = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json";
const CFG = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/persian-config.schema.json";

function repo(name, files) {
  const root = join(TMP, name);
  initRepo(root);                                    // the ledger's history is verified from git: a work tree is required
  for (const [f, body] of Object.entries(files)) writeJson(root, f, body);
  return root;
}
const PIN = new Map();   // root -> the owner-signed record that pins that tree's baseline (the fixture plays the owner)
const run = (root, ...argv) => runIn(root, argv, { trust: PIN.get(root) ?? REG });
/** The record the OWNER would sign for this tree: the roster, the anchor (HEAD) and the pin of the baseline set as it stands now. */
async function pinTree(root, persianExtra = {}) {
  const head = git(root, "rev-parse", "HEAD").stdout.trim();
  PIN.set(root, trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: head, roster: [{ name: "Owner Name", publicKey: OWNER.pub }], ...(await persianPins(root)), ...persianExtra } }));
}

const base = (extra = {}) => ({
  "kit.canon.json": { $schema: CANON, project: "saasreport", persian: "persian.config.json" },
  "persian.config.json": {
    $schema: CFG,
    sources: [{ name: "ui", files: ["src/*.js", "content/*.json"] }, { name: "podcast", files: ["podcast/*.md"], register: "spoken" }],
    exclude: [{ files: "src/legal.js", keys: ["quote"], reason: "verbatim quotations of the law, verified by hash" }],
    classes: { brand: ["کی‌وای‌ای"] },
    review: {},
    ...extra,
  },
  "src/ui.js": 'export const T = { a: "پرداخت خسارت انجام شد.", b: "کی‌وای‌ای پروتکل" };\n',
  "src/legal.js": 'export const L = [{ quote: "صفر پرداخت، و توسط بانك", note: "یادداشت ما" }];\n',
  "content/terms.json": { title: "تصمیم‌های اثرگذار بی‌پاسخ به یک پرسش ساده", tags: ["تسویه"] },
  "podcast/ep.md": "سلام! این قسمت درباره قسط، چک، و سپرده‌ست.\n",
  ".github/CODEOWNERS": "/fa-review.json @owner\n",
});

test("kit check persian: errors fail with file:line, rule, match and fix; quoted keys are skipped; there is no warning level", async () => {
  const root = repo("errors", base());
  const r = await run(root, "check", "persian", "--json");
  assert.equal(r.code, 1);
  const res = JSON.parse(r.out).results.persian;
  const got = res.problems.map((p) => `${p.file} ${p.problem.split(":")[0]}`).sort();
  assert.deepEqual(got, ["content/terms.json:2 fa-bi-calque", "podcast/ep.md:1 fa-comma-before-conj", "src/ui.js:1 fa-brand-before-head"]);
  assert.match(res.problems.find((p) => p.file.startsWith("src/ui.js")).problem, /«کی‌وای‌ای پروتکل» → «پروتکل کی‌وای‌ای»/);
  assert.match(res.summary, /^4 files, 6 Persian segments; \d+ rules; 3 findings$/);
});

test("kit check persian: a reviewed allow entry silences one finding; a stale one fails; a fa project must declare persian", async () => {
  const allow = [{ file: "src/ui.js", rule: "fa-brand-before-head", match: "کی‌وای‌ای پروتکل", context: "کی‌وای‌ای پروتکل", reason: "the registered Latin-order trade name, used once in the legal line" },
    { file: "src/ui.js", rule: "fa-passive-tavassot", match: "توسط", context: "توسط بانک", reason: "a stale entry that matches nothing at all" },
    { file: "content/terms.json", rule: "fa-bi-calque", match: "*", context: "any place", reason: "a wildcard is never allowed: one instance per entry" }];
  const root = repo("allow", base({ allow }));
  const r = await run(root, "check", "persian");
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /fa-brand-before-head: «/);
  assert.match(r.err, /stale allow entry .*fa-passive-tavassot/);
  assert.match(r.err, /persian-config: .*match/, "a wildcard match is refused by the schema");
  const f = base();
  f["kit.canon.json"] = { $schema: CANON, project: "saasreport", digits: { locale: "fa", files: ["site/*.html"] } };
  f["site/a.html"] = '<html lang="fa"><p>۱</p></html>';
  const r2 = await run(repo("undeclared", f), "check", "persian");
  assert.equal(r2.code, 1);
  assert.match(r2.err, /a Persian project \(digits.locale fa\) declares "persian"/);
});

test("kit persian fix --write applies only the safe typography fixes and logs old → new", async () => {
  const root = repo("fix", base());
  const dry = await run(root, "persian", "fix");
  assert.match(dry.out, /would fix 1 segment in 1 file/);
  const r = await run(root, "persian", "fix", "--write", "--log", "changes.json");
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(root, "podcast/ep.md"), "utf8"), "سلام! این قسمت درباره قسط، چک و سپرده‌ست.\n");
  const log = JSON.parse(readFileSync(join(root, "changes.json"), "utf8"));
  assert.deepEqual(log.map((c) => [c.file, c.rules]), [["podcast/ep.md", ["fa-comma-before-conj"]]]);
  assert.match(readFileSync(join(root, "src/legal.js"), "utf8"), /صفر پرداخت، و توسط بانك/); // a skipped quotation is never rewritten
});

const edit = (root) => writeFileSync(join(root, "src/ui.js"), 'export const T = { a: "پرداخت خسارت انجام شد.", b: "متن تازه که کسی نخوانده است" };\n');
const fixed = (root) => run(root, "persian", "fix", "--write");           // the sources of base() carry findings; review tests run on clean copy
async function reviewed(name) {
  const root = repo(name, base());
  await fixed(root);
  writeFileSync(join(root, "src/ui.js"), 'export const T = { a: "پرداخت خسارت انجام شد.", b: "پروتکل کی‌وای‌ای" };\n');
  writeFileSync(join(root, "content/terms.json"), JSON.stringify({ title: "تصمیم‌های اثرگذار و بی‌پاسخ", tags: ["تسویه"] }));
  commit(root);
  await pinTree(root);
  return root;
}
const approveUi = (root, key = OWNER.file, by = "Owner Name", ...files) => run(root, "persian", "approve", "--by", by, "--key", key, ...(files.length ? files : ["src/ui.js"]));

test("kit check fa-review: baseline passes, a change waits for a native reader, only the reader's SIGNED approval clears it", async () => {
  const root = await reviewed("review");
  let r = await run(root, "check", "fa-review");
  assert.equal(r.code, 1);
  assert.match(r.err, /fa-review\.json: missing: create it once with `kit persian baseline`/);
  r = await run(root, "persian", "baseline");
  assert.equal(r.code, 0, r.err); assert.match(r.out, /baseline: 4 files recorded in fa-review\.json, unsigned, anchored at the current commit/);
  commit(root);
  r = await run(root, "persian", "baseline");
  assert.equal(r.code, 1); assert.match(r.err, /baseline is only for creating the ledger/);
  r = await run(root, "check", "fa-review");
  assert.equal(r.code, 0, r.err); assert.match(r.out, /0 approved, 4 baseline, 0 awaiting/);
  edit(root); commit(root);
  r = await run(root, "check", "fa-review");
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/ui.js: Persian copy changed since its last review: baseline on .* kit persian approve --by "<name>" --key <your key> src\/ui.js/);
  r = await approveUi(root, OWNER.file, "Somebody");
  assert.equal(r.code, 1); assert.match(r.err, /--by must name a member of the roster/);
  r = await run(root, "persian", "approve", "--by", "Owner Name", "src/ui.js");
  assert.equal(r.code, 1); assert.match(r.err, /--key/, "no key, no approval");
  r = await approveUi(root, OTHER.file);
  assert.equal(r.code, 1); assert.match(r.err, /this key is not Owner Name's registered key/);
  for (const flag of ["--all", "--all-pending"]) { r = await run(root, "persian", "approve", "--by", "Owner Name", "--key", OWNER.file, flag); assert.equal(r.code, 1); assert.match(r.err, /no bulk signing/); }
  assert.equal((await approveUi(root)).code, 0);
  commit(root);
  r = await run(root, "check", "fa-review");
  assert.equal(r.code, 0, r.err); assert.match(r.out, /1 approved, 3 baseline, 0 awaiting/);
  const last = readJson(root, "fa-review.json").entries.at(-1);
  assert.deepEqual([last.file, last.by, last.status, last.seq], ["src/ui.js", "Owner Name", "approved", 5]);
  assert.match(last.at, /Z$/);
  // a hand-written approval by a name that is not in the roster, or with a bad signature, approves nothing
  const forged = readJson(root, "fa-review.json"); forged.entries.push({ ...last, seq: 6, by: "An Agent", prev: "0".repeat(64) });
  writeJson(root, "fa-review.json", forged);
  assert.equal((await run(root, "check", "fa-review")).code, 1);
  const edited = readJson(root, "fa-review.json"); edited.entries.pop(); edited.entries.at(-1).segments = 99;
  writeJson(root, "fa-review.json", edited);
  r = await run(root, "check", "fa-review");
  assert.equal(r.code, 1); assert.match(r.err, /the signature is not Owner Name's over this entry/);
});

test("B1: the ledger cannot be rewritten: a hand-edited baseline hash, an emptied ledger, delete and re-create, a reorder, a truncation", async () => {
  const mk = async (name) => { const root = await reviewed(name); await run(root, "persian", "baseline"); commit(root); assert.equal((await run(root, "check", "fa-review")).code, 0); return root; };
  const refused = async (root, re) => { const r = await run(root, "check", "fa-review"); assert.equal(r.code, 1); assert.match(r.err, re); };
  const rd = (root) => readJson(root, "fa-review.json"), wr = (root, l) => writeJson(root, "fa-review.json", l);
  let root = await mk("b1-hand");
  edit(root);
  const l = rd(root); l.entries = l.entries.map((e) => (e.file === "src/ui.js" ? { ...e, sha256: createHash("sha256").update("x").digest("hex") } : e));
  wr(root, l);
  await refused(root, /prev does not match|rewritten, re-sorted or removed/);
  root = await mk("b1-delete");
  edit(root); rmSync(join(root, "fa-review.json")); commit(root, "another commit so HEAD moves");
  const again = await run(root, "persian", "baseline");
  assert.equal(again.code, 1); assert.match(again.err, /is not the one the owner pinned/, "delete and re-create after editing: the owner's pin refuses the new baseline");
  await refused(root, /missing|deleted|anchor/);
  root = await mk("b1-reorder");
  const r1 = rd(root); r1.entries.reverse(); wr(root, r1);
  await refused(root, /seq|prev does not match/);
  root = await mk("b1-truncate");
  const r2 = rd(root); r2.entries.pop(); wr(root, r2);
  await refused(root, /rewritten, re-sorted or removed/);
  const clone = join(TMP, "b1-shallow");
  spawnSync("git", ["clone", "-q", "--depth", "1", `file://${root}`, clone], { encoding: "utf8" });
  assert.match((await run(clone, "check", "fa-review")).err, /shallow clone/);
});

test("ROOT D: kit persian migrate converts an old-format fa-review.json (50 baselines) in place, anchored at the migration commit; changed copy is NOT absorbed", async () => {
  const old = JSON.parse(readFileSync(new URL("./fixtures/old-fa-review.json", import.meta.url), "utf8"));
  assert.equal(old.entries.length, 50);
  const files = old.entries.map((e) => e.file);
  const root = join(TMP, "migrate"); initRepo(root);
  files.forEach((f, i) => writeJson(root, f, `export const T = "متن شماره ${i + 1} برای بازبینی";\n`.replace(/^/, /\.(md)$/.test(f) ? "" : "")));
  // the markdown and json files hold the same line as plain text
  files.filter((f) => /\.(md|json)$/.test(f)).forEach((f, i) => writeFileSync(join(root, f), f.endsWith(".json") ? JSON.stringify({ title: `عنوان شماره ${i + 1} برای بازبینی` }) : `متن شماره ${i + 1} برای بازبینی\n`));
  writeJson(root, "kit.canon.json", { $schema: CANON, project: "saasreport", persian: "persian.config.json" });
  writeJson(root, "persian.config.json", { $schema: CFG, sources: [{ name: "all", files }], review: {} });
  writeJson(root, ".github/CODEOWNERS", "/fa-review.json @owner\n");
  // make the first 30 entries' hashes the files' CURRENT hashes (they were reviewed and are unchanged); the other 20 keep their real, now stale hashes (changed since review)
  const { reviewState } = await import("../src/canon/persian.js");
  const cfg = readJson(root, "persian.config.json");
  const cur = new Map(reviewState(root, cfg, null).map((x) => [x.file, x]));
  const oldFile = { ...old, entries: old.entries.map((e, i) => (i < 30 ? { ...e, sha256: cur.get(e.file).sha256, segments: cur.get(e.file).segments } : e)) };
  writeJson(root, "fa-review.json", oldFile);
  const before = commit(root, "the old format, as in production");
  const oldSha = createHash("sha256").update(readFileSync(join(root, "fa-review.json"))).digest("hex");
  const roster = [{ name: "Owner Name", publicKey: OWNER.pub }];
  const NONE = trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: null, roster } });
  const { baselineHash } = await import("@saasreport/core/ledger");
  const pinSet = oldFile.entries.slice(0, 30).map((e) => ({ file: e.file, sha256: e.sha256 }));   // the 30 unchanged entries: the set the owner pins
  const MIG = trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: before, roster, migration: { sha256: oldSha, entries: 50 }, baseline: { sha256: baselineHash(pinSet), entries: 30 }, scope: (await persianPins(root)).scope } });
  const run = (root, ...argv) => runIn(root, argv, { trust: MIG });
  // T2: a record that names no migration (or another file) refuses to migrate: the one-shot is the OWNER's, recorded in the signed record
  let rr = await runIn(root, ["persian", "migrate"], { trust: NONE });
  assert.equal(rr.code, 1); assert.match(rr.err, /owner-signed trust record does not name this migration/);
  rr = await runIn(root, ["persian", "migrate"], { trust: trustWith("saasreport", { persian: { ledger: "fa-review.json", anchor: null, roster, migration: { sha256: "0".repeat(64), entries: 50 } } }) });
  assert.equal(rr.code, 1);
  // the old format is refused by the gate with the way out named, and refused for approving
  let r = await run(root, "check", "fa-review");
  assert.equal(r.code, 1); assert.match(r.err, /the old fa-review format: run `kit persian migrate`/);
  assert.equal((await run(root, "persian", "approve", "--by", "Owner Name", "--key", OWNER.file, "src/forms.js")).code, 1);
  r = await run(root, "persian", "migrate");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /migrated fa-review\.json in place: 30 baseline\(s\) from 50 old entries, anchored at the current commit/);
  assert.match(r.out, /20 file\(s\) changed since their last review stay PENDING/);
  const nl = readJson(root, "fa-review.json");
  assert.equal(nl.anchor.commit, before);
  assert.equal(nl.anchor.baselineThrough, 30);
  assert.equal(nl.anchor.migratedFrom.sha256, createHash("sha256").update(git(root, "show", `${before}:fa-review.json`).stdout).digest("hex"), "the old file's hash is recorded");
  assert.equal(nl.anchor.migratedFrom.entries, 50)
  assert.equal(nl.entries.length, 30);
  assert.ok(nl.entries.every((e) => e.status === "baseline" && cur.get(e.file).sha256 === e.sha256), "only unchanged entries became baselines");
  commit(root, "migrate");
  r = await run(root, "check", "fa-review");
  assert.equal(r.code, 1);
  assert.match(r.err, /Persian copy changed since its last review/);
  assert.match(r.out + r.err, /30 baseline, 20 awaiting native review/);
  assert.doesNotMatch(r.err, /anchor|history|migrat/, "the history check accepts the migration entry");
  // migrating twice is refused; a migrate that would absorb changed copy is not possible (the stale 20 stay pending)
  assert.equal((await run(root, "persian", "migrate")).code, 1);
  // the reader then signs the pending files, one named file at a time, and the gate passes for them
  assert.equal((await run(root, "persian", "approve", "--by", "Owner Name", "--key", OWNER.file, files[30])).code, 0);
  assert.match((await run(root, "check", "fa-review")).out + (await run(root, "check", "fa-review")).err, /1 approved, 30 baseline, 19 awaiting/);
});


test("an allow entry for a source's text also covers the same text in a podcast script built from it", async () => {
  const { lintSources } = await import("../src/canon/persian.js");
  const { persianLinter } = await import("@saasreport/fa-lint");
  const allow = [{ file: "src/ui.js", rule: "fa-brand-before-head", match: "کی‌وای‌ای پروتکل", context: "کی‌وای‌ای پروتکل", reason: "the registered trade name, reviewed" }];
  const root = repo("allow-podcast", base({ allow }));
  const cfg = JSON.parse(readFileSync(join(root, "persian.config.json"), "utf8"));
  const r = await lintSources(root, cfg, persianLinter({ classes: cfg.classes }), { podcast: false });
  assert.ok(!r.findings.some((f) => f.rule === "fa-brand-before-head"));
  // the same place reported from a built script (podcast:<slug>) is covered; another place with the same text is not (one instance)
  const { allowedFinding } = await import("../src/canon/persian.js");
  const f = { file: "podcast:ep-1", rule: "fa-brand-before-head", match: "کی‌وای‌ای پروتکل", context: "ما کی‌وای‌ای پروتکل را می‌سازیم" };
  assert.ok(allowedFinding(allow, f));
  assert.ok(!allowedFinding(allow, { ...f, context: "یک جمله دیگر با نام دیگر" }));
  assert.ok(!allowedFinding([{ ...allow[0], match: "*" }], f));
});

test("parity: the runtime podcast gate and kit check persian give identical findings for the same scripts", async () => {
  const { podcastScripts, lintSources } = await import("../src/canon/persian.js");
  const { persianGate } = await import("@saasreport/podcast");
  const { persianLinter } = await import("@saasreport/fa-lint");
  const dir = join(TMP, "parity");
  assert.equal(await main(["init", dir, "--locale", "fa", "--name", "parity", "--link"], { out: () => {}, err: () => {}, cwd: TMP }), 0);
  const cfg = { $schema: "x", sources: [{ files: ["kit.config.js"] }], classes: { brand: ["پاریتی"] }, podcast: { config: "kit.config.js", from: "2026-10-03", days: 60 },
    allow: [{ file: "kit.config.js", rule: "fa-passive-tavassot", match: "توسط", context: "توسط بانک", reason: "a reviewed entry, to prove the allow-list is shared" }] };
  const { items } = await podcastScripts(dir, cfg.podcast);
  assert.ok(items.length > 0, "the starter project has podcast scripts");
  // put known findings into the scripts: an error, an allowed text and a brand-order error that needs the project's classes
  const lines = [...items[0].lines, { speaker: "host", text: "قسط، چک، یا سپرده توسط بانک پاریتی پروتکل" }];
  const runtime = persianGate({ site: { locale: "fa" } }, { config: cfg })(lines, items[0].slug);
  const ci = (await import("@saasreport/fa-lint")).projectGate({ config: cfg, linter: persianLinter({ classes: cfg.classes }) })(lines, { file: `podcast:${items[0].slug}` });
  assert.deepEqual(runtime.findings, ci.findings);
  assert.deepEqual(runtime.findings.filter((f) => f.line === lines.length).map((f) => f.rule).sort(), ["fa-brand-before-head", "fa-comma-before-conj"]);
  assert.equal(runtime.allowed.length, 1);
  // and kit check persian over the project reports the scripts through the same gate
  writeFileSync(join(dir, "persian.config.json"), JSON.stringify(cfg));
  const r = await lintSources(dir, cfg, persianLinter({ classes: cfg.classes }));
  assert.equal(r.scripts, items.length);
  // every script, through both: lintSources (what CI reports) and the runtime gate give the same findings, allow-list included
  const gate = persianGate({ site: { locale: "fa" } }, { config: cfg });
  const fromCi = r.findings.filter((f) => f.file.startsWith("podcast:")).map((f) => `${f.file}:${f.line} ${f.rule} ${f.match}`);
  const fromRuntime = items.flatMap((e) => gate(e.lines, e.slug).findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.match}`));
  assert.ok(fromRuntime.length > 0, "there are findings to compare");
  assert.deepEqual(fromCi, fromRuntime);
});

test("the review hash is the raw copy: stable when only code around it changes, moved by any edit of the copy", async () => {
  const { reviewState } = await import("../src/canon/persian.js");
  const root = repo("hash", base());
  const cfg = JSON.parse(readFileSync(join(root, "persian.config.json"), "utf8"));
  const h = () => reviewState(root, cfg, null).find((x) => x.file === "src/ui.js").sha256;
  const before = h();
  writeFileSync(join(root, "src/ui.js"), '// a comment\nexport const N = 2;\nexport const T = { a: "پرداخت خسارت انجام شد.", b: "کی‌وای‌ای پروتکل" };\n');
  assert.equal(h(), before);
  writeFileSync(join(root, "src/ui.js"), 'export const T = { a: "پرداخت خسارت انجام شد.", b: "کی‌وای‌ای  پروتکل" };\n');
  assert.notEqual(h(), before, "even a typography edit of the copy is a change to read");
});

test("the review hash does not depend on the linter: it equals the sha256 of the raw copy, even where the normalizer and extractor rewrite it", async () => {
  const { reviewState } = await import("../src/canon/persian.js");
  const { createHash } = await import("node:crypto");
  // copy the normalizer rewrites (Arabic ي/ك, a ZWJ, a space-separated «می شود») and the extractor rewrites (a link with a
  // parenthesised target, a multi-line template literal): improving either must never move the hash
  const a = "كتاب ها مي شود \u200d";
  const b = "[لینک](/a/(b) ها.png) و\nادامه";
  const root = repo("hash-raw", { ...base(), "src/ui.js": `export const T = { a: "${a}", b: \`${b}\` };\n` });
  const cfg = JSON.parse(readFileSync(join(root, "persian.config.json"), "utf8"));
  const state = reviewState(root, cfg, null).find((x) => x.file === "src/ui.js");
  const raw = createHash("sha256").update(`${a}\u241e${b}\u241e`).digest("hex");
  assert.equal(state.sha256, raw, "the hash is over the raw segment text, nothing the linter derives");
});
