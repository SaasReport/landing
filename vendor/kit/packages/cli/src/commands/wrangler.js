/**
 * Thin wrappers around wrangler. Both print the exact commands; `--dry-run` stops there.
 *   kit migrate [--remote] [--database <name>] [--dry-run]
 *     wrangler d1 migrations apply <database> --local|--remote   (migrations_dir comes from wrangler.toml)
 *   kit deploy [--env <name>] [--dry-run]
 *     kit check → refresh client assets (<assets dir>/kit) → wrangler deploy
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAssets } from "@saasreport/cloudflare/assets-manifest";
import { CliError } from "../args.js";
import { readWrangler } from "../project.js";
import { check } from "./check.js";
import { stageD1Migrations } from "../migration-transport.js";

/** [command, args] for wrangler: the project's own binary when installed, else npx. */
export function wranglerCmd(dir, args) {
  const local = join(dir, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  return existsSync(local)
    ? { cmd: local, args, display: `wrangler ${args.join(" ")}` }
    : { cmd: "npx", args: ["wrangler", ...args], display: `npx wrangler ${args.join(" ")}` };
}

export async function migrate(io, { flags }) {
  const w = readWrangler(io.cwd);
  if (!Object.keys(w).length) throw new CliError(`no wrangler.toml in ${io.cwd}`);
  const d1 = (w.d1_databases || []).find((d) => d.binding === "DB") || (w.d1_databases || [])[0];
  const db = String(flags.database || d1?.database_name || "");
  if (!db) throw new CliError("wrangler.toml has no [[d1_databases]] (binding DB); add one or pass --database <name>");
  const where = flags.remote ? "--remote" : "--local";
  const cmd = wranglerCmd(io.cwd, ["d1", "migrations", "apply", db, where]);
  io.out(`${flags["dry-run"] ? "dry run: " : ""}${cmd.display}${d1?.migrations_dir ? `   # migrations: ${d1.migrations_dir}` : ""}`);
  if (flags["dry-run"]) return 0;
  const binding = (w.d1_databases || []).find((d) => d.database_name === db);
  if (!binding?.database_id || !w.compatibility_date)
    throw new CliError(`database "${db}" lacks a resolved D1 ID or compatibility_date in wrangler.toml`);
  const tmp = mkdtempSync(join(tmpdir(), "kit-d1-transport-"));
  try {
    const staged = stageD1Migrations(join(io.cwd, binding.migrations_dir || "migrations"), join(tmp, "migrations"));
    const config = join(tmp, "migration.toml");
    writeFileSync(config, [
      `name = "kit-migrate-${db}"`,
      `compatibility_date = "${w.compatibility_date}"`, "",
      "[[d1_databases]]",
      `binding = "${binding.binding}"`,
      `database_name = "${db}"`,
      `database_id = "${binding.database_id}"`,
      `migrations_dir = ${JSON.stringify(staged.staged_dir.replaceAll("\\", "/"))}`,
      ...(binding.migrations_table ? [`migrations_table = ${JSON.stringify(binding.migrations_table)}`] : []), "",
    ].join("\n"));
    const run = wranglerCmd(io.cwd, ["d1", "migrations", "apply", db, where, "--config", config,
      ...(flags.remote ? [] : ["--persist-to", join(io.cwd, ".wrangler", "state")])]);
    io.out(`D1 transport: ${staged.files.length} unchanged numbered migrations, ${staged.normalised} comment-only normalization(s); immutable source preserved`);
    return await io.spawn(run.cmd, run.args, { cwd: io.cwd, env: io.env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function deploy(io, { flags }) {
  const w = readWrangler(io.cwd);
  if (!Object.keys(w).length) throw new CliError(`no wrangler.toml in ${io.cwd}`);
  const assets = join(String(w.assets?.directory || "./public"), "kit");
  const args = ["deploy", ...(flags.env ? ["--env", String(flags.env)] : [])];
  const cmd = wranglerCmd(io.cwd, args);
  const dry = Boolean(flags["dry-run"]);
  io.out(`${dry ? "dry run: " : ""}1. kit check`);
  const code = await check(io, { flags });
  if (code) { io.err("deploy stopped: fix the problems above first"); return code; }
  io.out(`${dry ? "dry run: " : ""}2. write client assets to ${assets}/`);
  if (!dry) await writeAssets(join(io.cwd, assets));
  io.out(`${dry ? "dry run: " : ""}3. ${cmd.display}${w.name ? `   # Worker "${w.name}"` : ""}`);
  if (dry) return 0;
  return io.spawn(cmd.cmd, cmd.args, { cwd: io.cwd, env: io.env });
}
