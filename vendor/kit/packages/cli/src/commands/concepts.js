/**
 * kit concepts — a concept series' catalogue, schedule and sizes (docs/CONCEPTS.md).
 *
 *   kit concepts status --today YYYY-MM-DD [--json]     counts, the held concepts and why, what waits, the runway
 *   kit concepts schedule --today YYYY-MM-DD [--from d] [--allow-gap "<reason>"] [--write]
 *                                                        APPEND the next eligible concepts (verified; approved when the series has a
 *                                                        ledger; prerequisites first). A dry run prints them; --write saves the schedule.
 *                                                        Never reorders or removes an entry, so no day changes meaning.
 *   kit concepts script <id>                              the composed two-host script, the written page and the spoken size
 *   kit concepts verify                                   re-check every recorded quote against the extracted text of its document
 *                                                        (verify.texts/<document sha256>.txt); read-only (the same proof kit check concepts runs)
 *
 * The checks are `kit check concepts [--history] [--runway]` and, for a Shariah series, `kit check shariah-review`.
 * The file is concepts.config.json (--concepts <file>).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../args.js";
import { kitFor } from "../bundled.js";
import { loadConcepts, CONCEPTS_FILE, sourceProofProblems } from "../concepts.js";
import { planSchedule, conceptStatus, composeTalk, conceptArticle, sizeOf, approvalHash } from "@saasreport/core/concepts";

export async function concepts(io, { _: [sub = "status", ...rest], flags }) {
  const kit = kitFor(io);
  const c = await loadConcepts(io.cwd, kit, { file: flags.concepts ? String(flags.concepts) : CONCEPTS_FILE });
  if (!c.config || c.problems.length) throw new CliError(c.problems.map((p) => `${p.file}: ${p.problem}`).join("; ") || "no concepts.config.json");
  const today = flags.today ? String(flags.today) : null;
  if (["status", "schedule"].includes(sub) && !/^\d{4}-\d{2}-\d{2}$/.test(today || "")) throw new CliError(`kit concepts ${sub} --today YYYY-MM-DD is required: the tools never read the clock, so the same inputs always give the same schedule`);
  if (sub === "status") {
    const st = conceptStatus({ catalogue: c.catalogue, config: c.config, schedule: c.schedule, approvals: c.approvals, today });
    if (flags.json) { io.out(JSON.stringify(st, null, 2)); return 0; }
    io.out(`${c.config.series.id}: ${st.concepts} concepts, ${st.verified} verified, ${st.unverified} unverified; ${st.scheduled} scheduled${st.last ? ` until ${st.last}` : ""}, ${st.published} publishable now, ${st.held.length} held; ${st.ready} ready to schedule; runway ${st.runway} day(s) (minimum ${c.config.runwayDays})`);
    if (c.config.kind === "shariah") io.out(`review (${c.expect.ledger}): ${st.review.approved} approved, ${st.review.unreviewed} unreviewed, ${st.review.changed} changed since approval, ${st.review.other} other; ${(c.approvals?.roster || []).length} roster member(s)`);
    for (const h of st.held) io.out(`  held ${h.date} ${h.id}: ${h.reasons.join("; ")}`);
    for (const w of st.waiting.slice(0, 20)) io.out(`  waiting ${w.id}: ${w.reasons.join("; ")}`);
    if (st.waiting.length > 20) io.out(`  … and ${st.waiting.length - 20} more waiting`);
    return 0;
  }
  if (sub === "schedule") {
    const r = planSchedule({ catalogue: c.catalogue, config: c.config, approvals: c.approvals, schedule: c.schedule, from: flags.from ? String(flags.from) : null, allowGap: flags["allow-gap"] ? String(flags["allow-gap"]) : null, today });
    if (r.problems.length) { for (const p of r.problems) io.err(`  - ${p}`); return 1; }
    for (const a of r.added) io.out(`${a.date}  #${a.order}  ${a.id}`);
    io.out(`${r.added.length} concept(s) ${flags.write ? "appended to" : "would be appended to"} ${c.config.schedule}; ${r.waiting.length} waiting (approval, verification or prerequisites)`);
    if (flags.write && r.added.length) writeFileSync(join(io.cwd, c.config.schedule), `${JSON.stringify(r.schedule, null, 2)}\n`);
    else if (!flags.write && r.added.length) io.out("(--write saves it)");
    return 0;
  }
  if (sub === "script") {
    const k = c.catalogue.concepts.find((x) => x.id === rest[0]);
    if (!k) throw new CliError(`kit concepts script <id>: unknown concept "${rest[0] ?? ""}"`);
    const talk = composeTalk(c.config, k), unit = c.config.format.unit;
    for (const [s, t] of talk) io.out(`${s}: ${t}`);
    io.out(`\n${sizeOf(talk.map((l) => l[1]), unit)} ${unit} in the talk (limit ${c.config.format.body.min}-${c.config.format.body.max}); approval hash ${approvalHash(c.config, c.catalogue, k)}`);
    io.out(`\n${conceptArticle(c.config, c.catalogue, k)}`);
    return 0;
  }
  if (sub === "verify") {
    const bad = sourceProofProblems(io.cwd, c.config, c.catalogue);
    for (const p of bad) io.err(`  - ${p.problem}`);
    const n = c.catalogue.concepts.filter((k) => k.accuracy.status === "verified").reduce((a, k) => a + k.sources.length, 0);
    io.out(`${n - bad.length}/${n} sources of verified concepts proven against their document text (${c.config.verify.texts})`);
    return bad.length ? 1 : 0;
  }
  throw new CliError(`kit concepts ${sub}: one of status, schedule, script, verify`);
}
