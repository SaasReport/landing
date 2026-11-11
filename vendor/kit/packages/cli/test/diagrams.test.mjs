// kit diagrams: each project's brand theme (docs/diagrams/theme.init), theming, PNG source stamps, check, derive,
// and render with a fake browser (no Chromium, no network).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { main } from "../src/index.js";
import { COMMAND_TABLE } from "../src/commands/table.js";
import { syncGenerated, themedPng } from "./diagram-fixtures.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";
import {
  themeInit, parseTheme, applyTheme, diagramProblems, stampPng, readStamp, sourceHash, checkRepo, applyThemeToRepo,
  renderDiagrams, themeFromTokens, mermaidBlocks, readStampId, THEME_FILE,
} from "../src/diagrams.js";

const NEUTRAL = { ink: "#0B0B0B", rail: "#B8B8B8", railDark: "#5A5A5A", bg: "#FAFAF7", sink: "#F3F2EE", onAccent: "#FFFFFF", surface: "#FFFFFF" };
const ORANGE = { ...NEUTRAL, accent: "#FF5A00", accentTint: "#FFF1E8" };
const GREEN = { ...NEUTRAL, accent: "#167A42", accentTint: "#E7F5EC" };
const FONT = { family: "Brand Sans", path: "fonts/brand.ttf" };

const TMP = fileTempDir("kit-diagrams-");

function png() {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); data.copy(b, 8);
    return b;   // CRC left zero: the stamp code never verifies other chunks' CRCs
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}

let n = 0;
function repo(colors = ORANGE, files = {}) {
  const dir = join(TMP, `r${n++}`);
  mkdirSync(join(dir, "docs/diagrams"), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "fonts/brand.ttf"), "not really a font");
  writeFileSync(join(dir, THEME_FILE), themeInit(colors, FONT, ["test theme"], { project: "kit" }));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), t); }
  return dir;
}
const io = (cwd) => { const out = [], err = []; return { cwd, out: (s) => out.push(s), err: (s) => err.push(s), env: {}, o: out, e: err }; };

test("themeInit: one init line, the two theme classes, font directive; parseTheme reads it back", () => {
  const t = parseTheme(themeInit(GREEN, FONT, ["from tokens.js"]));
  assert.match(t.init, /^%%\{init: \{"theme":"base","themeVariables":\{.*\}\}\}%%$/);
  assert.equal(t.initVars.themeVariables.specialStateColor, "#167A42");
  assert.equal(t.initVars.themeVariables.noteBkgColor, "#E7F5EC");
  assert.equal(t.initVars.themeVariables.fontFamily, "Brand Sans, Arial, sans-serif");
  assert.equal(t.classDefs.get("accent"), "fill:#167A42,stroke:#167A42,color:#FFFFFF,stroke-width:2px");
  assert.equal(t.classDefs.get("muted"), "fill:#FFFFFF,stroke:#B8B8B8,color:#5A5A5A,stroke-dasharray:4 3");
  assert.deepEqual(t.fonts, [FONT]);
  assert.ok(t.palette.has("#167A42") && !t.palette.has("#FF5A00"));
});

test("themeInit reproduces the reference init line byte for byte", () => {
  const reference = '%%{init: {"theme":"base","themeVariables":{"fontFamily":"Vazirmatn, Arial, sans-serif","fontSize":"15px","textColor":"#0B0B0B","stateLabelColor":"#0B0B0B","transitionLabelColor":"#0B0B0B","background":"#FAFAF7","primaryColor":"#FFFFFF","primaryTextColor":"#0B0B0B","primaryBorderColor":"#0B0B0B","lineColor":"#5A5A5A","secondaryColor":"#F3F2EE","tertiaryColor":"#FAFAF7","clusterBkg":"#F3F2EE","clusterBorder":"#B8B8B8","edgeLabelBackground":"#FAFAF7","titleColor":"#0B0B0B","actorBkg":"#0B0B0B","actorBorder":"#0B0B0B","actorTextColor":"#FFFFFF","actorLineColor":"#B8B8B8","signalColor":"#0B0B0B","signalTextColor":"#0B0B0B","labelBoxBkgColor":"#FAFAF7","labelBoxBorderColor":"#B8B8B8","noteBkgColor":"#FFF1E8","noteBorderColor":"#FF5A00","sequenceNumberColor":"#FFFFFF","stateBkg":"#FFFFFF","stateBorder":"#0B0B0B","transitionColor":"#5A5A5A","specialStateColor":"#FF5A00"}}}%%';
  assert.equal(themeInit(ORANGE, { family: "Vazirmatn", path: "x.ttf" }).split("\n")[0], reference);
});

test("parseTheme refuses a file without an init line or with stray lines", () => {
  assert.throws(() => parseTheme("flowchart TB\n"), /line 1 must be the Mermaid init line/);
  assert.throws(() => parseTheme(`${themeInit(ORANGE, FONT)}\nflowchart TB\n`), /unexpected line/);
  assert.throws(() => parseTheme("%%{init: {nope}}%%\n"), /not valid JSON/);
});

test("applyTheme replaces or adds the init line and replaces the theme's classDefs only", () => {
  const green = parseTheme(themeInit(GREEN, FONT));
  const orange = themeInit(ORANGE, FONT).split("\n");
  const src = [orange[0], "flowchart TB", '  a("A") --> b("B")', `  ${orange[1]}`, "  classDef other fill:#FFFFFF", "  class a accent", ""].join("\n");
  const out = applyTheme(src, green);
  assert.equal(out.split("\n")[0], green.init);
  assert.ok(out.includes("  classDef accent fill:#167A42,stroke:#167A42,color:#FFFFFF,stroke-width:2px"));
  assert.ok(out.includes("  classDef other fill:#FFFFFF"));
  assert.ok(!out.includes("#FF5A00"));
  assert.ok(out.endsWith("\n"));
  assert.equal(applyTheme("flowchart LR\n  a:::accent --> b", green).split("\n")[0], green.init);
  assert.equal(applyTheme(out, green), out, "idempotent");
});

test("diagramProblems: missing or other project's init line, foreign colours in style lines", () => {
  const green = parseTheme(themeInit(GREEN, FONT));
  const orange = themeInit(ORANGE, FONT).split("\n");
  assert.deepEqual(diagramProblems(applyTheme("flowchart TB\n  a:::accent --> b\n  class a accent\n", green), green), []);
  assert.match(diagramProblems("flowchart TB\n", green)[0], /no init line/);
  const orangeDiagram = `${orange[0]}\nflowchart TB\n  ${orange[1]}\n`;
  const p = diagramProblems(orangeDiagram, green);
  assert.ok(p.some((x) => /init line differs/.test(x)) && p.some((x) => /classDef accent differs/.test(x)) && p.some((x) => /#FF5A00 is not in the theme/.test(x)));
  assert.match(diagramProblems(`${green.init}\nflowchart TB\n  style a fill:#FF5A00\n`, green)[0], /#FF5A00/);
  assert.deepEqual(diagramProblems(`${green.init}\nflowchart TB\n  a("label #FF5A00")\n  a:::accent\n`, green), [], "colours in labels are text");
});

test("diagramProblems: a diagram that carries none of its organisation's accent is refused (all white is not the brand)", () => {
  const green = parseTheme(themeInit(GREEN, FONT));
  const plain = applyTheme("flowchart TB\n  x --> y\n", green);
  assert.ok(diagramProblems(plain, green).some((x) => /carries none of the brand accent/.test(x)));
  assert.deepEqual(diagramProblems(applyTheme("flowchart TB\n  a:::accent --> b\n  class b accent\n", green), green), []);
  assert.deepEqual(diagramProblems(applyTheme("flowchart TB\n  a:::accent --> b\n", green), green), []);
  assert.ok(diagramProblems(applyTheme("flowchart TB\n  x --> y\n  %% x:::accent\n", green), green).some((p) => /carries none of the brand accent/.test(p)), "a comment is not a node (#122 delta review)");
});

test("PNG stamp: written before IEND, read back, replaced on re-stamp", () => {
  const a = stampPng(png(), "a".repeat(64));
  assert.equal(readStamp(a), "a".repeat(64));
  assert.equal(a.toString("latin1", a.length - 8, a.length - 4), "IEND");
  const b = stampPng(a, "b".repeat(64));
  assert.equal(readStamp(b), "b".repeat(64));
  assert.equal(b.length, a.length);
  assert.equal(readStamp(png()), null);
  assert.throws(() => readStamp(Buffer.from("nope")), /not a PNG/);
  const c = stampPng(a, "c".repeat(64), "kit.some.id");
  assert.equal(readStampId(c), "kit.some.id");
  assert.equal(readStamp(c), "c".repeat(64));
  assert.equal(readStampId(stampPng(c, "d".repeat(64), "kit.other")), "kit.other", "re-stamp replaces both chunks");
  assert.equal(readStampId(a), null);
});

test("mermaidBlocks finds fenced blocks, indented ones included", () => {
  const md = "x\n```mermaid\nflowchart TB\n```\n- item\n  ```mermaid\n  flowchart LR\n  ```\n```text\n%%{init: {}}%%\n```\n";
  assert.deepEqual(mermaidBlocks(md).map((b) => b.body), ["flowchart TB\n", "  flowchart LR\n"]);
});

test("checkRepo / kit diagrams check: pass when themed and stamped; fail on stale PNG, foreign theme, missing PNG", async () => {
  const H = (id) => `%% kit:diagram ${JSON.stringify({ id, title: "A diagram", project: "kit", kind: "other", lineage: { derives_from: [], supersedes: [], version: "1" }, relates_to: [], depicts: [], reviewed: "2026-10-06" })}`;
  const dir = repo(GREEN, { "kit.canon.json": '{"project":"kit"}', "docs/diagrams/a.mmd": `${H("kit.a")}\nflowchart TB\n  a:::accent --> b\n`, "README.md": `# x\n\n\`\`\`mermaid\n${H("kit.readme.1")}\nflowchart TB\n  a:::accent --> b\n\`\`\`\n` });
  let r = await main(["diagrams", "check"], io(dir));
  assert.equal(r, 1);
  const t = io(dir);
  assert.equal(await main(["diagrams", "theme"], t), 0);
  assert.deepEqual(t.o.slice(0, 2), ["  themed: docs/diagrams/a.mmd", "  themed: README.md"]);
  const src = readFileSync(join(dir, "docs/diagrams/a.mmd"), "utf8");
  assert.equal(src.split("\n")[1], H("kit.a"), "the header stays on the line after the init line");
  syncGenerated(dir);
  const ok = io(dir);
  assert.equal(await main(["diagrams", "check"], ok), 0, ok.e.join("\n"));
  assert.match(ok.o[0], /2 diagrams and 1 Markdown mermaid blocks/);
  // the source changes after the render: the PNG is older than its source
  writeFileSync(join(dir, "docs/diagrams/a.mmd"), `${src}  b --> c\n`);
  const stale = checkRepo(dir);
  assert.deepEqual(stale.problems.map((p) => p.problem), ["PNG is older than its source (rendered from a different source)"]);
  // another project's diagram pasted in
  writeFileSync(join(dir, "docs/diagrams/b.mmd"), `${themeInit(ORANGE, FONT).split("\n")[0]}\nflowchart TB\n`);
  const probs = checkRepo(dir).problems.map((p) => `${p.file}: ${p.problem}`);
  assert.ok(probs.includes("docs/diagrams/b.mmd: init line differs from the theme"));
  assert.ok(probs.some((p) => p.startsWith("docs/diagrams/b.mmd: no b.png")));
  // vendor/ belongs to another project and is skipped
  mkdirSync(join(dir, "vendor/kit"), { recursive: true });
  writeFileSync(join(dir, "vendor/kit/README.md"), "```mermaid\nflowchart TB\n```\n");
  assert.ok(!checkRepo(dir).problems.some((p) => p.file.startsWith("vendor/")));
});

test("kit diagrams check without theme.init names the file", async () => {
  const dir = join(TMP, "bare"); mkdirSync(dir);
  const c = io(dir);
  assert.equal(await main(["diagrams", "check"], c), 1);
  assert.match(c.e.join("\n"), /no docs\/diagrams\/theme\.init/);
});

const H = (id, over = {}) => `%% kit:diagram ${JSON.stringify({ id, title: "A diagram", project: "kit", kind: "other", lineage: { derives_from: [], supersedes: [], version: "1" }, relates_to: [], depicts: [], reviewed: "2026-10-06", ...over })}`;
/** A fake browser: what the page reports, and the picture the screenshot returns. */
function fakeBrowser(seen, { evaluate = { ok: true, width: 300, clipped: [] }, shot } = {}) {
  const fakePage = {
    async setContent(html) { seen.html = html; },
    async addScriptTag({ path }) { seen.script = path; },
    async evaluate(_fn, arg) { seen.arg = arg; return evaluate; },
    locator() { return { screenshot: async () => shot }; },
    async close() {},
  };
  return { chromium: { launch: async (o) => { seen.launch = o; return { newPage: async () => fakePage, close: async () => {} }; } } };
}
const diagramRepo = (colours = GREEN, body = "flowchart TB\n  a:::accent --> b\n") => {
  const dir = repo(colours, { "docs/diagrams/a.mmd": `${H("kit.a")}\nflowchart TB\n  a:::accent --> b\n` });
  applyThemeToRepo(dir);
  return dir;
};
const theme = (dir) => parseTheme(readFileSync(join(dir, THEME_FILE), "utf8"));

test("renderDiagrams: theme font loaded, background from the theme, identity footer from the header, PNG stamped (source, id, pixels, theme, footer)", async () => {
  const dir = diagramRepo();
  const seen = {}, th = theme(dir);
  const res = await renderDiagrams(dir, ["docs/diagrams/a.mmd"], th, { playwright: fakeBrowser(seen, { shot: themedPng(th) }), mermaidJs: "/m.js", chromium: "/chrome" });
  assert.deepEqual(res, [{ file: "docs/diagrams/a.mmd", ok: true }]);
  assert.deepEqual(seen.launch, { executablePath: "/chrome" });
  assert.match(seen.html, /@font-face\{font-family:"Brand Sans";src:url\(data:font\/truetype;base64,/);
  assert.match(seen.html, /background:#FAFAF7/);
  assert.match(seen.html, /font-family:Brand Sans, Arial, sans-serif/);
  assert.deepEqual(seen.arg.families, ["Brand Sans"]);
  assert.equal(seen.arg.lines[0].text, "kit.a");
  assert.match(seen.arg.lines.map((l) => l.text).join("\n"), /no lineage declared/);
  const out = readFileSync(join(dir, "docs/diagrams/a.png"));
  assert.equal(readStamp(out), sourceHash(readFileSync(join(dir, "docs/diagrams/a.mmd"), "utf8")));
  assert.equal(readStampId(out), "kit.a");
  assert.equal(checkRepo(dir).problems.length, 0);
});

test("render gates (the renderer's self-test): a diagram rendered without the theme fails, in every way it can", async () => {
  const dir = diagramRepo(), th = theme(dir);
  const run = async (opts, theme = th) => (await renderDiagrams(dir, ["docs/diagrams/a.mmd"], theme, { playwright: fakeBrowser({}, opts), mermaidJs: "/m.js" }))[0];
  // 1. a grey picture (default Mermaid look) never passes, nor does a picture without the accent the source asks for
  const grey = await run({ shot: themedPng(th, { colours: false }) });
  assert.equal(grey.ok, false);
  assert.match(grey.error, /does not carry the theme's background #FAFAF7/);
  // 2. the font: a fallback face is a failure, said plainly
  assert.match((await run({ evaluate: { ok: false, error: "font Brand Sans is not loaded: a fallback face would be drawn" }, shot: themedPng(th) })).error, /not loaded/);
  // 3. clipped text and a width over the phone limit
  assert.match((await run({ evaluate: { ok: true, width: 300, clipped: ["A long label"] }, shot: themedPng(th) })).error, /text is clipped in 1 place \("A long label"\)/);
  assert.match((await run({ evaluate: { ok: true, width: 3000, clipped: [] }, shot: themedPng(th) })).error, /3000 px wide, over the readable limit of 2400 px/);
  assert.match((await run({ evaluate: { ok: true, width: 800, height: 8859, clipped: [] }, shot: themedPng(th) })).error, /8859 px tall, over the readable limit of 2500 px/, "a 17718 px lineage column is refused (kit 2026-10-07)");
  // 4. a theme that defines no colour roles, no font or no classes cannot render at all
  const bare = parseTheme(`%%{init: {"theme":"base","themeVariables":{"fontFamily":"X, Arial"}}}%%\n`);
  await assert.rejects(() => renderDiagrams(dir, ["docs/diagrams/a.mmd"], bare, { playwright: fakeBrowser({}, {}), mermaidJs: "/m.js" }), /defines no background.*no classDef accent.*declares no font/s);
  // 5. a source without a header has no footer to draw
  writeFileSync(join(dir, "docs/diagrams/a.mmd"), `${th.init}\nflowchart TB\n  a:::accent --> b\n`);
  assert.match((await run({ shot: themedPng(th) })).error, /no kit:diagram header/);
});

test("kit diagrams render --file x.mmd --out dir: a scratch diagram goes through the same theme, header check and gates", async () => {
  const dir = diagramRepo();
  const scratch = join(TMP, `scratch${n++}`); mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "s.mmd"), `${H("kit.scratch.one")}\nflowchart TB\n  a:::accent --> b\n`);
  const noTheme = io(dir);
  assert.equal(await main(["diagrams", "render", "--file", join(scratch, "s.mmd"), "--out", scratch, "--playwright", "/nowhere", "--mermaid", "/nowhere.js"], noTheme), 1);
  const bad = io(dir);
  writeFileSync(join(scratch, "bad.mmd"), `${H("saasreport.wrong")}\nflowchart TB\n  a:::accent --> b\n`);
  assert.equal(await main(["diagrams", "render", "--file", join(scratch, "bad.mmd")], bad), 1);
  assert.match(bad.e.join("\n"), /project|id saasreport\.wrong/);
});

test("themeFromTokens / kit diagrams derive: theme.init from site tokens; --check guards it", async () => {
  const dir = join(TMP, "site"); mkdirSync(join(dir, "public/fonts"), { recursive: true });
  writeFileSync(join(dir, "public/fonts/Brand-400.woff2"), "x");
  const tokens = { color: { ...GREEN, surface: "#FFFFFF" }, font: { sans: "Brand", faces: [{ family: "Brand", weight: 700, src: "/fonts/Brand-700.woff2" }, { family: "Brand", weight: 400, src: "/fonts/Brand-400.woff2" }] } };
  const text = themeFromTokens(tokens, { root: dir, name: "Green Project", project: "kit" });
  const t = parseTheme(text);
  assert.deepEqual(t.fonts, [{ family: "Brand", path: "public/fonts/Brand-400.woff2" }]);
  assert.equal(t.classDefs.get("accent").split(",")[0], "fill:#167A42");
  assert.match(text, /Green Project: the diagram theme, derived from the brand tokens/);
  assert.throws(() => themeFromTokens({ color: {} }, { root: dir, project: "kit" }), /no color.accent/);
  writeFileSync(join(dir, "site.config.js"), `export default { name: "Green Project", tokens: ${JSON.stringify(tokens)} };\n`);
  const c = io(dir);
  assert.equal(await main(["diagrams", "derive", "--project", "kit", "--check"], c), 1);
  assert.equal(await main(["diagrams", "derive", "--project", "kit"], io(dir)), 0);
  assert.equal(readFileSync(join(dir, THEME_FILE), "utf8"), text);
  assert.match(text, /\n%% kit:theme \{"project":"kit"\}\n/);
  assert.equal(await main(["diagrams", "derive", "--check", "--project", "kit"], io(dir)), 0);
  assert.ok(existsSync(join(dir, THEME_FILE)));
});

test("kit diagrams: unknown subcommand", async () => {
  const c = io(TMP);
  assert.equal(await main(["diagrams", "paint"], c), 2);
  // the list is the command table's, the one source (a hand-copied list here broke when themes was added)
  assert.ok(c.e.join("\n").includes(`kit diagrams: unknown subcommand "paint" (one of ${COMMAND_TABLE.diagrams.join(", ")})`), c.e.join("\n"));
});

test("applyTheme adds the theme's classDef for a class the diagram uses but never defines (it would draw as a grey box)", () => {
  const th = parseTheme(themeInit(ORANGE, FONT));
  const out = applyTheme('flowchart TB\n  a("A") --> b("B")\n  class a accent\n', th);
  assert.match(out, /\n {2}classDef accent fill:#FF5A00,stroke:#FF5A00/);
  assert.doesNotMatch(out, /classDef muted/, "only the classes the diagram uses");
  assert.equal(applyTheme(out, th), out, "idempotent");
  assert.doesNotMatch(applyTheme("sequenceDiagram\n  A->>B: hi\n", th), /classDef/);
});
