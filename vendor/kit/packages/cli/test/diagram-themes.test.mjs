// Each organisation's diagrams in its own colours: the header's project picks the theme, vendored themes carry their
// provenance, a project without a theme is refused. No Chromium: a fake browser reports what would be drawn.
// The kit's registry holds one project, so the organisations below are a synthetic kit built in the test: the real registry plus
// three fictional projects (two with vendored themes, one without), with the diagram schemas regenerated for them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, cpSync, rmSync } from "node:fs";
import { createValidator } from "@saasreport/core/schema";
import { render as renderCodes } from "../../core/scripts/project-codes.mjs";
import { join, basename } from "node:path";
import { main } from "../src/index.js";
import { bundled } from "../src/bundled.js";
import { themeInit, parseTheme, applyThemeToRepo, checkRepo, renderSources, themeResolver, stampPng, sourceHash, themeFromTokens, THEME_FILE } from "../src/diagrams.js";
import { footerHash } from "../src/diagram-gates.js";
import { gitBlobId, themeSourceProblems, syncTheme, resolveProjectName, loadSources } from "../src/diagram-themes.js";
import { readHeader, headerLine } from "../src/diagram-header.js";
import { checkDiagrams } from "../src/diagram-lineage.js";
import { syncGenerated, themedPng, png, header } from "./diagram-fixtures.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const NEUTRAL = { ink: "#0B0B0B", rail: "#B8B8B8", railDark: "#5A5A5A", bg: "#FAFAF7", sink: "#F3F2EE", onAccent: "#FFFFFF", surface: "#FFFFFF" };
// the repository under test draws in its own, different colours (blue on a cool ground), so another organisation's theme cannot be mistaken for it
const OWN = { ...NEUTRAL, bg: "#EEF3F9", sink: "#E2EAF3", accent: "#0057B8", accentTint: "#E6F0FA" };
const FONT = { family: "Brand Sans", path: "fonts/brand.ttf" };
// the organisations (fictional): alpha has a copied theme and a short code, beta a provisional one, delta none
const ORGS = {
  alpha: { name: "Alpha", short: "al-", github: ["Alpha-Org/site"], accent: "#167A42", tint: "#E7F5EC", via: "copy" },
  beta: { name: "Beta", short: null, github: ["Beta-Org/site"], accent: "#6B2177", tint: "#F6EEF7", via: "provisional" },
  delta: { name: "Delta", short: null, github: ["Delta-Org/site"], noTheme: true },
};
const THEMED = Object.entries(ORGS).filter(([, o]) => !o.noTheme).map(([k]) => k);
const ACCENT = Object.fromEntries(THEMED.map((k) => [k, ORGS[k].accent]));
const CODE = { alpha: "al", beta: "beta" };

let n = 0;
const TMP = fileTempDir("kit-themes-");
const ROOT = join(import.meta.dirname, "../../..");

/** The theme of an organisation as its own repository would publish it: the theme file, and its font next to it. */
function stageOrg(key) {
  const o = ORGS[key], up = join(TMP, `up${n++}`); mkdirSync(up);
  const notes = [`${o.name} test theme`, ...(o.via === "provisional" ? ["PROVISIONAL: a stand-in written in the kit, pending the owner's brand kit"] : [])];
  writeFileSync(join(up, "theme.init"), themeInit({ ...NEUTRAL, accent: o.accent, accentTint: o.tint }, { family: "Brand Sans", path: `public/fonts/${key}-400.woff2` }, notes, { project: key }));
  writeFileSync(join(up, `${key}-400.woff2`), `font of ${key}`);
  return up;
}
const COMMIT = "a".repeat(40);
/** The real registry plus the fictional projects, their vendored themes recorded through syncTheme, and the diagram schemas regenerated for their codes. */
function makeKit() {
  const base = bundled(), registryDir = join(TMP, `registry${n++}`);
  cpSync(base.registryDir, registryDir, { recursive: true });
  const registry = structuredClone(base.registry);
  for (const [key, o] of Object.entries(ORGS)) registry.projects.push({ key, name: o.name, domain: `${key}.example`, prefix: `${key}-`, short: o.short, github: o.github, ...(o.noTheme ? {} : { theme: `themes/${key}.init` }) });
  const out = renderCodes(registry, (f) => readFileSync(join(ROOT, f), "utf8"));
  const schemas = base.schemas.map((s) => { const text = out[`packages/core/schemas/${s.file}`]; return text ? { ...s, schema: JSON.parse(text) } : s; });
  const kit = { ...base, registry, registryDir, schemas, validator: createValidator(schemas.map((s) => s.schema)), byName: (name) => schemas.find((s) => s.name === name)?.schema };
  for (const key of THEMED) {
    const up = stageOrg(key);
    syncTheme(key, ORGS[key].via === "provisional" ? { from: join(up, "theme.init"), via: "provisional", note: "Provisional, pending the owner's brand kit.", fontsDir: up } : { from: join(up, "theme.init"), repo: ORGS[key].github[0], path: "docs/diagrams/theme.init", commit: COMMIT, fontsDir: up }, kit);
  }
  return kit;
}
const KIT = makeKit();

/** A repository whose own project is the kit (like this one), holding the given files. */
function kitRepo(files = {}, own = OWN) {
  const dir = join(TMP, `r${n++}`);
  mkdirSync(join(dir, "docs/diagrams"), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "fonts/brand.ttf"), "not really a font");
  writeFileSync(join(dir, THEME_FILE), themeInit(own, FONT, ["test theme"], { project: "kit" }));
  writeFileSync(join(dir, "kit.canon.json"), '{"project":"kit"}');
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), t); }
  return dir;
}
const io = (cwd, extra = {}) => { const out = [], err = []; return { cwd, out: (s) => out.push(s), err: (s) => err.push(s), env: {}, o: out, e: err, ...extra }; };
const body = "flowchart TB\n  a(\"A\"):::accent --> b(\"B\")\n";
const diagram = (id, project) => `${headerLine(header(id, { project }))}\n${body}`;
function fakeBrowser(seen, shot) {
  const page = {
    async setContent(html) { seen.html = html; }, async addScriptTag() {},
    async evaluate(_fn, arg) { seen.arg = arg; return { ok: true, width: 300, clipped: [] }; },
    locator() { return { screenshot: async () => shot }; }, async close() {},
  };
  return { chromium: { launch: async () => ({ newPage: async () => page, close: async () => {} }) } };
}

test("the registry links each organisation to its vendored theme; every file matches its recorded git blob id", () => {
  const kit = KIT;
  assert.deepEqual(themeSourceProblems(kit), []);
  for (const [key, accent] of Object.entries(ACCENT)) {
    const entry = kit.registry.projects.find((p) => p.key === key);
    assert.ok(entry.theme, `${key} names its vendored theme`);
    const text = readFileSync(join(kit.registryDir, entry.theme), "utf8");
    const t = parseTheme(text, entry.theme);
    assert.match(t.classDefs.get("accent"), new RegExp(`^fill:${accent}`), `${key}'s accent is ${accent}`);
    assert.equal(gitBlobId(text), loadSources(kit).doc.themes.find((x) => x.project === key).blob);
  }
  assert.deepEqual(themeSourceProblems(bundled()), [], "the kit's own registry holds no vendored theme and no problem");
});

test("must fail: a hand-edited vendored theme (or font) fails the provenance check, naming the project", () => {
  const reg = join(TMP, `registry${n++}`);
  cpSync(KIT.registryDir, reg, { recursive: true });
  const copy = { ...KIT, registryDir: reg };
  assert.deepEqual(themeSourceProblems(copy), []);
  const f = join(reg, "themes/alpha.init");
  writeFileSync(f, readFileSync(f, "utf8").replace("#167A42", "#167A43"));
  const p = themeSourceProblems(copy);
  assert.equal(p.length, 1);
  assert.match(p[0], /project alpha: themes\/alpha\.init has blob [0-9a-f]{40} but themes\/sources\.json records [0-9a-f]{40}.*never edited by hand/);
  writeFileSync(join(reg, "themes/fonts/alpha/alpha-400.woff2"), "x");
  assert.match(themeSourceProblems(copy).join("\n"), /the font fonts\/alpha\/alpha-400\.woff2 has blob/);
  // the resolver refuses to draw with it
  const dir = kitRepo({ "docs/diagrams/k.mmd": diagram("al.k", "al") });
  assert.throws(() => themeResolver(dir, copy).forProject("alpha"), /vendored theme of alpha is not what its provenance records/);
});

test("themes --sync refreshes one copy and its record (a byte copy, the git blob id), and refuses what it cannot record", () => {
  const reg = join(TMP, `registry${n++}`);
  cpSync(KIT.registryDir, reg, { recursive: true });
  const copy = { ...KIT, registryDir: reg };
  const upstream = stageOrg("alpha");
  const text = readFileSync(join(upstream, "theme.init"), "utf8").replace("tint #E7F5EC", "tint #E7F5ED");
  writeFileSync(join(upstream, "theme.init"), text);
  const commit = "b".repeat(40);
  const r = syncTheme("alpha", { from: join(upstream, "theme.init"), repo: "Alpha-Org/site", path: "docs/diagrams/theme.init", commit, fontsDir: upstream }, copy);
  assert.equal(r.record.blob, gitBlobId(text));
  assert.equal(readFileSync(join(reg, "themes/alpha.init"), "utf8"), text);
  assert.deepEqual(themeSourceProblems(copy), []);
  assert.equal(loadSources(copy).doc.themes.find((t) => t.project === "alpha").commit, commit);
  assert.throws(() => syncTheme("alpha", { from: join(upstream, "theme.init"), repo: "Somebody/else", path: "p", commit, fontsDir: upstream }, copy), /not one of alpha's github repositories/);
  assert.throws(() => syncTheme("alpha", { from: join(upstream, "theme.init"), repo: "Alpha-Org/site", path: "p", commit: "abc", fontsDir: upstream }, copy), /40-hex/);
  assert.throws(() => syncTheme("alpha", { from: join(upstream, "theme.init"), repo: "Alpha-Org/site", path: "p", commit }, copy), /--fonts-dir/);
  assert.throws(() => syncTheme("delta", { from: join(upstream, "theme.init"), repo: "x/y", path: "p", commit }, copy), /has no `theme` in projects\.json/);
  // a derived theme records the blob of the source it was derived from, so the derivation is checkable against upstream
  assert.throws(() => syncTheme("alpha", { from: join(upstream, "theme.init"), repo: "Alpha-Org/site", path: "src/site/tokens.js", commit, via: "derive", fontsDir: upstream }, copy), /--via derive needs --source/);
  writeFileSync(join(upstream, "tokens.js"), "export default {}\n");
  const derived = syncTheme("alpha", { from: join(upstream, "theme.init"), repo: "Alpha-Org/site", path: "src/site/tokens.js", commit, via: "derive", source: join(upstream, "tokens.js"), fontsDir: upstream }, copy);
  assert.equal(derived.record.source_blob, gitBlobId(readFileSync(join(upstream, "tokens.js"))));
});

const PROVISIONAL = loadSources(KIT).doc.themes.filter((t) => t.via === "provisional").map((t) => t.project);
test("beta is provisional (the loop below covers every provisional record, so a new one is tested the day it is added)", () => {
  assert.deepEqual(PROVISIONAL, ["beta"]);
});

/** A theme's upstream as syncTheme reads it: the theme file, and every font its record declares (by basename), whatever the font. */
function stageUpstream(reg, key, rec) {
  const upstream = join(TMP, `up${n++}`); mkdirSync(upstream);
  cpSync(join(reg, `themes/${key}.init`), join(upstream, "theme.init"));
  for (const f of rec.fonts || []) cpSync(join(reg, "themes", f.file), join(upstream, basename(f.theme_path)));
  return upstream;
}

test("a provisional theme with another font, and one with no font, re-sync from exactly the fonts their records declare (Codex on #136: Inter-400.woff2 was assumed)", () => {
  const kit = KIT, key = PROVISIONAL[0];
  const make = (initFix, fontsFix) => {
    const reg = join(TMP, `registry${n++}`); cpSync(kit.registryDir, reg, { recursive: true });
    const copy = { ...kit, registryDir: reg }, sf = join(reg, "themes/sources.json"), doc = JSON.parse(readFileSync(sf, "utf8"));
    const rec = doc.themes.find((t) => t.project === key), inter = rec.fonts.find((f) => /-400\.woff2$/.test(f.file));
    assert.ok(inter, `${key} starts from the Brand Sans font`);
    const init = join(reg, `themes/${key}.init`);
    writeFileSync(init, initFix(readFileSync(init, "utf8")));
    rec.fonts = fontsFix(rec.fonts, reg, inter);
    writeFileSync(sf, JSON.stringify(doc));
    rmSync(join(reg, "themes", inter.file));          // the old helper copied this file whatever the record said: it is gone in both cases
    return { reg, copy, rec };
  };
  const other = make((s) => s.replace(/^(%%\s*font:\s*)(?:"[^"]+"|\S+)\s+\S+$/m, '$1"Other" public/fonts/Other-400.woff2'), (fonts, reg, inter) => {
    cpSync(join(reg, "themes", inter.file), join(reg, `themes/fonts/${key}/Other-400.woff2`));
    return [{ theme_path: "public/fonts/Other-400.woff2", file: `fonts/${key}/Other-400.woff2`, blob: inter.blob }];
  });
  const up1 = stageUpstream(other.reg, key, other.rec);
  const r1 = syncTheme(key, { from: join(up1, "theme.init"), via: "provisional", note: "Provisional, pending the owner's brand kit.", fontsDir: up1 }, other.copy);
  assert.deepEqual(r1.record.fonts.map((f) => f.file), [`fonts/${key}/Other-400.woff2`]);
  assert.deepEqual(themeSourceProblems(other.copy), []);
  const none = make((s) => s.split("\n").filter((l) => !/^%%\s*font:/.test(l.trim())).join("\n"), () => []);
  const up = stageUpstream(none.reg, key, none.rec);
  const r2 = syncTheme(key, { from: join(up, "theme.init"), via: "provisional", note: "Provisional, pending the owner's brand kit." }, none.copy);
  assert.deepEqual(r2.record.fonts, []);
  assert.deepEqual(themeSourceProblems(none.copy), []);
});

for (const key of PROVISIONAL) test(`${key}'s theme is provisional: recorded as such with no upstream, refused as anything else, and a copy or derive record still needs its upstream`, () => {
  const kit = KIT;
  const rec = loadSources(kit).doc.themes.find((t) => t.project === key);
  assert.equal(rec.via, "provisional");
  assert.match(rec.note, /provisional.*pending/i);
  assert.equal(rec.repo, undefined, "a provisional theme has no upstream to name");
  assert.match(readFileSync(join(kit.registryDir, `themes/${key}.init`), "utf8"), /PROVISIONAL/);
  const reg = join(TMP, `registry${n++}`);
  cpSync(kit.registryDir, reg, { recursive: true });
  const copy = { ...kit, registryDir: reg };
  const upstream = stageUpstream(reg, key, rec);
  const r = syncTheme(key, { from: join(upstream, "theme.init"), via: "provisional", note: "Provisional, pending the owner's brand kit.", fontsDir: upstream }, copy);
  assert.equal(r.record.via, "provisional");
  assert.deepEqual(themeSourceProblems(copy), []);
  assert.throws(() => syncTheme(key, { from: join(upstream, "theme.init"), via: "provisional", fontsDir: upstream }, copy), /--via provisional needs --note/);
  // must fail: a record that is not provisional but names no upstream, and a provisional one with no reason
  const doc = JSON.parse(readFileSync(join(reg, "themes/sources.json"), "utf8"));
  const bad = (f) => { const d = structuredClone(doc); f(d.themes.find((t) => t.project === key)); writeFileSync(join(reg, "themes/sources.json"), JSON.stringify(d)); return themeSourceProblems(copy).join("\n"); };
  assert.match(bad((t) => { t.via = "copy"; }), new RegExp(`${key}|repo|commit|path`));
  assert.match(bad((t) => { delete t.note; }), /note/);
});

for (const key of THEMED) {
  const code = CODE[key];
  test(`a ${code} diagram rendered inside the kit is drawn in ${key}'s init line, classes, font and accent ${ACCENT[key]}, not the kit's`, async () => {
    const dir = kitRepo({ [`docs/diagrams/${code}.mmd`]: diagram(`${code}.sample`, code) });
    const R = themeResolver(dir, KIT);
    applyThemeToRepo(dir, R);
    const src = readFileSync(join(dir, `docs/diagrams/${code}.mmd`), "utf8");
    const th = R.forSource(src);
    assert.equal(th.project, key);
    assert.equal(src.split("\n")[0], th.init, "the source carries the project's own init line");
    assert.notEqual(th.init, R.own.theme.init);
    assert.match(src, new RegExp(`classDef accent fill:${ACCENT[key]}`));
    // rendering: the theme's font, background, and the picture must carry the project's accent
    const seen = {};
    const res = await renderSources(dir, [{ label: "x.mmd", source: src, out: "out/x.png", id: `${code}.sample`, theme: th }], R.own.theme, { playwright: fakeBrowser(seen, themedPng(th)), mermaidJs: "/m.js" });
    assert.deepEqual(res, [{ file: "x.mmd", ok: true }]);
    assert.ok(seen.html.includes(th.fonts[0].family), "the font of the project's theme");
    assert.ok(seen.html.includes(`background:${th.initVars.themeVariables.background}`));
    assert.ok(seen.arg.code.startsWith(th.init));
    assert.equal(seen.arg.ink, th.initVars.themeVariables.textColor);
    // a picture drawn in the kit's colours is not this project's: the palette gate refuses it
    const wrong = await renderSources(dir, [{ label: "x.mmd", source: src, out: "out/y.png", id: `${code}.sample`, theme: th }], R.own.theme, { playwright: fakeBrowser({}, themedPng(R.own.theme)), mermaidJs: "/m.js" });
    assert.equal(wrong[0].ok, false);
    assert.match(wrong[0].error, new RegExp(`${ACCENT[key]}|background`, "i"));
  });
}

test("a diagram rendered with --project that is not its header's project is refused: the header decides the colours", async () => {
  const dir = kitRepo();
  const scratch = join(TMP, `scratch${n++}`); mkdirSync(scratch);
  writeFileSync(join(scratch, "k.mmd"), diagram("kit.scratch", "kit"));
  const bad = io(dir, { renderDeps: { playwright: fakeBrowser({}, png()), mermaidJs: "/m.js" } });
  assert.equal(await main(["diagrams", "render", "--file", join(scratch, "k.mmd"), "--project", "saasreport"], bad), 1);
  assert.match(bad.e.join("\n"), /header of .*k\.mmd says project kit: the header's project picks the theme/);
});

test("must fail: a project with no vendored theme is refused with a precise message, never drawn in the kit's colours", async () => {
  const dir = kitRepo({ "docs/diagrams/o.mmd": diagram("delta.o", "delta") });
  const R = themeResolver(dir, KIT);
  assert.throws(() => R.forProject("delta"), /project delta is registered but has no vendored theme.*never drawn in another project's colours.*kit diagrams themes --sync delta/);
  assert.throws(() => R.forProject("nonesuch"), /project "nonesuch" is not a project of the registry/);
  const r = checkRepo(dir, KIT);
  assert.ok(r.problems.some((p) => p.file === "docs/diagrams/o.mmd" && /delta is registered but has no vendored theme/.test(p.problem)), JSON.stringify(r.problems));
  assert.throws(() => applyThemeToRepo(dir, R), /docs\/diagrams\/o\.mmd: project delta is registered but has no vendored theme/);
  // the kit's own registry: its one project has no vendored theme either (its diagrams are drawn in the repository's own theme.init)
  const scratch = join(TMP, `scratch${n++}`); mkdirSync(scratch);
  writeFileSync(join(scratch, "o.mmd"), diagram("saasreport.scratch", "saasreport"));
  const refused = io(dir, { renderDeps: { playwright: fakeBrowser({}, png()), mermaidJs: "/m.js" } });
  assert.equal(await main(["diagrams", "render", "--file", join(scratch, "o.mmd"), "--out", scratch], refused), 1);
  assert.match(refused.e.join("\n"), /project saasreport is registered but has no vendored theme/);
});

test("must fail: an alpha diagram carrying the kit's init line, and one stamped with another theme, fail kit diagrams check", () => {
  const dir = kitRepo({ "docs/diagrams/k.mmd": diagram("al.k", "al") });
  const R = themeResolver(dir, KIT);
  applyThemeToRepo(dir, R);
  syncGenerated(dir, undefined, KIT);
  const ok = checkDiagrams(dir, { kit: KIT });
  assert.deepEqual(ok.problems, [], "drawn in alpha's theme, stamped with it: passes");
  const alpha = R.forProject("alpha");
  // the kit's own init line in an alpha diagram
  const src = readFileSync(join(dir, "docs/diagrams/k.mmd"), "utf8");
  const own = R.own.theme;
  writeFileSync(join(dir, "docs/diagrams/k.mmd"), src.replace(alpha.init, own.init));
  const bad = checkDiagrams(dir, { kit: KIT }).problems.map((p) => p.problem);
  assert.ok(bad.some((p) => /init line is kit's theme, but the diagram's project is al: a al diagram is drawn in al's own colours/.test(p) || /init line is kit's theme, but the diagram's project is al/.test(p)), bad.join("\n"));
  // restored, but the PNG was stamped with the kit's theme hash
  writeFileSync(join(dir, "docs/diagrams/k.mmd"), src);
  const stamped = stampPng(png(), sourceHash(src), "al.k", { theme: own.hash, footer: footerHash(readHeader(src).header) });
  writeFileSync(join(dir, "docs/diagrams/k.png"), stamped);
  assert.ok(checkDiagrams(dir, { kit: KIT }).problems.some((p) => p.file === "docs/diagrams/k.png" && /rendered with another theme/.test(p.problem)));
  // classDef accent in another organisation's colour
  writeFileSync(join(dir, "docs/diagrams/k.mmd"), src.replace("classDef accent fill:#167A42", "classDef accent fill:#6B2177"));
  assert.ok(checkDiagrams(dir, { kit: KIT }).problems.some((p) => /classDef accent differs from the theme/.test(p.problem)));
});

test("Markdown mermaid blocks are checked against the theme of their own header's project", () => {
  const block = `${headerLine(header("al.docs.a.1", { project: "al" }))}\n${body}`;
  const dir = kitRepo({ "docs/A.md": `# A\n\n\`\`\`mermaid\n${block}\`\`\`\n` });
  const R = themeResolver(dir, KIT);
  applyThemeToRepo(dir, R);
  const md = readFileSync(join(dir, "docs/A.md"), "utf8");
  assert.match(md, /classDef accent fill:#167A42/);
  const probs = checkRepo(dir, KIT).problems.filter((p) => p.file.startsWith("docs/A.md")).map((p) => p.problem);
  assert.deepEqual(probs, []);
  writeFileSync(join(dir, "docs/A.md"), md.replace(R.forProject("alpha").init, R.own.theme.init));
  assert.ok(checkRepo(dir, KIT).problems.some((p) => p.file.startsWith("docs/A.md") && /kit's theme, but the diagram's project is al/.test(p.problem)));
});

test("the repository's own project is declared in theme.init, never guessed: a theme.init without it is refused", async () => {
  const dir = kitRepo();
  writeFileSync(join(dir, THEME_FILE), themeInit(OWN, FONT, ["no declaration"]));
  const r = checkRepo(dir);
  assert.match(r.problems[0].problem, /has no `%% kit:theme \{"project":"<registry key>"\}` declaration.*never guessed from its git remote/);
  assert.throws(() => themeResolver(dir), /declaration/);
  const c = io(dir);
  assert.equal(await main(["diagrams", "check"], c), 1);
  assert.match(c.e.join("\n"), /kit:theme/);
  writeFileSync(join(dir, THEME_FILE), themeInit(OWN, FONT, [], { project: "nonesuch" }));
  assert.match(checkRepo(dir).problems[0].problem, /names "nonesuch", which is not a project of the registry/);
  assert.throws(() => parseTheme(`${themeInit(OWN, FONT)}%% kit:theme {"project": 3}\n`), /kit:theme declaration is/);
  assert.throws(() => parseTheme(`${themeInit(OWN, FONT)}%% kit:theme nope\n`), /kit:theme declaration is/);
});

test("the declaration says whose theme this is, not how it looks: it does not change the theme hash", () => {
  const withDecl = parseTheme(themeInit(OWN, FONT, ["x"], { project: "kit" }));
  const without = parseTheme(themeInit(OWN, FONT, ["x"]));
  assert.equal(withDecl.project, "kit");
  assert.equal(without.project, null);
  assert.equal(withDecl.hash, without.hash);
});

test("derive writes the project declaration (kit.canon.json project, or --project) and refuses without one", async () => {
  const dir = join(TMP, `site${n++}`); mkdirSync(join(dir, "public/fonts"), { recursive: true });
  writeFileSync(join(dir, "public/fonts/Brand-400.woff2"), "x");
  const tokens = { color: { ...NEUTRAL, accent: "#167A42", accentTint: "#E7F5EC" }, font: { sans: "Brand", faces: [{ family: "Brand", weight: 400, src: "/fonts/Brand-400.woff2" }] } };
  writeFileSync(join(dir, "site.config.js"), `export default { name: "Green", tokens: ${JSON.stringify(tokens)} };\n`);
  assert.throws(() => themeFromTokens(tokens, { root: dir }), /the project \(registry key\) is required/);
  const none = io(dir);
  assert.equal(await main(["diagrams", "derive"], none).catch((e) => { none.e.push(e.message); return 1; }), 1);
  assert.match(none.e.join("\n"), /cannot tell the project/);
  assert.equal(await main(["diagrams", "derive", "--project", "saasreport"], io(dir)), 0);
  assert.equal(parseTheme(readFileSync(join(dir, THEME_FILE), "utf8")).project, "saasreport");
  assert.equal(await main(["diagrams", "derive", "--check", "--project", "saasreport"], io(dir)), 0);
  writeFileSync(join(dir, "kit.canon.json"), '{"project":"kit"}');
  assert.equal(await main(["diagrams", "derive", "--check"], io(dir)), 1, "another project's declaration differs from the file on disk");
});

test("project names resolve through the key or the short code; kit is kit", () => {
  const reg = KIT.registry;
  assert.equal(resolveProjectName("saasreport", reg).key, "saasreport");
  assert.equal(resolveProjectName("alpha", reg).key, "alpha");
  assert.equal(resolveProjectName("al", reg).key, "alpha");
  assert.equal(resolveProjectName("beta", reg).key, "beta");
  assert.equal(resolveProjectName("alpha-", reg), null);
  assert.deepEqual(resolveProjectName("kit", reg), { key: "kit", code: "kit", project: null });
  // must fail: a name that is neither a key nor a code (a project with no short form has no short code)
  for (const bad of ["sr", "sc", "sr-", "saasreport-", "be"]) assert.equal(resolveProjectName(bad, reg), null, bad);
  assert.equal(resolveProjectName("saasreport", reg).code, "saasreport");
  // must pass: every registry project resolves by its key and by its code, to itself
  for (const p of reg.projects) {
    const code = p.short ? p.short.replace(/-$/, "") : p.key;
    assert.equal(resolveProjectName(p.key, reg).key, p.key, p.key);
    assert.equal(resolveProjectName(code, reg).key, p.key, code);
  }
});

test("kit diagrams themes: ok on the real files, fails on a mismatch", async () => {
  const c = io(process.cwd());
  assert.equal(await main(["diagrams", "themes"], c), 0, c.e.join("\n"));
  assert.match(c.o[0], /0 vendored organisation themes match their recorded provenance/);
});
