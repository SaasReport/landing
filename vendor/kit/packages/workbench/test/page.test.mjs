// The `workbench` page type of @saasreport/site: the page builds from a widgets.generated.json export, the script and the
// theme are generated with it, and the document is ordered for streaming (everything a crawler needs before any pane).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSite, checkProject } from "../../site/src/index.js";
import sample from "../../../examples/site-sample/site.config.js";

const gen = JSON.parse(readFileSync(fileURLToPath(new URL("./fixture/widgets.generated.json", import.meta.url)), "utf8"));
const project = { ...sample, locales: [{ code: "fa" }], content: { fa: sample.content.fa ?? sample.content.en }, pages: [{ type: "workbench", path: "/workbench/", generated: gen, content: { fa: { bar: [{ href: "/", label: "x" }] } } }], assets: undefined, menu: undefined };
test("the page builds, with its script and theme", () => {
  assert.deepEqual(checkProject(project), []);
  const { files } = buildSite(project, { root: fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url)) });
  assert.ok(files["workbench/index.html"], Object.keys(files).join(", "));
  assert.ok(files["workbench.js"].includes("globalThis.KitWorkbench") && files["workbench.css"].includes(".wb-badge"));
  assert.ok(!/\{\{/.test(files["workbench.css"]), "every theme placeholder is filled");
  const html = files["workbench/index.html"], at = (s) => html.indexOf(s);
  for (const need of ['rel="canonical"', 'application/ld+json', "<h1>", 'data-wb-input', "<nav", 'src="/workbench.js'].map((x) => [x, at(x)])) assert.ok(need[1] > 0, `${need[0]} is in the document`);
  const firstPane = at('data-pane="');
  for (const early of ['rel="canonical"', "application/ld+json", "<h1>", "data-wb-input", "<nav", "<title>"]) assert.ok(at(early) < firstPane, `${early} comes before the first pane`);
  assert.ok(firstPane < at('id="wb-data"') && at('id="wb-data"') < at('src="/workbench.js'), "panes, then the data, then the script");
  assert.ok(firstPane < 14000, `the first pane starts inside the first 14 kB (${firstPane}): shell and heading flush first`);
  assert.match(html, /"@type":"WebApplication"/);
  assert.ok(!/\son[a-z]+=/i.test(html), "no inline handlers");
});
test("a project without the workbench export fails its check", () => {
  const bad = { ...project, pages: [{ ...project.pages[0], generated: { ...gen, exports: {} } }] };
  assert.ok(checkProject(bad).some((p) => /no workbench export/.test(p)));
});
