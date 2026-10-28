/**
 * kit check podcast: the t=0 rule for a project's podcast pipeline, as a gate (docs/PODCASTS.md).
 *
 *   podcast.config.json validates against kit.podcast-config.v1 (language, schedule, pacing, provenance policy, covers)
 *   one source per fact: kit.config.js's tts (voices, speakers, style, direction, temperature, pacing) and cron are the file's
 *   the schedule's cron is the Worker's [triggers] cron in wrangler.toml, and every series that makes episodes runs at its time
 *   the covers and brand assets named in the file exist in the repository, are PNG or JPEG, square, as large as declared
 *   the provenance migration is the generator's output (triggers validate the whole record on insert and update, only the accepted origins)
 *   no episode, MP3 or episode JSON is committed outside the pipeline's output (nothing is added by hand)
 *
 * podcastCheck(root, { project }) → { problems: [{ file, problem }], summary }
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { bundled } from "./canon/index.js";
import { readWrangler } from "./project.js";
import { migrationProblems } from "./podcast-migrations.js";
import { usSpellings, britishSpelling, unscoped } from "@saasreport/core/spelling";
import { loadExceptions } from "./canon/spelling.js";

export const CONFIG_FILE = "podcast.config.json";
const P = (file, problem) => ({ file, problem });

/** Width and height of a PNG or JPEG (null when it is neither). */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let o = 2; o + 9 < buf.length;) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: "jpeg", height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

const walk = (dir, skip, out = []) => {
  for (const name of readdirSync(dir)) {
    if (skip.has(name) || name.startsWith(".")) continue;   // dot folders are local tooling (.wrangler, .voice-samples), never committed output
    const p = join(dir, name), st = statSync(p);
    if (st.isDirectory()) walk(p, skip, out); else out.push(p);
  }
  return out;
};

export function podcastCheck(root, { config = null, content = null, kit = bundled() } = {}) {
  const problems = [];
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return { problems: [P(CONFIG_FILE, "missing: every project declares how its episodes sound and when they are made (schema kit.podcast-config.v1)")], summary: "no podcast.config.json" };
  let pc;
  try { pc = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return { problems: [P(CONFIG_FILE, `not JSON: ${e.message}`)], summary: "unreadable" }; }
  const schema = kit.byName("podcast-config");
  for (const m of formatProblems(kit.validator.validate(pc, schema))) problems.push(P(CONFIG_FILE, m));
  if (problems.length) return { problems, summary: "schema" };
  // spelling.exceptions may name the project's one exceptions file (shared with kit check spelling): read it here, and
  // expect kit.config.js to pass its entries (the resolved object) as tts.spelling
  let spelling = pc.spelling;
  if (typeof spelling?.exceptions === "string") {
    const r = loadExceptions(root, spelling.exceptions, kit);
    problems.push(...r.problems);
    if (!r.valid) return { problems, summary: "spelling exceptions" };
    spelling = { ...spelling, exceptions: r.entries };
  }

  // wrangler.toml: the cron
  const w = readWrangler(root), crons = w.triggers?.crons || [];
  if (!crons.includes(pc.schedule.cron)) problems.push(P("wrangler.toml", `[triggers] crons ${JSON.stringify(crons)} does not contain the schedule ${JSON.stringify(pc.schedule.cron)} of ${CONFIG_FILE}`));

  // kit.config.js: one source per fact
  if (config) {
    const t = config.tts || {};
    for (const key of ["provider", "model", "voices", "speakers", "style", "direction", "temperature", "languageCode"]) {
      if (JSON.stringify(t[key]) !== JSON.stringify(pc.tts[key])) problems.push(P("kit.config.js", `tts.${key} differs from ${CONFIG_FILE}: import it from the file (one source per fact)`));
    }
    if (JSON.stringify(t.spelling) !== JSON.stringify(spelling)) problems.push(P("kit.config.js", `tts.spelling differs from ${CONFIG_FILE} "spelling"${spelling !== pc.spelling ? ` (with the entries of ${pc.spelling.exceptions})` : ""}: import it from the file (one source per fact)`));
    if (JSON.stringify(t.pacing) !== JSON.stringify(pc.pacing)) problems.push(P("kit.config.js", `tts.pacing differs from ${CONFIG_FILE} "pacing": import it from the file (one source per fact)`));
    if (String(config.site?.locale || "").split(/[-_]/)[0] !== pc.language.split("-")[0]) problems.push(P("kit.config.js", `site.locale ${config.site?.locale} is not the podcast language ${pc.language}`));
    for (const s of config.series || []) if (s.podcast && s.every === "day" && s.at && s.at !== pc.schedule.at) problems.push(P("kit.config.js", `series ${s.id} runs at ${s.at}, the schedule says ${pc.schedule.at}`));
    for (const s of (config.series || []).filter((x) => x.podcast && x.every === "day" && x.podcast.maxSeconds)) {
      if (s.podcast.maxSeconds < pc.target.seconds) problems.push(P("kit.config.js", `series ${s.id} maxSeconds ${s.podcast.maxSeconds} is below the target ${pc.target.seconds} s`));
    }
    for (const id of Object.keys(pc.assets.covers)) if (!config.shows?.[id]) problems.push(P(CONFIG_FILE, `assets.covers.${id}: kit.config.js has no show "${id}"`));
    for (const id of Object.keys(config.shows || {})) if (!pc.assets.covers[id]) problems.push(P(CONFIG_FILE, `assets.covers has no cover for the show "${id}"`));
  }

  // British English: the scripts the pipeline generates (talk lines rewritten by britishSpelling) carry no American spelling; this fails when the list or
  // the exceptions miss something. The list is maintained in @saasreport/core/spelling.
  if (pc.language === "en-GB" && content) {
    // spoken lines have no file of their own: an exception scoped by `files` never applies to them
    const spoken = unscoped(spelling?.exceptions);
    const seen = new Map();
    const talkOf = (it) => (Array.isArray(it?.talk) ? it.talk : []).map((l) => (Array.isArray(l) ? l[1] : l?.text)).filter(Boolean);
    for (const [series, pack] of Object.entries(content)) {
      const items = Array.isArray(pack) ? pack : pack?.terms || pack?.items || [];
      for (const it of items) for (const line of talkOf(it)) for (const w of usSpellings(britishSpelling(line, { exceptions: spoken }), { exceptions: spoken })) {
        const key = `${series}/${it.slug || it.date || it.term || it.title}`;
        if (!seen.has(`${key}:${w.us}`)) { seen.set(`${key}:${w.us}`, 1); problems.push(P(`content: ${key}`, `American spelling "${w.us}" in a spoken line (British: "${w.gb}")`)); }
      }
    }
  }

  // covers and brand assets
  for (const [show, c] of Object.entries(pc.assets.covers)) {
    const rel = join(pc.assets.dir, c.file), file = join(root, rel);
    if (!existsSync(file)) { problems.push(P(rel, `cover of show "${show}" is missing`)); continue; }
    const dim = imageSize(readFileSync(file));
    if (!dim) problems.push(P(rel, "is not a PNG or JPEG"));
    else if (dim.width !== dim.height) problems.push(P(rel, `must be square, is ${dim.width}x${dim.height}`));
    else if (dim.width !== c.size) problems.push(P(rel, `is ${dim.width}px, ${CONFIG_FILE} declares ${c.size}`));
  }

  // the database triggers: generated from the provenance schema and this project's origins; the file on disk must be exactly that
  const mig = join(root, "migrations");
  const catchupOn = pc.catchup.enabled, hasCatchup = pc.provenance.origins.includes("catchup");
  if (catchupOn !== hasCatchup) problems.push(P(CONFIG_FILE, `catchup.enabled is ${catchupOn} but provenance.origins ${hasCatchup ? "lists" : "does not list"} "catchup": they go together`));
  for (const m of migrationProblems(root, pc.provenance.origins)) problems.push(P("migrations/", m));

  // nothing committed by hand: episodes are rows and R2 objects the pipeline makes, never files in the repository
  const skip = new Set(["node_modules", ".git", ".wrangler", "vendor", ".kit", "dist"]);
  for (const f of walk(root, skip)) {
    const rel = f.slice(root.length + 1);
    if (/\.(mp3|m4a|wav|ogg)$/i.test(rel) && !rel.startsWith(pc.assets.dir + "/")) problems.push(P(rel, "an audio file is committed: episodes are made by the cron into R2, never added by hand"));
    if (/^(content\/|src\/content\/)?podcasts?\/.*\.(json|md)$/i.test(rel) || /(^|\/)episodes?\.json$/i.test(rel)) problems.push(P(rel, "an episode record is committed: episodes come from the series' content items through the pipeline, never from files"));
  }
  return { problems, summary: `${CONFIG_FILE} valid; ${Object.keys(pc.assets.covers).length} cover(s); cron ${pc.schedule.cron}; pacing max pause ${pc.pacing.maxPauseMs} ms; manual generation off` };
}
