/**
 * kit migrations sync [--check]
 *   A Worker that runs a vendored kit engine (comms, monitor, the site runtime, uploads, broker) must apply that package's migrations. This
 *   appends every one a D1 binding of the Worker does not apply, byte for byte, as the next numbered file (<n>_<package>_<name>.sql) of the
 *   directory of the Worker's first D1 binding; it never edits or renames a file (docs/PODCASTS.md, finding class engine-migrations-present).
 *   --check writes nothing and exits 1 when something is missing (what `kit check migrations` reports).
 */
import { CliError } from "../args.js";
import { loadCanon } from "../canon/index.js";
import { syncEngineMigrations } from "../engine-migrations.js";

export async function migrations(io, { _: [sub] = [], flags }) {
  if (sub !== "sync") throw new CliError(`kit migrations: unknown subcommand "${sub}" (sync)`);
  const { canon } = loadCanon(io.cwd);
  const r = syncEngineMigrations(io.cwd, canon || {}, { write: !flags.check });
  for (const m of r.missing) io.out(`${flags.check ? "missing" : "needs"} ${m.source} (${m.package}, Worker ${m.config})`);
  if (flags.check) { io[r.missing.length ? "err" : "out"](r.missing.length ? `kit migrations sync --check: ${r.missing.length} engine migration(s) not applied by any binding` : "ok: every engine migration is applied"); return r.missing.length ? 1 : 0; }
  for (const f of r.written) io.out(`wrote ${f}`);
  io.out(r.written.length ? "apply them with npm run db:migrate:remote before deploying" : "up to date: nothing to add");
  return 0;
}
