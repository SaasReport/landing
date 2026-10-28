/**
 * kit plugin new <prefix> [--dir plugins/<prefix>] --skills a,b [--mcp name=url | --api url] [--name "Display"] [--force]
 *   scaffolds a Claude Code plugin whose skills write ./<prefix>-out/<skill>/<run-id>/ and compile-report.json.
 * kit plugin check [dir] [--prefix p] [--server name=url]…
 *   validates it (manifest, skill frontmatter, prefixed names, output folder, MCP config, runtime copy).
 */
import { bundled } from "../canon/index.js";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CliError } from "../args.js";

const pair = (v, flag) => {
  const s = String(v), i = s.indexOf("=");
  if (i < 1) throw new CliError(`--${flag} takes name=url`);
  return { name: s.slice(0, i), url: s.slice(i + 1) };
};

/** Loaded on use, so sites whose node_modules predate @saasreport/plugins keep running every other command. */
async function lib() {
  try { return await import("@saasreport/plugins"); } catch { return import("../../../plugins/src/index.js"); }
}

/** The project's display name from the registry (@saasreport/core registry/projects.json), by its short or full prefix. */
function projectName(prefix) {
  const { registry } = bundled();
  return registry.projects.find((p) => p.short === `${prefix}-` || p.prefix === `${prefix}-`)?.name;
}

export async function plugin(io, { _, flags }) {
  const { scaffoldPlugin, validatePlugin } = await lib();
  const [sub, arg] = _;
  if (sub === "new") {
    const prefix = arg;
    if (!prefix) throw new CliError("usage: kit plugin new <prefix> --skills <prefix>-a,<prefix>-b [--mcp name=url | --api url]");
    const skills = String(flags.skills || "").split(",").map((s) => s.trim()).filter(Boolean);
    let files;
    try {
      files = scaffoldPlugin({ prefix, displayName: flags.name, description: flags.description, skills,
        mcp: flags.mcp ? pair(flags.mcp, "mcp") : null, api: flags.api || null, author: flags.author || projectName(prefix) });
    } catch (e) { throw new CliError(e.message); }
    const dir = resolve(io.cwd, String(flags.dir || join("plugins", prefix)));
    if (existsSync(join(dir, ".claude-plugin", "plugin.json")) && !flags.force) throw new CliError(`${dir} already has a plugin (use --force to overwrite)`);
    for (const [rel, text] of Object.entries(files)) {
      const f = join(dir, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
      if (rel.startsWith("scripts/") && rel.endsWith(".mjs") && !rel.includes("/lib/")) chmodSync(f, 0o755);
    }
    io.out(`created ${dir} (${Object.keys(files).length} files): ${skills.join(", ")}`);
    const problems = validatePlugin(dir, { prefix });
    for (const p of problems) io.err(`  - ${p}`);
    return problems.length ? 1 : 0;
  }
  if (sub === "check") {
    const dir = resolve(io.cwd, String(arg || "."));
    const list = flags.server == null ? null : [].concat(flags.server).map((v) => pair(v, "server"));
    const problems = validatePlugin(dir, { prefix: flags.prefix, ...(list ? { servers: Object.fromEntries(list.map((s) => [s.name, s.url])) } : {}) });
    if (problems.length) { io.err(`${problems.length} problem${problems.length === 1 ? "" : "s"} in ${dir}:`); for (const p of problems) io.err(`  - ${p}`); return 1; }
    io.out(`ok: ${dir}`);
    return 0;
  }
  throw new CliError("usage: kit plugin new <prefix> … | kit plugin check [dir]");
}
