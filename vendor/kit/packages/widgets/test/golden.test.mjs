// Golden: the engine's output for existing archetypes is byte-identical across the plugin refactor and later additions.
// The goldens were captured from the engine before archetypes became plugins (generated JSON and static HTML per locale);
// only the engine's own version string may differ (it names the package version, bumped when archetypes are added).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildWidgets, renderWidgetsBody } from "../src/index.js";

const T = fileURLToPath(new URL("./", import.meta.url));
const read = (f) => readFileSync(T + f, "utf8");
const norm = (s) => s.replace(/@saasreport\/widgets \d+\.\d+\.\d+/g, "@saasreport/widgets X");
const CASES = [["fixture", "fixture/widgets.spec.json"], ["fixture-all", "fixture-all/widgets.spec.json"], ["workbench", "../../workbench/test/fixture/widgets.spec.json"]];

for (const [name, spec] of CASES) {
  test(`golden ${name}: generated JSON and static HTML (every locale) are byte-identical to the pre-plugin engine`, async () => {
    const r = await buildWidgets(T + spec);
    assert.equal(norm(r.json), norm(read(`golden/${name}.generated.json`)), `${name}: generated JSON changed`);
    for (const l of r.generated.locales) assert.equal(renderWidgetsBody(r.generated, l.code), read(`golden/${name}.${l.code}.html`), `${name}.${l.code}: HTML changed`);
  });
}
