/**
 * kit check persian and kit check fa-review (docs/PERSIAN.md).
 *
 *   persian     the project's Persian sources (persian.config.json, named by kit.canon.json "persian") linted with the kit's
 *               rule pack (@saasreport/fa-lint) plus the project's own packs and classes; every podcast script the cron would
 *               voice is built and linted too (spoken register). Every finding fails (no warning level). A project whose
 *               digits locale is fa must declare it.
 *   fa-review   the native-review ledger (fa-review.json): every source file's Persian text has a content hash; a file
 *               whose hash differs from its ledger entry has not been read by a native reviewer and does not deploy.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { formatProblems } from "@saasreport/core/schema";
import { KIT_RULES, persianLinter, checkExamples, segments, rewriteSegments, normalize, kindOf, safeFix, allowedFinding, projectGate } from "@saasreport/fa-lint";
import { expand, matchesAny, readText, literals, globRe, isGlob } from "./files.js";
import { verifyLedger } from "@saasreport/core/ledger";
import { readLedgerFile, ledgerHistoryProblems, witnessCheck, verifierProblems } from "../ledger-io.js";
import { scopeHash } from "@saasreport/core/scope";

const P = (file, problem) => ({ file, problem });
const readJson = (root, file) => JSON.parse(readFileSync(join(root, file), "utf8"));

/** persian.config.json, validated, with its packs compiled: { cfg, file, linter, packs, problems }. */
export function loadPersian(root, canon, kit) {
  const file = canon.persian;
  if (!file) return { cfg: null, problems: [] };
  if (!existsSync(join(root, file))) return { cfg: null, file, problems: [P(file, "declared in kit.canon.json \"persian\" but missing")] };
  let cfg;
  try { cfg = readJson(root, file); } catch (e) { return { cfg: null, file, problems: [P(file, `not JSON: ${e.message}`)] }; }
  const problems = formatProblems(kit.validator.validate(cfg, kit.byName("persian-config"))).map((m) => P(file, `persian-config: ${m}`));
  const packs = [];
  for (const p of cfg.rules || []) {
    if (!existsSync(join(root, p))) { problems.push(P(p, "rule pack declared in persian.config.json but missing")); continue; }
    let pack;
    try { pack = readJson(root, p); } catch (e) { problems.push(P(p, `not JSON: ${e.message}`)); continue; }
    for (const m of formatProblems(kit.validator.validate(pack, kit.byName("fa-rules")))) problems.push(P(p, `fa-rules: ${m}`));
    packs.push({ file: p, pack });
  }
  let linter = null;
  try {
    linter = persianLinter({ packs: packs.map((x) => x.pack), classes: cfg.classes || {} });
    // a project's packs prove themselves like the kit's: every example, with the project's classes
    for (const x of packs) for (const m of checkExamples([KIT_RULES, x.pack], cfg.classes || {}).filter((s) => x.pack.rules.some((r) => s.startsWith(`${r.id}:`)))) problems.push(P(x.file, m));
  } catch (e) { problems.push(P(file, `rule packs do not compile: ${e.message}`)); }
  return { cfg, file, linter, packs, problems };
}

/** The source files of persian.config.json: [{ file, register, area, skipKeys }] (excluded files dropped). */
export function sourceFiles(root, cfg) {
  const excl = (cfg.exclude || []).filter((e) => !e.keys).map((e) => e.files);
  const keyed = (cfg.exclude || []).filter((e) => e.keys);
  const seen = new Map();
  for (const s of cfg.sources) for (const f of expand(root, s.files)) {
    if (matchesAny(f, excl) || seen.has(f)) continue;
    const skipKeys = new Set(keyed.filter((e) => matchesAny(f, [e.files])).flatMap((e) => e.keys));
    seen.set(f, { file: f, register: s.register || "written", area: s.name || s.files[0], skipKeys, arabic: s.mixed ? "skip-broad" : "skip" });
  }
  return [...seen.values()];
}

/** Segments of one file (Persian only), minus those under a skipped key (verbatim quotations, code samples). */
export function fileSegments(root, file, skipKeys = new Set()) {
  const src = readText(root, file);
  return { src, segs: segments(file, src, { literals }).filter((x) => !(x.key && skipKeys.has(x.key))) };
}


/** Lint every source file (and podcast scripts when declared): { findings, files, segments, used: Set(allow entries) }. */
export async function lintSources(root, cfg, linter, { podcast = true } = {}) {
  const findings = [], used = new Set();
  let nsegs = 0;
  const files = sourceFiles(root, cfg);
  const add = (f) => { const a = allowedFinding(cfg.allow, f); if (a) { used.add(a); return; } findings.push(f); };
  for (const { file, register, area, skipKeys, arabic } of files) {
    if (!kindOf(file)) { findings.push({ file, line: 0, rule: "fa-source-kind", severity: "error", match: "", suggestion: "", context: "unsupported file kind (json, js, md, html, txt)", area }); continue; }
    const { segs } = fileSegments(root, file, skipKeys);
    nsegs += segs.length;
    for (const s of segs) for (const f of linter.lint(s.text, { register, arabic })) add({ ...f, file, area, line: s.line + f.line });
  }
  let scripts = 0;
  if (podcast && cfg.podcast) {
    // the same gate the Worker runs before TTS (projectGate): same linter, same allow-list
    const gate = projectGate({ config: cfg, linter });
    const r = await podcastScripts(root, cfg.podcast);
    scripts = r.episodes;
    for (const e of r.items) {
      const g = gate(e.lines, { file: `podcast:${e.slug}` });
      for (const a of g.allowed) used.add(a);
      for (const f of g.findings) findings.push({ ...f, area: "podcast scripts" });
    }
  }
  return { findings, files: files.length, segments: nsegs, scripts, used };
}

/** Every episode script the cron would voice in the window, built as the Worker builds it: { episodes, items: [{ slug, lines }] }. */
export async function podcastScripts(root, opts = {}) {
  const { loadProject, runtime } = await import("../project.js");
  const { agenda } = await import("@saasreport/core");
  const project = await loadProject(root, { config: opts.config || "kit.config.js", ...(opts.content ? { content: opts.content } : {}) });
  const rt = runtime(project);
  const items = [];
  agenda(project.config, project.content, {
    from: opts.from, days: opts.days || 371,
    episode: (s, e) => { const ep = rt.episode(s, e); if (ep?.lines?.length) items.push({ slug: ep.slug, lines: ep.lines }); return ep?.lines || null; },
  });
  return { episodes: items.length, items };
}

/** The check behind `kit check persian` (and the persian step of kit check canon). */
export async function checkPersian(root, canon, kit) {
  const { cfg, linter, problems } = loadPersian(root, canon, kit);
  if (!canon.persian) {
    if (canon.digits?.locale === "fa") return { ok: false, configured: false, checked: 0, summary: "missing", problems: [P("kit.canon.json", "a Persian project (digits.locale fa) declares \"persian\": its persian.config.json (docs/PERSIAN.md)")] };
    return { ok: false, configured: false, checked: 0, summary: "NOT CONFIGURED", problems: [] };
  }
  if (!cfg || !linter) return { ok: false, configured: true, checked: 0, summary: canon.persian, problems };
  const r = await lintSources(root, cfg, linter);
  const errors = r.findings;
  // t=0: no warning level. A finding of any severity (a project pack still carrying `warning`) fails like an error.
  for (const f of r.findings) problems.push(P(`${f.file}:${f.line}`, `${f.rule}: «${f.match}» → «${f.suggestion}» in “${f.context}”`));
  for (const e of cfg.exclude || []) if (!expand(root, [e.files]).length) problems.push(P(canon.persian, `stale exclude (matches no file; remove it): ${e.files}`));
  for (const a of cfg.allow || []) if (!r.used.has(a)) problems.push(P(canon.persian, `stale allow entry (matches nothing; remove it): ${a.file} ${a.rule} «${a.match}» (${a.context})`));
  const rules = linter.rules.filter((x) => !x.inactive).length;
  return {
    ok: !problems.length, configured: true, checked: r.files,
    summary: `${r.files} file${r.files === 1 ? "" : "s"}, ${r.segments} Persian segments${cfg.podcast ? `, ${r.scripts} podcast scripts` : ""}; ${rules} rules; ${errors.length} finding${errors.length === 1 ? "" : "s"}`,
    problems, findings: [], errors,
  };
}

/**
 * sha256 of a file's Persian copy: the raw source text of each Persian segment, in order. Not the extracted or normalized
 * text, so it does not move when the linter's extractor or normalizer improves; it changes only when the copy itself (or its
 * markup inside a segment) is edited, which is exactly what a native reader has to read again.
 */
export function persianHash(src, segs) {
  const h = createHash("sha256");
  for (const s of segs) h.update(`${src.slice(s.start, s.end)}\u241e`);
  return h.digest("hex");
}

/** Review state of every source file: [{ file, sha256, segments, entry, state: approved|baseline|changed|new|empty|invalid }]. `approvals` is the VERIFIED ledger (await verifyLedger): one that does not verify approves nothing. */
/** The files a baseline covers: copy with no review state yet (the one definition: `kit persian baseline`, `kit persian migrate` and `kit trust propose` all use it, so the owner pins exactly what baseline would create). */
export const baselineCandidates = (states) => states.filter((x) => x.state === "new" || x.state === "invalid");

export function reviewState(root, cfg, approvals) {
  return sourceFiles(root, cfg).filter((x) => kindOf(x.file)).map(({ file, skipKeys }) => {
    const { src, segs } = fileSegments(root, file, skipKeys);
    const sha256 = persianHash(src, segs);
    const st = approvals?.subjects?.get(file) || null;
    const state = !segs.length ? "empty" : !approvals?.ok ? "invalid" : !st ? "new" : st.sha256 !== sha256 ? "changed" : st.status === "approved" || st.status === "baseline" ? st.status : "changed";
    return { file, sha256, segments: segs.length, entry: st?.entry ?? null, state };
  });
}

/** The owner-signed expectation for this project's Persian ledger, or a problem when there is none. */
export async function persianExpect(kit, canon) {
  const ap = await kit.approvals(canon.project);
  if (!ap.known) return { expect: null, problems: ap.problems.map((m) => P(canon.persian || "persian.config.json", `trust record: ${m}`)) };
  return ap.persian ? { expect: ap.persian, problems: [] } : { expect: null, problems: [P(canon.persian || "persian.config.json", `the owner-signed trust record for project "${canon.project}" records no persian approval ledger: native review needs the owner's signature on the ledger and roster (kit trust)`)] };
}

/** fa-review.json read and schema-validated: { file, ledger, missing, problems }. */
export function readLedger(root, expect, kit) {
  const r = readLedgerFile(root, expect.ledger, kit);
  return { file: expect.ledger, ledger: r.ledger, missing: r.missing, problems: r.problems };
}

/** The ledger verified against the registry: chain, roster evolution, every signature. */
export async function verifyPersian(ledger, expect) {
  return ledger ? verifyLedger(ledger, { expect, bootstrap: expect.bootstrap }) : { ok: false, problems: ["the ledger does not exist"], subjects: new Map(), roster: expect.bootstrap, head: null };
}

/** CODEOWNERS (root, .github/ or docs/) covers the ledger: the file a reviewer owns cannot change without their review. */
export function codeownersCover(root, ledgerFile) {
  for (const f of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    if (!existsSync(join(root, f))) continue;
    for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
      const [pat, ...owners] = line.replace(/#.*/, "").trim().split(/\s+/);
      if (!pat || !owners.length) continue;
      const p = pat.replace(/^\//, "");
      if (p === "*" || (p.endsWith("/") && ledgerFile.startsWith(p)) || p === ledgerFile || (isGlob(p) && globRe(p).test(ledgerFile))) return { file: f, owners };
    }
  }
  return null;
}

/** The deploy gate: the ledger verifies (identity from the registry, chain, signatures, git history, witness) and every Persian source is approved (or baseline) at its current hash. */
/** The Persian review scope (sources incl. mixed, and exclude) is the OWNER's: persian.config.json is agent-editable, so the owner-signed record pins its hash and any other scope is refused. */
export function scopeProblems(cfg, expect, file = "persian.config.json") {
  if (!expect.scope) return [P(file, "the owner-signed trust record pins no Persian scope (approvals.persian.scope): persian.config.json is an editable file, so which text needs the owner's signature must be pinned by the owner (kit trust propose computes it)")];
  if (scopeHash(cfg, file) !== expect.scope.sha256) return [P(file, `${file}'s review scope (the config file named in kit.canon.json, its sources, exclude, mixed) differs from the one the owner signed (${scopeHash(cfg, file).slice(0, 12)} here, ${expect.scope.sha256.slice(0, 12)} signed): an exclude or a changed source is a change of what needs the owner's signature, so the owner signs the new scope`)];
  return [];
}

/** local: the checks that need only the repository (the verifier runs these on ITS copy; it witnesses and signs itself, so the witness and verifier layers are skipped). */
export async function checkReview(root, canon, kit, { witness = null, verifier = null, local = false } = {}) {
  const { cfg, problems } = loadPersian(root, canon, kit);
  if (!canon.persian) {
    // "not configured" is the OWNER's to say: kit.canon.json is agent-editable, so dropping "persian" from it must not switch the gate off while the owner-signed record names a Persian ledger
    // (or while a record exists that does not verify, so it cannot be told what it names)
    const ap = await kit.approvals(canon.project), has = (kit.trust?.records || []).some((r) => r?.project === canon.project);
    if (ap.persian) return { ok: false, summary: "persian config dropped", problems: [P("kit.canon.json", `the owner-signed trust record for "${canon.project}" names a Persian approval ledger (${ap.persian.ledger}), but kit.canon.json no longer declares "persian": the gate cannot be switched off from the repository (restore it, or the owner signs a record without the Persian ledger)`)] };
    if (has && !ap.known) return { ok: false, summary: "no verified record", problems: [P("kit.canon.json", `kit.canon.json declares no "persian", but the trust record for "${canon.project}" does not verify, so it cannot be known that the owner names none: ${ap.problems.join("; ")}`)] };
    return { ok: !problems.length, summary: "not configured", problems };
  }
  if (!cfg) return { ok: false, summary: "persian.config.json missing", problems: problems.length ? problems : [P(canon.persian, "missing")] };
  if (!cfg.review) return { ok: false, summary: "no review gate", problems: [P(canon.persian, "persian.config.json has no \"review\": Persian copy cannot deploy without native review")] };
  const pe = await persianExpect(kit, canon);
  if (!pe.expect) return { ok: false, summary: "no registered ledger", problems: [...problems, ...pe.problems] };
  problems.push(...scopeProblems(cfg, pe.expect, canon.persian));
  const { file, ledger, missing, problems: lp } = readLedger(root, pe.expect, kit);
  problems.push(...lp);
  if (missing) problems.push(P(file, "missing: create it once with `kit persian baseline` (or `kit persian migrate` for the old format): copy live before the gate, unsigned, anchored at a commit; later approvals are signed by the reader"));
  if (!ledger) return { ok: false, summary: file, problems };
  if (!codeownersCover(root, file)) problems.push(P(file, `not covered by CODEOWNERS: add "/${file} @<reviewer>" so approvals cannot change without the native reviewer's review`));
  if (ledger.id === undefined || ledger.anchor === undefined) { problems.push(P(file, "the old fa-review format: run `kit persian migrate` (it converts it in place, anchored at the migration commit)")); return { ok: false, summary: file, problems }; }
  const v = await verifyPersian(ledger, pe.expect);
  for (const m of v.problems) problems.push(P(file, m));
  problems.push(...ledgerHistoryProblems(root, file, ledger, { migration: pe.expect.migration, anchor: pe.expect.anchor }));
  if (v.ok && !local) { problems.push(...await witnessCheck(root, witness, ledger, pe.expect)); problems.push(...await verifierProblems(verifier, canon.project, "persian", ledger, pe.expect, { root, kit })); }   // a verdict never replaces the witness
  const states = reviewState(root, cfg, v);
  const pending = states.filter((s) => s.state === "changed" || s.state === "new");
  for (const s of pending) {
    const was = s.entry ? `${s.entry.status === "approved" ? `approved by ${s.entry.by}` : "baseline"} on ${s.entry.at.slice(0, 10)} (${s.entry.sha256.slice(0, 12)})` : "never reviewed";
    problems.push(P(s.file, `Persian copy changed since its last review: ${was}, now ${s.sha256.slice(0, 12)}. A native reader (${v.roster.map((r) => r.name).join(", ") || "no roster yet"}) reads it and signs: kit persian approve --by "<name>" --key <your key> ${s.file}`));
  }
  const n = (st) => states.filter((s) => s.state === st).length;
  return { ok: !problems.length, summary: `${states.length} files: ${n("approved")} approved, ${n("baseline")} baseline, ${pending.length} awaiting native review`, problems, pending };
}

const jsonShape = (src) => { try { return JSON.stringify(JSON.parse(src), (k, v) => (typeof v === "string" ? "" : v)); } catch { return null; /* not JSON: the file has no JSON shape to compare */ } };

/** Apply every autofix rule to the source files (optionally only some rules): [{ file, line, before, after, rules }]. */
export function fixSources(root, cfg, linter, { write = false, files = null } = {}) {
  const changes = [];
  for (const { file, register, skipKeys, arabic } of sourceFiles(root, cfg)) {
    if (files && !files.includes(file)) continue;
    if (!kindOf(file)) continue;
    const { src, segs } = fileSegments(root, file, skipKeys);
    const next = rewriteSegments(src, segs, (raw, s) => {
      const r = safeFix(raw, linter, { register, arabic });
      if (r.refused) { changes.push({ file, line: s.line, before: raw, after: raw, rules: [], refused: r.refused }); return raw; }
      if (r.changed) {
        const rules = [...new Set(linter.lint(raw, { register, arabic }).filter((f) => f.autofix).map((f) => f.rule))];
        changes.push({ file, line: s.line, before: raw, after: r.text, rules });
      }
      return r.text;
    });
    // the file as a whole must still parse the same way: JSON stays JSON with the same keys, JS keeps the same literals
    const sameShape = kindOf(file) === "json" ? jsonShape(src) === jsonShape(next) : kindOf(file) === "js" ? literals(src).length === literals(next).length : true;
    if (!sameShape) { changes.push({ file, line: 0, before: "", after: "", rules: [], refused: "the file would no longer parse the same way; nothing written" }); continue; }
    if (write && next !== src) writeFileSync(join(root, file), next);
  }
  return changes;
}


export { allowedFinding };
