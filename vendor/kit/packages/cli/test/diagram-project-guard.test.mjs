// A diagram of one project can never be drawn in another project's colours. Root cause: the header's project picks the theme, but
// nothing tied the project to what the diagram depicts, so a diagram of another project's repository labelled project "kit" was
// drawn in the kit's theme. The check: a header whose depicts point into another registered project's repository is refused;
// render --file refuses a project whose theme is not vendored in this repository's colours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/index.js";
import { themeInit, applyThemeToRepo, THEME_FILE } from "../src/diagrams.js";
import { foreignProjectRefs } from "../src/diagram-themes.js";
import { headerLine } from "../src/diagram-header.js";
import { checkDiagrams } from "../src/diagram-lineage.js";
import { syncGenerated, header } from "./diagram-fixtures.mjs";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const COLORS = { ink: "#0B0B0B", rail: "#B8B8B8", railDark: "#5A5A5A", bg: "#FAFAF7", sink: "#F3F2EE", accent: "#FF5A00", accentTint: "#FFF1E8", onAccent: "#FFFFFF", surface: "#FFFFFF" };
const FONT = { family: "Brand Sans", path: "fonts/brand.ttf" };
const body = "flowchart TB\n  a(\"A\"):::accent --> b(\"B\")\n";
const TMP = fileTempDir("kit-project-guard-");
let n = 0;

function kitRepo(diagrams = {}) {
  const dir = join(TMP, `r${n++}`);
  mkdirSync(join(dir, "docs/diagrams"), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "fonts/brand.ttf"), "x");
  writeFileSync(join(dir, THEME_FILE), themeInit(COLORS, FONT, [], { project: "kit" }));
  writeFileSync(join(dir, "kit.canon.json"), '{"project":"kit"}');
  writeFileSync(join(dir, "README.md"), "x");
  for (const [stem, h] of Object.entries(diagrams)) writeFileSync(join(dir, `docs/diagrams/${stem}.mmd`), `${headerLine(h)}\n${body}`);
  applyThemeToRepo(dir);
  syncGenerated(dir);
  return dir;
}
const io = (cwd) => { const out = [], err = []; return { cwd, out: (s) => out.push(s), err: (s) => err.push(s), env: {}, o: out, e: err }; };
const dep = (ref, path = "README.md") => [{ kind: "doc", ref, path }];
const probs = (dir) => checkDiagrams(dir).problems.map((p) => `${p.file}: ${p.problem}`);

test("must fail: a diagram labelled kit that depicts another project's repository (it would be drawn in the kit's colours)", () => {
  const dir = kitRepo({ q: header("kit.q", { depicts: dep("SaasReport/core run queue") }) });
  const p = probs(dir);
  assert.ok(p.some((x) => /depicts\[0\]\.ref "SaasReport\/core run queue" points into SaasReport\/core, a repository of project saasreport, but the header's project is kit/.test(x)), p.join("\n"));
});

test("must fail: any repository of the org, not only the registered ones, and a path or an https parent", () => {
  assert.equal(foreignProjectRefs(header("kit.a", { depicts: dep("x", "SaasReport/core/openapi.yaml") })).at(0).project, "saasreport");
  assert.equal(foreignProjectRefs(header("kit.a", { lineage: { derives_from: ["https://github.com/SaasReport/landing/blob/main/x.mmd"], supersedes: [], version: "1" } })).at(0).repo, "SaasReport/landing");
  assert.equal(foreignProjectRefs(header("alpha.a", { project: "alpha", depicts: dep("SaasReport/app page") })).at(0).project, "saasreport");
});

test("must pass: a saasreport diagram depicting its own repositories, and kit diagrams depicting the kit's own paths (the run queue)", () => {
  assert.deepEqual(foreignProjectRefs(header("saasreport.a", { project: "saasreport", depicts: dep("SaasReport/landing theme") })), []);
  assert.deepEqual(foreignProjectRefs(header("kit.q", { depicts: dep("fleet run queue, example: a downstream app commit chain", "packages/cli") })), []);
  const dir = kitRepo({ q: header("kit.q", { depicts: dep("the fleet run queue (a downstream app commit chain is its example)", "README.md") }) });
  assert.deepEqual(probs(dir), []);
});

test("must fail: render --file with a header whose depicts point into another project's repository", async () => {
  const dir = kitRepo();
  const f = join(dir, "q.mmd");
  writeFileSync(f, `${headerLine(header("kit.q", { depicts: dep("SaasReport/core flows") }))}\n${body}`);
  const c = io(dir);
  assert.equal(await main(["diagrams", "render", "--file", f, "--out", dir], c), 1);
  assert.match(c.e.join("\n"), /points into SaasReport\/core, a repository of project saasreport/);
});

test("must fail: render --file in a kit repository with a header project whose theme is not vendored is refused, never drawn in the repository's colours", async () => {
  const dir = kitRepo();
  const f = join(dir, "o.mmd");
  writeFileSync(f, `${headerLine(header("saasreport.o", { project: "saasreport" }))}\n${body}`);
  const c = io(dir);
  assert.equal(await main(["diagrams", "render", "--file", f, "--out", dir], c), 1);
  assert.match(c.e.join("\n"), /project saasreport is registered but has no vendored theme.*never drawn in another project's colours/);
});
