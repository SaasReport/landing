/**
 * kit plan [--from YYYY-MM-DD] [--days 371] [--out agenda.md] [--json] [--locale ar]
 * A dry run of everything the daily cron publishes (core `agenda`), with every episode script built exactly as the
 * Worker builds it. Writes the agenda as Markdown (`--out -` prints it) and exits 1 when anything is missing or broken.
 * `--json` prints { stats, problems, items: [{ series, kind, date, slug, number, title, post, episode }] } to stdout.
 * A multi-locale site plans every locale (one agenda section each, items tagged with their locale); --locale plans one.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { agenda, buildPost } from "@saasreport/core";
import { CliError } from "../args.js";
import { loadProject, runtime, projectFor } from "../project.js";

export async function plan(io, { flags }) {
  const project = await loadProject(io.cwd, flags);
  const days = flags.days == null ? 371 : Number(flags.days);
  if (!Number.isInteger(days) || days < 1 || days > 3700) throw new CliError(`--days must be a whole number of days (got ${flags.days})`);
  if (flags.from != null && !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(String(flags.from))) throw new CliError(`--from must be a date, e.g. 2026-09-30 (got ${flags.from})`);
  // A multi-locale site: every locale (--locale ar: one), each episode built by that locale's runtime.
  const one = flags.locale != null ? projectFor(project, flags.locale) : project;
  const rts = new Map();
  const rtOf = (l) => { if (!rts.has(l ?? "")) rts.set(l ?? "", runtime(l ? projectFor(project, l) : one)); return rts.get(l ?? ""); };
  const rt = rtOf(one.locale);
  const r = agenda(one.config, one.content, { from: flags.from, days, episode: (s, e, l) => rtOf(l ?? one.locale).episode(s, e)?.lines || null });

  const out = flags.out == null ? "agenda.md" : String(flags.out);
  if (out === "-") io.out(r.markdown);
  else if (out !== "false") {
    const p = resolve(io.cwd, out);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, r.markdown);
  }

  if (flags.json) {
    const items = r.items.map((x) => {
      const lrt = x.locale ? rtOf(x.locale) : rt;
      const ep = lrt.episode(x.series, x);
      const s = lrt.plan.config.series.find((y) => y.id === x.series);
      const post = s?.post ? buildPost(lrt.plan, x) : null;
      return {
        ...(x.locale ? { locale: x.locale } : {}), series: x.series, kind: x.kind, date: x.date, key: x.key, slug: x.slug, number: x.number ?? null, title: x.title, publishAt: x.publishAt,
        post: post ? { slug: post.slug, kind: post.kind, title: post.title, summary: post.summary, body_md: post.body_md, tags: post.tags, published_at: post.published_at } : null,
        episode: ep ? { slug: ep.slug, title: ep.title, summary: ep.summary, lines: ep.lines, ms: x.ms } : null,
      };
    });
    io.out(JSON.stringify({ stats: r.stats, problems: r.problems, items }, null, 1));
  } else {
    const parts = r.locales ? Object.entries(r.stats).map(([l, st]) => [`${projectFor(project, l).config.site.name} [${l}]`, st]) : [[one.config.site.name, r.stats]];
    for (const [tag, s] of parts) {
      io.out(`${tag}: from ${s.from} for ${s.days} days, ${s.total} items, ${s.episodes} episodes`);
      for (const [id, x] of Object.entries(s.series)) {
        const secs = x.episodes ? `, about ${x.seconds.min}-${x.seconds.max} s (avg ${x.seconds.avg} s)` : "";
        io.out(`  ${id} (${x.kind}, every ${x.every}): ${x.items} items, ${x.posts} posts, ${x.episodes} episodes${secs}${x.missing ? `, ${x.missing} gaps` : ""}`);
      }
    }
    if (out !== "-" && out !== "false") io.out(`agenda written to ${isAbsolute(out) ? out : relative(io.cwd, resolve(io.cwd, out))}`);
  }
  if (r.problems.length) {
    io.err(`${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}:`);
    for (const p of r.problems.slice(0, 50)) io.err(`  - ${p}`);
    if (r.problems.length > 50) io.err(`  … and ${r.problems.length - 50} more (see the agenda)`);
    return 1;
  }
  return 0;
}
