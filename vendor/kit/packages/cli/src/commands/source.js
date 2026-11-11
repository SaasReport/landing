/**
 * kit source init [--path .kit] [--transport archive|git] [--repository url] [--head url]   turn this repository to source mode (the kit at t=0, docs/FRESHNESS.md): writes scripts/kit.mjs
 *                         (the bootstrap, from templates/site/scripts/kit.mjs), the ignore rule and kit.canon.json vendor { mode: "source" }
 * kit source sync                   what the bootstrap does: fetch the kit to its head, verify it against the published head, install, link
 * kit source check                  verify what is there, no fetch: the t=0 gate (also kit check canon › vendor in source mode)
 * kit source record [--out f]       print (or write) the record of the last ensure (kit.kit-source.v1)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "../args.js";
import { loadCanon } from "../canon/index.js";
import { RECORD } from "../source-bootstrap.mjs";
import { SourceError, ensure, initSource, siteProblems, sourceConfig, verify } from "../source.js";

function configOf(io) {
  const { canon, problems } = loadCanon(io.cwd);
  if (!canon) throw new CliError(problems.map((p) => p.problem).join("; "), 1);
  try { return { canon, cfg: sourceConfig(canon) }; } catch (e) { if (e instanceof SourceError) throw new CliError(e.message, 1); throw e; }
}

export async function source(io, { _: [sub] = [], flags }) {
  if (sub === "init") {
    let r;
    try { r = initSource(io.cwd, { path: flags.path ? String(flags.path) : undefined, repository: flags.repository ? String(flags.repository) : undefined, transport: flags.transport ? String(flags.transport) : undefined, head: flags.head ? String(flags.head) : undefined }); } catch (e) { if (e instanceof SourceError) throw new CliError(e.message, 1); throw e; }
    io.out(r.written.length ? `kit source init: wrote ${r.written.join(", ")}` : "kit source init: nothing to write, the repository is in source mode");
    for (const n of r.next) io.out(`next: ${n}`);
    io.out("then: node scripts/kit.mjs (the first ensure: the checkout, the verification, the kit's dependencies, the links)");
    return 0;
  }
  if (sub === "sync" || sub === "check") {
    const { canon, cfg } = configOf(io);
    let record;
    try { record = sub === "sync" ? await ensure(io.cwd, cfg, { fetch: io.fetch, log: (m) => io.err(`kit: ${m}`) }) : await verify(io.cwd, cfg, { fetch: io.fetch }); }
    catch (e) { if (e instanceof SourceError) throw new CliError(e.message, 1); throw e; }
    const problems = siteProblems(io.cwd, canon.vendor);
    for (const p of problems) io.err(`  - ${p.file}: ${p.problem}`);
    if (problems.length) throw new CliError(`kit source ${sub}: the kit is at its head ${record.sha.slice(0, 12)}, but this repository is not in order (${problems.length} problem${problems.length === 1 ? "" : "s"})`, 1);
    io.out(`kit at head ${record.sha.slice(0, 12)} (${record.date}), verified against ${record.published.url}${sub === "sync" ? `; dependencies ${record.installed ? "installed" : "not installed"}, links ${record.linked?.length ? record.linked.join(", ") : "in place"}` : ""}`);
    return 0;
  }
  if (sub === "record") {
    const { cfg } = configOf(io);
    const f = join(io.cwd, cfg.path, RECORD);
    if (!existsSync(f)) throw new CliError(`no record at ${cfg.path}/${RECORD}: run node scripts/kit.mjs (or kit source sync) first`, 1);
    const text = readFileSync(f, "utf8");
    if (flags.out) writeFileSync(resolve(io.cwd, String(flags.out)), text); else io.out(text.trimEnd());
    return 0;
  }
  throw new CliError(`unknown source command "${sub ?? ""}" (init, sync, check, record)`, 2);
}
