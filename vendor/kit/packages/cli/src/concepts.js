/**
 * The CLI side of concept series (docs/CONCEPTS.md): loading and checking concepts.config.json with its catalogue, schedule, source texts and
 * (a Shariah series) its signed approval ledger.
 *
 *   loadConcepts(root, kit, { file })          → { file, config, catalogue, schedule, review, approvals, expect, scheduleMissing, reviewMissing, problems } (async: the ledger is verified)
 *   checkConceptsRepo(root, kit, opts)         kit check concepts, and the concepts step of kit check canon: schemas, catalogue and schedule,
 *                                              the mechanical verification of every verified source, and for a Shariah series the ledger
 *                                              (chain, signatures against the roster, CODEOWNERS)
 *   checkShariahReview(root, kit, opts)        the deploy gate: all of the above, the ledger's git history, and every SCHEDULED concept
 *                                              approved at its current text
 *   scheduleHistoryProblems(root, file, ...)   the schedule is append-only across git history
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitEnv } from "./git.js";
import { formatProblems } from "@saasreport/core/schema";
import { checkCatalogue, checkSchedule, approvalHash, conceptStatus, reviewState, quoteInText } from "@saasreport/core/concepts";
import { verifyLedger } from "@saasreport/core/ledger";
import { codeownersCover } from "./canon/persian.js";
import { readLedgerFile, ledgerHistoryProblems, witnessCheck, verifierProblems, LEDGER_SCHEMA_URL } from "./ledger-io.js";

export const CONCEPTS_FILE = "concepts.config.json";
const P = (file, problem) => ({ file, problem });
const readJson = (root, file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const SCHEMA = (n) => `https://github.com/SaasReport/kit/blob/main/packages/core/schemas/${n}.schema.json`;

export async function loadConcepts(root, kit, { file = CONCEPTS_FILE } = {}) {
  const problems = [];
  if (!existsSync(join(root, file))) return { file, config: null, problems: [P(file, "missing")] };
  let config;
  try { config = readJson(root, file); } catch (e) { return { file, config: null, problems: [P(file, `not JSON: ${e.message}`)] }; }
  for (const m of formatProblems(kit.validator.validate(config, kit.byName("concepts-config")))) problems.push(P(file, `concepts-config: ${m}`));
  if (problems.length) return { file, config: null, problems };
  // Who may approve what, and where, is the OWNER-SIGNED trust record's to say (never this file's): the series kind, the ledger's path, kind, anchor and roster.
  let project;
  try { project = readJson(root, "kit.canon.json").project; } catch { return { file, config: null, problems: [P("kit.canon.json", "missing or not JSON: the project key (which the kit registry maps to its approval ledgers) is read from it")] }; }
  const ap = await kit.approvals(project);
  if (!ap.known) return { file, config: null, problems: ap.problems.map((m) => P("kit.canon.json", `trust record: ${m}`)) };
  if (ap.concepts == null) return { file, config: null, problems: [P("kit.canon.json", `the owner-signed trust record for "${project}" records no concept series: the owner signs it (kit trust) in the same change that adds the series`)] };
  const canon = { project };
  const kind = ap.concepts;
  config = { ...config, kind, gate: { ...config.gate, review: kind === "shariah" ? { mode: "shariah-ledger", ledger: ap.shariah?.ledger } : { mode: "none" } } };
  if (kind === "shariah" && !ap.shariah) problems.push(P(file, `the kit registry marks ${canon.project}'s concept series as Shariah but records no shariah ledger for it`));
  const load = (path, schema, what, optional = false) => {
    if (!existsSync(join(root, path))) { if (!optional) problems.push(P(path, `${what} is missing`)); return null; }
    let v;
    try { v = readJson(root, path); } catch (e) { problems.push(P(path, `not JSON: ${e.message}`)); return null; }
    for (const m of formatProblems(kit.validator.validate(v, kit.byName(schema)))) problems.push(P(path, `${schema}: ${m}`));
    return v;
  };
  const catalogue = load(config.catalogue, "concept-catalogue", "the catalogue");
  const sched = load(config.schedule, "concept-schedule", "the schedule", true);
  const scheduleMissing = !sched;
  const schedule = sched || { $schema: SCHEMA("concept-schedule"), series: config.series.id, entries: [] };
  let review = null, reviewMissing = false, approvals = null, expect = null;
  if (kind === "shariah" && ap.shariah) {
    expect = ap.shariah;
    const r = readLedgerFile(root, expect.ledger, kit);
    problems.push(...r.problems);
    reviewMissing = r.missing;
    review = r.ledger;
    approvals = review && !r.problems.length ? await verifyLedger(review, { expect, bootstrap: expect.bootstrap }) : { ok: false, problems: reviewMissing ? ["the ledger does not exist"] : ["the ledger does not parse"], subjects: new Map(), roster: expect.bootstrap, head: null };
  }
  return { file, config, catalogue, schedule, review, approvals, expect, project: canon.project, scheduleMissing, reviewMissing, problems };
}

/** Scenario ids of the project's widgets.spec.json (when it has one). */
function widgetScenarios(root) {
  try { return new Set((readJson(root, "widgets.spec.json").scenarios || []).map((s) => s.id)); } catch { return null; /* no readable widgets.spec.json: scenario ids are not checked (null, not an empty set) */ }
}

const git = (root, args) => { const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv() }); return r.status === 0 ? r.stdout : null; };

/** The schedule is append-only: every committed version (and the working tree) extends the previous one without changing an entry. Needs the full history. */
export function scheduleHistoryProblems(root, file, current) {
  if (git(root, ["rev-parse", "--is-shallow-repository"])?.trim() === "true") return [P(file, "append-only history cannot be verified on a shallow clone: fetch the full history (CI: actions/checkout with fetch-depth: 0). A check that cannot run is not a pass")];
  if (git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return [P(file, "append-only history cannot be verified: this is not a git work tree (a check that cannot run is not a pass)")];
  const log = (git(root, ["log", "--format=%H", "--", file]) ?? "").split("\n").filter(Boolean).reverse();
  const versions = [];
  for (const sha of log) { const t = git(root, ["show", `${sha}:${file}`]); if (t == null) continue; try { versions.push([sha.slice(0, 12), JSON.parse(t)]); } catch { versions.push([sha.slice(0, 12), { entries: [] }]); } }
  if (current) versions.push(["the working tree", current]);
  const out = [], key = (e) => `${e.id}|${e.date}|${e.order}|${e.sha256}`;
  for (let i = 1; i < versions.length; i++) {
    const [, a] = versions[i - 1], [where, b] = versions[i];
    const A = (a.entries || []).map(key), B = (b.entries || []).map(key);
    if (B.length < A.length || A.some((k, j) => B[j] !== k)) out.push(P(file, `an earlier entry changed or was removed in ${where}: the schedule is append-only (a day never changes meaning; withdraw a concept in the review ledger instead)`));
  }
  return out;
}

/** Every verified source is proven mechanically: the document text (named by its sha256) exists and contains the quote. `verified` is never an assertion. */
export function sourceProofProblems(root, config, catalogue) {
  const out = [], dir = config.verify.texts, cache = new Map();
  for (const c of catalogue.concepts) {
    if (c.accuracy.status !== "verified") continue;
    for (const [i, s] of c.sources.entries()) {
      const where = `concept ${c.id} source ${i + 1} (${s.document}, ${s.section})`;
      if (!s.sha256) { out.push(P(config.catalogue, `${where}: a verified concept needs the sha256 of the fetched document`)); continue; }
      const f = join(root, dir, `${s.sha256}.txt`);
      if (!existsSync(f)) { out.push(P(config.catalogue, `${where}: no document text ${dir}/${s.sha256}.txt, so the quote cannot be proven (a verified concept is a mechanical fact: extract the document and keep its text)`)); continue; }
      if (!cache.has(f)) cache.set(f, readFileSync(f, "utf8"));
      if (!quoteInText(s.quote, cache.get(f))) out.push(P(config.catalogue, `${where}: the quote is not in the document text`));
    }
  }
  return out;
}

/** The ledger of a Shariah series: identity, anchor, chain, roster and every signature verify (the registry's expectations); CODEOWNERS covers the ledger and the config. */
function ledgerIntegrityProblems(root, c) {
  const out = [], ledgerFile = c.expect.ledger;
  if (c.reviewMissing) { out.push(P(ledgerFile, "missing: create it with `kit shariah init` (an empty ledger approves nothing, so nothing is scheduled)")); return out; }
  if (!c.review) return out;
  for (const m of c.approvals.problems) out.push(P(ledgerFile, m));
  const ids = new Set(c.catalogue.concepts.map((k) => k.id));
  for (const e of c.review.entries) {
    if (e.id && !ids.has(e.id)) out.push(P(ledgerFile, `stale entry: ${e.id} is not a concept any more`));
    if (e.status === "approved" && !(e.attests || []).length) out.push(P(ledgerFile, `${e.id}: an approval carries its attestations`));
    if (e.status === "baseline") out.push(P(ledgerFile, `${e.id}: a baseline entry in a Shariah ledger: nothing is live before this gate, and a baseline never schedules`));
  }
  for (const f of [ledgerFile, c.file]) if (!codeownersCover(root, f)) out.push(P(f, `not covered by CODEOWNERS: add "/${f} @<reviewer or owner>" (.github/CODEOWNERS) so the ledger cannot change without their review`));
  return out;
}

/** kit check concepts (and kit check canon): schemas, catalogue and schedule semantics, source proof, widget scenarios, the Shariah ledger; flags: git history and the runway. */
export async function checkConceptsRepo(root, kit, { file = CONCEPTS_FILE, history = false, runway = false, today = null, witness = null, verifier = null, local = false } = {}) {
  const c = await loadConcepts(root, kit, { file });
  if (!c.config) return { ok: false, problems: c.problems, summary: file };
  const problems = [...c.problems];
  if (!c.catalogue) return { ok: false, problems, summary: file };
  for (const m of checkCatalogue(c.catalogue, c.config)) problems.push(P(c.config.catalogue, m));
  for (const m of checkSchedule(c.schedule, c.catalogue, c.config, c.approvals)) problems.push(P(c.config.schedule, m));
  problems.push(...sourceProofProblems(root, c.config, c.catalogue));
  if (c.config.gate.review.mode === "shariah-ledger") problems.push(...ledgerIntegrityProblems(root, c));
  if (history && !local && c.review && c.approvals?.ok) { problems.push(...await witnessCheck(root, witness, c.review, c.expect)); problems.push(...await verifierProblems(verifier, c.project, "shariah", c.review, c.expect, { root, kit })); }   // the deploy gate: a missing witness fails closed after the signed witnessFrom
  const scen = widgetScenarios(root);
  if (scen) for (const k of c.catalogue.concepts) if (k.widget && !scen.has(k.widget.scenario)) problems.push(P(c.config.catalogue, `concept ${k.id}: widget scenario "${k.widget.scenario}" is not in widgets.spec.json scenarios`));
  if (history) {
    problems.push(...scheduleHistoryProblems(root, c.config.schedule, c.schedule));
    if (c.review) problems.push(...ledgerHistoryProblems(root, c.expect.ledger, c.review, { migration: c.expect.migration, anchor: c.expect.anchor }));
  }
  const st = conceptStatus({ catalogue: c.catalogue, config: c.config, schedule: c.schedule, approvals: c.approvals, today: today ?? c.schedule.entries.at(-1)?.date ?? c.config.series.start });
  if (runway) {
    if (!today) problems.push(P(c.file, "--runway needs --today YYYY-MM-DD (the check never reads the clock)"));
    else if (!st.runwayOk) problems.push(P(c.config.schedule, `runway: ${st.runway} scheduled day(s) remain after ${today}, fewer than ${c.config.runwayDays} (approve and verify more concepts, then kit concepts schedule --write)`));
  }
  return { ok: !problems.length, problems, status: st, summary: `${c.config.kind} series ${c.config.series.id}: ${st.concepts} concepts (${st.verified} verified, ${st.unverified} unverified), ${st.scheduled} scheduled, ${st.published} publishable, ${st.held.length} held` };
}

/**
 * kit check shariah-review: the deploy gate of a Shariah-sensitive series. Everything kit check concepts verifies (with the ledger's git history and the
 * witness), and every SCHEDULED concept is currently approved at its approval hash (an edit after approval holds it, and the deploy waits).
 */
export async function checkShariahReview(root, kit, { file = CONCEPTS_FILE, witness = null, verifier = null, local = false } = {}) {
  const c = await loadConcepts(root, kit, { file });
  if (!c.config) return { ok: false, problems: c.problems, summary: file };
  if (c.config.gate.review.mode !== "shariah-ledger") return { ok: true, problems: [], summary: `${c.config.series.id}: not a Shariah series (the kit registry says ${c.project}'s is general)` };
  const base = await checkConceptsRepo(root, kit, { file, history: true, witness, verifier, local });
  const problems = [...base.problems];
  if (c.catalogue && c.approvals) {
    for (const e of c.schedule.entries) {
      const k = c.catalogue.concepts.find((x) => x.id === e.id);
      if (!k) continue;
      const { state } = reviewState(k, c.approvals, approvalHash(c.config, c.catalogue, k));
      if (state !== "approved") problems.push(P(c.config.schedule, `scheduled but not approved: ${e.id} (${e.date}): ${state}. A roster member signs the current text (the signing page, or kit shariah approve --by "<name>" --key <your key> <id>) or the text is reverted; nothing unapproved publishes`));
    }
  }
  const t = c.catalogue && c.approvals ? c.catalogue.concepts.map((k) => reviewState(k, c.approvals, approvalHash(c.config, c.catalogue, k)).state) : [];
  const n = (s) => t.filter((x) => x === s).length;
  return { ok: !problems.length, problems, summary: `${t.length} concepts: ${n("approved")} approved, ${n("unreviewed")} unreviewed, ${n("changed")} changed since approval; ${c.schedule.entries.length} scheduled; ${(c.approvals?.roster || []).length} member(s) in the roster` };
}

/** Every concept's review state with its approval hash: what a reviewer sees in kit shariah review. */
export function reviewTable(c) {
  return c.catalogue.concepts.map((k) => {
    const hash = approvalHash(c.config, c.catalogue, k), { state, entry } = reviewState(k, c.approvals, hash);
    const sched = c.schedule.entries.find((e) => e.id === k.id);
    return { id: k.id, state, hash, entry, scheduled: sched?.date ?? null, contested: Boolean(k.contested), verified: k.accuracy.status === "verified" };
  });
}

export { LEDGER_SCHEMA_URL };
