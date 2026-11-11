/**
 * kit widgets build [--spec widgets.spec.json] [--check]
 *     generate widgets.generated.json (build.out in the spec) from the project's spec and its sources; --check only
 *     reports whether the committed file is fresh
 * kit widgets check [--spec widgets.spec.json]
 *     the guards: spec schema and references, a scenario for every widget, every text traceable to the spec or its
 *     sources, no other project's vocabulary, the generated file fresh (exit 1 on any problem)
 * kit widgets qa <url...> [--widths 390,1280] [--max-gap 120] [--times 600,4000,12000,25000]
 *     layout QA in a real browser (Playwright: --playwright / KIT_PLAYWRIGHT, --chromium / KIT_CHROMIUM): the largest
 *     empty vertical gap inside every widget and every device box, sampled while the widgets animate (exit 1 if any
 *     gap reaches --max-gap px)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { CliError } from "../args.js";
import { loadPlaywright } from "./diagrams.js";

// A sibling package in the kit (also inside a project's vendor/kit), so no extra dependency is needed.
const engine = () => import("../../../widgets/src/index.js");

export async function widgets(io, { _: [sub = "check", ...rest], flags }) {
  if (sub === "qa") return qa(io, rest, flags);
  const specPath = resolve(io.cwd, String(flags.spec || "widgets.spec.json"));
  if (!existsSync(specPath)) throw new CliError(`no ${relative(io.cwd, specPath) || specPath}: every project with widgets has a widgets.spec.json (docs/WIDGETS.md)`);
  const { buildWidgets, checkWidgets } = await engine();
  if (sub === "build") {
    let r;
    try { r = await buildWidgets(specPath); } catch (e) { throw new CliError(e.message); }
    const rel = relative(io.cwd, r.out);
    const same = existsSync(r.out) && readFileSync(r.out, "utf8") === r.json;
    if (flags.check) { if (same) { io.out(`ok: ${rel} is fresh`); return 0; } io.err(`${rel} is stale: run kit widgets build`); return 1; }
    if (!same) { mkdirSync(dirname(r.out), { recursive: true }); writeFileSync(r.out, r.json); }
    const n = r.generated.widgets.length, sc = new Set(r.generated.widgets.map((w) => w.scenario)).size;
    io.out(`${same ? "unchanged" : "wrote"}: ${rel} (${n} widget${n === 1 ? "" : "s"} from ${sc} scenario${sc === 1 ? "" : "s"}, ${r.generated.locales.map((l) => l.code).join(", ")})`);
    return 0;
  }
  if (sub === "check") {
    const { problems, widgets: n } = await checkWidgets(specPath);
    if (problems.length) { for (const p of problems) io.err(`  - ${p}`); io.err(`kit widgets check: ${problems.length} problem${problems.length === 1 ? "" : "s"}`); return 1; }
    io.out(`ok: ${n} widgets, every one from a scenario of widgets.spec.json, traceable, fresh, no other project's vocabulary`);
    return 0;
  }
  throw new CliError(`unknown subcommand "${sub}" (build, check, qa)`);
}

async function qa(io, urls, flags) {
  if (!urls.length) throw new CliError("kit widgets qa <url...>: give the pages to measure");
  const list = (v, d) => (v ? String(v).split(",").map(Number) : d);
  const maxGap = Number(flags["max-gap"] || 120);
  const { playwright, chromium } = await loadPlaywright(io, flags);
  const { measureGaps } = await engine();
  const results = await measureGaps(playwright, { urls, widths: list(flags.widths, [390, 1280]), times: list(flags.times, [600, 4000, 12000, 25000]), executablePath: chromium, maxGap });
  let bad = 0;
  for (const r of results) {
    if (!r.ok) bad++;
    (r.ok ? io.out : io.err)(`  ${r.ok ? "ok " : "GAP"} ${r.width}px ${r.widget}: largest empty gap ${r.gap}px in ${r.box} (at ${r.at}px of ${r.height}px, ${r.t}ms) ${r.url}`);
  }
  if (bad) { io.err(`kit widgets qa: ${bad} widget${bad === 1 ? "" : "s"} with an empty gap of ${maxGap}px or more`); return 1; }
  io.out(`ok: ${results.length} widget views, every empty gap under ${maxGap}px`);
  return 0;
}
