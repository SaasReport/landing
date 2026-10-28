/**
 * kit init [dir] [--locale en|fa] [--locales en,ar] [--name my-site] [--force] [--link]
 * Copies templates/site (English LTR; `--locale fa` overlays templates/site/locales/fa: Persian RTL Jalali;
 * `--locales en,ar` overlays templates/site/locales/en-ar: English at / and Arabic at /ar/, content keyed per locale),
 * names the Worker, D1 database and R2 bucket after the directory, and writes the client assets into the
 * static assets directory (`public/kit/` via @saasreport/cloudflare/assets-manifest writeAssets).
 * Writes the Claude Code cost standard (.claude/settings.json cost keys, standard agents; `kit claude sync`, docs/COST.md).
 * `--link` symlinks node_modules/@saasreport/* to the packages next to this CLI and node_modules/.bin/kit to this CLI
 * (developing kit itself, offline tests).
 */
import { cp, mkdir, readdir, readFile, writeFile, symlink, rm, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve, relative } from "node:path";
import { writeAssets } from "@saasreport/cloudflare/assets-manifest";
import { slugify } from "@saasreport/core";
import { CliError } from "../args.js";
import { templateDir, kitPackages } from "../paths.js";
import { readWrangler } from "../project.js";
import { bundled } from "../canon/index.js";
import { loadPolicy, syncClaude } from "../claude.js";

export const LOCALES = ["en", "fa"];
/** Bilingual starters: --locales <a>,<b> (the first is the default, served at /). */
export const LOCALE_SETS = { "en,ar": "en-ar", "ar,en": "en-ar" };
const SKIP = new Set(["locales", "node_modules", ".wrangler", "agenda.md"]);

export async function init(io, { _: [target = "."], flags }) {
  const set = flags.locales == null ? null : String(flags.locales).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).join(",");
  if (set != null && set.split(",").length === 1) flags = { ...flags, locale: set };      // one locale is a single-locale site
  const multi = set != null && set.split(",").length > 1 ? set : null;
  if (multi && !LOCALE_SETS[multi]) throw new CliError(`--locales must be one of ${Object.keys(LOCALE_SETS).join(" | ")} (got "${flags.locales}")`);
  if (multi && flags.locale != null) throw new CliError("use either --locale or --locales");
  const locale = multi ? multi.split(",")[0] : String(flags.locale || "en");
  if (!multi && !LOCALES.includes(locale)) throw new CliError(`--locale must be one of ${LOCALES.join(", ")} (got "${locale}")`);
  const dir = resolve(io.cwd, target);
  if (existsSync(dir) && (await readdir(dir)).filter((f) => !f.startsWith(".")).length && !flags.force)
    throw new CliError(`${dir} is not empty (use --force to write into it anyway)`);
  const name = slugify(String(flags.name || basename(dir))) || "my-site";
  const tpl = templateDir();

  await mkdir(dir, { recursive: true });
  await cp(tpl, dir, { recursive: true, force: true, filter: (src) => !SKIP.has(relative(tpl, src).split(/[\\/]/)[0]) });
  if (multi) {
    await cp(join(tpl, "locales", LOCALE_SETS[multi]), dir, { recursive: true, force: true });
    if (multi === "ar,en") {                                                       // Arabic first: the default at /
      const p = join(dir, "kit.config.js");
      await writeFile(p, (await readFile(p, "utf8")).replace('locales: ["en", "ar"],                    // en at /, ar at /ar/', 'locales: ["ar", "en"],                    // ar at /, en at /en/'));
    }
  } else if (locale !== "en") await cp(join(tpl, "locales", locale), dir, { recursive: true, force: true });

  for (const f of ["wrangler.toml", "package.json"]) {
    const p = join(dir, f);
    if (existsSync(p)) await writeFile(p, (await readFile(p, "utf8")).replaceAll("my-site", name));
  }
  const cost = loadPolicy(dir, bundled()); // the Claude Code cost standard from t=0 (docs/COST.md)
  if (cost.policy) syncClaude(dir, cost.policy);
  const assetsDir = String(readWrangler(dir).assets?.directory || "./public");
  const written = await writeAssets(join(dir, assetsDir, "kit"));

  if (flags.link) {
    for (const p of kitPackages()) {
      const at = join(dir, "node_modules", p.name);
      await mkdir(join(at, ".."), { recursive: true });
      if (await lstat(at).catch(() => null)) await rm(at, { recursive: true, force: true });   // nothing there: nothing to remove
      await symlink(p.dir, at, "dir");
    }
    const bin = join(dir, "node_modules", ".bin", "kit");          // so `npx kit` finds this CLI, not a package called "kit"
    await mkdir(join(bin, ".."), { recursive: true });
    if (await lstat(bin).catch(() => null)) await rm(bin, { force: true });   // nothing there: nothing to remove
    await symlink(join("..", "@saasreport", "cli", "bin", "kit.js"), bin);
  }

  const rel = relative(io.cwd, dir) || ".";
  const what = multi ? `${multi.split(",").map((l) => ({ en: "English", ar: "Arabic" })[l]).join(" and ")}, ${multi.split(",")[0]} at / and ${multi.split(",")[1]} at /${multi.split(",")[1]}/` : locale === "fa" ? "Persian, RTL, Jalali" : "English, LTR, Gregorian";
  io.out(`Created a kit site in ${rel} (${what}), Worker name "${name}".`);
  io.out(`Client assets: ${written.length} files in ${join(assetsDir, "kit")}/${flags.link ? "; node_modules/@saasreport/* linked to this kit checkout" : ""}.`);
  io.out("");
  io.out("Next steps:");
  if (rel !== ".") io.out(`  cd ${rel}`);
  if (!flags.link) io.out("  npm install");
  io.out("  edit kit.config.js (site, brand, hosts, shows) and content/; put the owner's GitHub handle in .github/CODEOWNERS (replace @OWNER)");
  io.out(`  npx kit check            # config + content contracts${multi ? " (every locale)" : ""}`);
  io.out("  npx kit plan             # agenda.md: everything the next year publishes");
  io.out("  npx kit migrate          # D1 tables, locally (--remote for Cloudflare)");
  io.out("  npx wrangler dev         # http://localhost:8787");
  io.out("  npx kit deploy           # after `wrangler d1 create` and the ids in wrangler.toml");
  return 0;
}
