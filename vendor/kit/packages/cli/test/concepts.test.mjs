// kit concepts, kit shariah, kit ledger and kit check concepts|shariah-review (docs/CONCEPTS.md) on throw-away repositories. The roster and the ledger's
// place come from the kit project registry, injected through io.registry; keys are made by `kit ledger keygen` and unlocked by an injected passphrase prompt.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { config, catalogue } from "../../core/test/fixtures/concepts.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import { PASS, readJson, writeJson, git, commit, initRepo, trustWith, run as runIn, keygen, setKeyDir, seamFor } from "./approvals-helpers.mjs";
const TMP = fileTempDir("kit-concepts-");
let SCHOLAR, OTHER, REG;
const PROJECT = "saasreport";
before(async () => {
  setKeyDir(join(TMP, "keys"));
  SCHOLAR = await keygen(TMP, "scholar"); OTHER = await keygen(TMP, "other");
  REG = trustWith(PROJECT, { concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [{ name: "Dr Reviewer", publicKey: SCHOLAR.pub }] } });
});

const CANON = (project) => ({ $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/canon.schema.json", project });
const texts = (cat) => Object.fromEntries(cat.concepts.filter((c) => c.accuracy.status === "verified").flatMap((c) => c.sources.map((s) => [`texts/${s.sha256}.txt`, `…${s.quote}…`])));
function repo(name, { cfg = config({ order: { strategy: "catalogue" }, gate: { accuracy: { minVerifiedPrefix: 2, unverified: "never" } } }), cat = catalogue(), project = PROJECT, extra = {}, owners = "/shariah-review.json @s\n/concepts.config.json @s\n" } = {}) {
  const root = join(TMP, name);
  initRepo(root);
  const files = { "concepts.config.json": cfg, [cfg.catalogue]: cat, "kit.canon.json": CANON(project), ".github/CODEOWNERS": owners, ...texts(cat), ...extra };
  for (const [f, body] of Object.entries(files)) writeJson(root, f, body);
  return root;
}
const run = (root, ...argv) => runIn(root, argv, { trust: REG });
const approve = (root, ids, key = SCHOLAR.file, by = "Dr Reviewer") => run(root, "shariah", "approve", "--by", by, "--key", key, "--statement", "Read the entry and the AAOIFI text.", ...ids);
const S = ["concepts", "schedule", "--today", "2026-10-20"];
const withReg = (trust, root, ...argv) => runIn(root, argv, { trust });

test("kit check concepts: a valid series passes; a verified source with no document text, a wrong quote and too few concepts fail", async () => {
  const GEN = trustWith("saasreport", { concepts: "general" });
  const run = (root, ...argv) => withReg(GEN, root, ...argv);
  const root = repo("check", { project: "saasreport" });
  let r = await run(root, "check", "concepts");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /general series contracts-in-a-minute: 7 concepts \(6 verified, 1 unverified\), 0 scheduled/);
  const sha = catalogue().concepts[0].sources[0].sha256;
  writeFileSync(join(root, `texts/${sha}.txt`), "a different document entirely");
  r = await run(root, "check", "concepts");
  assert.equal(r.code, 1);
  assert.match(r.err, /the quote is not in the document text/);
  rmSync(join(root, `texts/${sha}.txt`));
  assert.match((await run(root, "check", "concepts")).err, /no document text texts\/[a-f0-9]+\.txt, so the quote cannot be proven/);
  const few = repo("check-few", { project: "saasreport", cfg: config({ minConcepts: 9, order: { strategy: "catalogue" } }) });
  assert.match((await run(few, "check", "concepts")).err, /7 concepts, fewer than the 9 this series requires/);
  const bad = catalogue(); bad.concepts[0].related = ["ghost"]; bad.concepts[1].theme = "nowhere";
  writeJson(root, "content/concepts.catalogue.json", bad);
  r = await run(root, "check", "concepts");
  assert.match(r.err, /related "ghost" is not a concept/); assert.match(r.err, /theme "nowhere"/);
  assert.equal((await run(root, "concepts", "verify")).code, 1);
});

test("ROOT A: the series' kind, the ledger's place and the roster come from the kit registry; the project's files cannot change them", async () => {
  // the config file cannot say what it is, or switch the review gate off (the schema has no such fields)
  const none = config({ order: { strategy: "catalogue" } }); none.kind = "general"; none.gate.review = { mode: "none" };
  const r0 = await run(repo("a-none", { cfg: none }), "check", "concepts");
  assert.equal(r0.code, 1); assert.match(r0.err, /unknown property|kind|review/);
  // a project the registry calls general runs no ledger: a ledger file in the repo approves nothing there
  const general = withReg(trustWith(PROJECT, { concepts: "general" }), repo("a-general"), "concepts", "status", "--today", "2026-10-20");
  assert.match((await general).out, /7 concepts/);
  // an unknown project has no registered approvers: nothing is checked as approved, the check fails
  const unknown = repo("a-unknown", { project: "someone-else" });
  const u = await run(unknown, "check", "concepts");
  assert.equal(u.code, 1); assert.match(u.err, /no owner-signed trust record/);
  // the roster is the registry's: an empty roster approves nothing, however the repo's own files read
  const empty = repo("a-empty");
  commit(empty);
  await run(empty, "shariah", "init");
  const ra = await withReg(trustWith(PROJECT, { concepts: "shariah", shariah: { ledger: "shariah-review.json", anchor: null, roster: [] } }), empty, "shariah", "approve", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Read the entry and the AAOIFI text.", "murabaha");
  assert.equal(ra.code, 1); assert.match(ra.err, /is not in the roster/);
  // canon: the registry decides whether a concept series must exist. Deleting the config cannot switch the gate off; an unregistered one cannot switch it on.
  const canon = repo("a-canon");
  commit(canon); await run(canon, "shariah", "init"); commit(canon);
  assert.equal((await run(canon, "check", "canon", "--only", "concepts")).code, 0);
  rmSync(join(canon, "concepts.config.json"));
  const gone = await run(canon, "check", "canon", "--only", "concepts");
  assert.equal(gone.code, 1); assert.match(gone.err, /concepts\.config\.json is missing: the gate cannot be removed by deleting the file/);
  const plain = repo("a-plain", { project: "saasreport" });
  const unreg = await withReg(trustWith("saasreport", { }), plain, "check", "canon", "--only", "concepts");
  assert.equal(unreg.code, 1); assert.match(unreg.err, /no owner-signed trust record names a concept series/);
  // a project with no concept series and no file: not applicable, proven from the registry
  const none2 = join(TMP, "a-none2"); initRepo(none2); writeJson(none2, "kit.canon.json", CANON("saasreport"));
  const np = await withReg(trustWith("saasreport", {}), none2, "check", "canon", "--only", "concepts");
  assert.equal(np.code, 0, np.err); assert.match(np.out, /not applicable \(the owner-signed trust record names no concept series/);
});

test("identity: an approval is a signature by a roster member's own key; a commit email, another key, a forged name, a hand-written entry or no key approves nothing", async () => {
  const root = repo("id"); commit(root);
  await run(root, "shariah", "init"); commit(root);
  let r = await approve(root, ["murabaha"], OTHER.file);
  assert.equal(r.code, 1); assert.match(r.err, /this key is not Dr Reviewer's registered key/);
  r = await run(root, "shariah", "approve", "--by", "Dr Reviewer", "--statement", "Read the entry and the AAOIFI text.", "murabaha");
  assert.equal(r.code, 1); assert.match(r.err, /--key/);
  r = await approve(root, ["murabaha"], SCHOLAR.file, "An Agent");
  assert.equal(r.code, 1); assert.match(r.err, /is not in the roster/);
  assert.equal(readJson(root, "shariah-review.json").entries.length, 0, "nothing was appended by a refused approval");
  assert.equal((await approve(root, ["murabaha"])).code, 0);
  commit(root, "approved by email only: scholar@example.org");
  const l = readJson(root, "shariah-review.json");
  const forged = JSON.parse(JSON.stringify(l)); forged.entries[0].by = "Dr Reviewer"; forged.entries[0].sig = l.entries[0].sig.replace(/.$/, (c) => (c === "A" ? "B" : "A")); // a different signature
  writeJson(root, "shariah-review.json", forged);
  assert.match((await run(root, "check", "shariah-review")).err, /sig|signature/);
  const nosig = JSON.parse(JSON.stringify(l)); delete nosig.entries[0].sig;
  writeJson(root, "shariah-review.json", nosig);
  assert.equal((await run(root, "check", "shariah-review")).code, 1);
});

test("ROOT B: no environment key, no bulk signing, no in-repo or unencrypted key, no passphrase without a person; keygen writes an encrypted key in a 0700 directory outside the work tree", async () => {
  const root = repo("b"); commit(root);
  await run(root, "shariah", "init"); commit(root);
  const pem = readFileSync(SCHOLAR.file, "utf8");
  assert.match(pem, /ENCRYPTED PRIVATE KEY/);
  assert.equal(statSync(dirname(SCHOLAR.file)).mode & 0o777, 0o700);
  assert.equal(statSync(SCHOLAR.file).mode & 0o777, 0o600);
  // KIT_APPROVER_KEY is not read
  const saved = process.env.KIT_APPROVER_KEY; process.env.KIT_APPROVER_KEY = pem;
  let r = await run(root, "shariah", "approve", "--by", "Dr Reviewer", "--statement", "Read the entry and the AAOIFI text.", "murabaha");
  delete process.env.KIT_APPROVER_KEY; if (saved) process.env.KIT_APPROVER_KEY = saved;
  assert.equal(r.code, 1); assert.match(r.err, /--key/);
  // no bulk signing
  for (const flag of ["--all", "--all-pending"]) { r = await approve(root, [flag]); assert.equal(r.code, 1); assert.match(r.err, /no bulk signing/); }
  assert.equal(readJson(root, "shariah-review.json").entries.length, 0);
  // an in-repo key (even a copy of a good one) and an unencrypted key are refused
  writeFileSync(join(root, "mine.pem"), pem);
  r = await approve(root, ["murabaha"], join(root, "mine.pem")); assert.equal(r.code, 1); assert.match(r.err, /inside a git work tree/);
  const plain = join(TMP, "keys", "plain.pem");
  const { generateKeyPairSync } = await import("node:crypto");
  writeFileSync(plain, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  r = await approve(root, ["murabaha"], plain); assert.equal(r.code, 1); assert.match(r.err, /not passphrase-encrypted/);
  // the wrong passphrase
  r = await runIn(root, ["shariah", "approve", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Read the entry and the AAOIFI text.", "murabaha"], { trust: REG, prompt: async () => "the wrong passphrase" });
  assert.equal(r.code, 1); assert.match(r.err, /wrong passphrase/);
  // no terminal and no injected prompt (a script, an agent, CI): refused. The real prompt needs a TTY.
  r = await runIn(root, ["shariah", "approve", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Read the entry and the AAOIFI text.", "murabaha"], { trust: REG, seam: { prompt: undefined } });
  assert.equal(r.code, 1); assert.match(r.err, /only read from an interactive terminal/);
  // keygen: any path inside a work tree is refused, however deep and however new; an existing key is never overwritten; passphrases must be strong and agree
  for (const out of ["approver.pem", "keys/approver.pem", "new/deep/er/approver.pem"]) {
    const k = await runIn(root, ["ledger", "keygen", "--out", join(root, out)], {});
    assert.equal(k.code, 1, out); assert.match(k.err, /inside a git work tree/); assert.equal(existsSync(join(root, out)), false);
  }
  assert.equal((await runIn(root, ["ledger", "keygen", "--out", SCHOLAR.file], {})).code, 1);
  assert.match((await runIn(root, ["ledger", "keygen", "--out", join(TMP, "keys", "w2.pem")], { prompt: async () => "short" })).err, /at least 12 characters/);
  let n = 0;
  assert.match((await runIn(root, ["ledger", "keygen", "--out", join(TMP, "keys", "w3.pem")], { prompt: async () => (n++ ? "another long passphrase 2" : "a long test passphrase 1") })).err, /passphrases differ/);
});

test("kit concepts schedule: a Shariah series schedules nothing until a reviewer signs, then appends; --today is required; the dry run writes nothing", async () => {
  const root = repo("sched"); commit(root);
  await run(root, "shariah", "init"); commit(root);
  let r = await run(root, "concepts", "schedule");
  assert.equal(r.code, 1); assert.match(r.err, /--today YYYY-MM-DD is required/);
  r = await run(root, ...S);
  assert.match(r.out, /0 concept\(s\) would be appended/);
  assert.equal((await approve(root, ["murabaha", "salam"])).code, 0);
  r = await run(root, ...S);
  assert.match(r.out, /2026-11-01\s+#1\s+murabaha/); assert.match(r.out, /\(--write saves it\)/);
  assert.equal(existsSync(join(root, "content/concepts.schedule.json")), false, "the dry run wrote nothing");
  assert.equal((await run(root, ...S, "--write")).code, 0);
  assert.deepEqual(readJson(root, "content/concepts.schedule.json").entries.map((e) => e.id), ["murabaha", "salam"]);
  assert.equal((await run(root, ...S, "--write")).code, 0);
  assert.equal(readJson(root, "content/concepts.schedule.json").entries.length, 2, "again adds nothing");
});

test("the deploy gate: an edit after approval holds the concept and fails; withdrawal holds; CODEOWNERS must cover the ledger; a shallow clone fails", async () => {
  const root = repo("gate"); commit(root);
  await run(root, "shariah", "init"); commit(root);
  await approve(root, ["murabaha"]);
  await run(root, ...S, "--write");
  commit(root, "approve");
  let r = await run(root, "check", "shariah-review");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1 approved, 6 unreviewed, 0 changed since approval; 1 scheduled; 1 member\(s\)/);
  const cat = catalogue(); cat.concepts[0].definition["en-GB"] = "A sentence that was edited after the approval.";
  writeJson(root, "content/concepts.catalogue.json", cat);
  writeFileSync(join(root, `texts/${cat.concepts[0].sources[0].sha256}.txt`), `…${cat.concepts[0].sources[0].quote}…`);
  r = await run(root, "check", "shariah-review");
  assert.equal(r.code, 1); assert.match(r.err, /scheduled but not approved: murabaha \(2026-11-01\): changed/);
  const st = await run(root, "concepts", "status", "--today", "2026-10-20");
  assert.match(st.out, /0 publishable now, 1 held/); assert.match(st.out, /held 2026-11-01 murabaha: review: changed/);
  writeJson(root, "content/concepts.catalogue.json", catalogue());
  assert.equal((await run(root, "shariah", "withdraw", "--by", "Dr Reviewer", "--key", SCHOLAR.file, "--statement", "Withdrawn pending a correction.", "murabaha")).code, 0);
  commit(root, "withdraw");
  assert.match((await run(root, "check", "shariah-review")).err, /scheduled but not approved: murabaha \(2026-11-01\): withdrawn/);
  writeFileSync(join(root, ".github/CODEOWNERS"), "/concepts.config.json @s\n");
  assert.match((await run(root, "check", "shariah-review")).err, /shariah-review\.json: not covered by CODEOWNERS/);
  writeFileSync(join(root, ".github/CODEOWNERS"), "/shariah-review.json @s\n/concepts.config.json @s\n"); commit(root);
  const clone = join(TMP, "gate-shallow");
  spawnSync("git", ["clone", "-q", "--depth", "1", `file://${root}`, clone], { encoding: "utf8" });
  assert.match((await run(clone, "check", "shariah-review")).err, /cannot be verified on a shallow clone/);
});

test("kit check canon runs the Shariah check (not only a deploy script), and a notApplicable declaration cannot waive it", async () => {
  const root = repo("canon"); commit(root);
  await run(root, "shariah", "init"); commit(root);
  await approve(root, ["murabaha"]); commit(root, "approve");
  let r = await run(root, "check", "canon", "--only", "concepts");
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /ok concepts: shariah series contracts-in-a-minute/);
  const l = readJson(root, "shariah-review.json"); l.entries[0].statement = "Edited after the reviewer signed it.";
  writeJson(root, "shariah-review.json", l);
  r = await run(root, "check", "canon", "--only", "concepts");
  assert.equal(r.code, 1); assert.match(r.err, /the signature is not Dr Reviewer's over this entry/);
  const nope = repo("canon-na", { extra: { "kit.canon.json": { ...CANON(PROJECT), notApplicable: { persian: { predicate: "no-persian-content" } } } } });
  assert.equal((await run(nope, "check", "canon", "--only", "concepts")).code, 1);
});

test("a generic 'scholars' label, a contested concept without views and a verified concept without the document's sha256 are refused by the check", async () => {
  const cat = catalogue(); cat.concepts.find((c) => c.contested).views[0].label = "Scholars";
  assert.match((await run(repo("r4", { cat }), "check", "concepts")).err, /view label "Scholars" names no holder/);
  const noViews = catalogue(); delete noViews.concepts.find((c) => c.contested).views;
  assert.match((await run(repo("r4-views", { cat: noViews }), "check", "concepts")).err, /views/);
  const noSha = catalogue(); delete noSha.concepts[0].sources[0].sha256;
  assert.match((await run(repo("r4-sha", { cat: noSha }), "check", "concepts")).err, /sha256/);
});

test("kit check concepts --history: the schedule is append-only across commits", async () => {
  const root = repo("history", { project: "saasreport" });
  const reg = trustWith("saasreport", { concepts: "general" });
  const go = (...a) => withReg(reg, root, ...a);
  commit(root);
  await go(...S, "--write"); commit(root);
  assert.equal((await go("check", "concepts", "--history")).code, 0);
  const s = readJson(root, "content/concepts.schedule.json");
  [s.entries[0].id, s.entries[1].id] = [s.entries[1].id, s.entries[0].id];
  writeJson(root, "content/concepts.schedule.json", s);
  const r = await go("check", "concepts", "--history");
  assert.equal(r.code, 1); assert.match(r.err, /an earlier entry changed or was removed in the working tree: the schedule is append-only/);
});

test("kit concepts script prints the two-host script, its size and the page", async () => {
  const root = repo("script");
  const r = await run(root, "concepts", "script", "tawarruq");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^amina: Is tawarruq accepted everywhere\?/);
  assert.match(r.out, /\d+ words in the talk \(limit 40-130\); approval hash [0-9a-f]{64}/);
  assert.match(r.out, /- Position A: Permitted when/);
  void PASS; void git;
});
