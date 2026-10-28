import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("datepicker text has a separate contrast-safe token, never the decorative orange accent", () => {
  const css=readFileSync(new URL("../../site/theme/datepicker.css",import.meta.url),"utf8");
  assert.match(css,/--dp-orange:var\(--orange,\{\{color\.accent\}\}\); --dp-accent-text:\{\{color\.accentText\}\}/);
  assert.equal(css.split("--dp-accent-text:{{color.accentOnDark}};").length-1,2,
    "forced/OS dark palettes both use dark-safe contrast text");
  assert.match(css,/\.{{picker\.prefix}}\.{{picker\.prefix}}--light\{\s*--dp-accent-text:\{\{color\.accentText\}\}/);
  assert.match(css,/__wk span\.is-off\{color:var\(--dp-accent-text\)\}/);
  assert.match(css,/__d\.is-hol b,\.{{picker\.prefix}}__d\.is-pred b\{color:var\(--dp-accent-text\)\}/);
  assert.match(css,/__chip\.c-hol\{color:var\(--dp-accent-text\)\}/);
  assert.match(css,/__chip\.c-pred\{color:var\(--dp-accent-text\);/);
  // Borders, icon nodes and the solid selected-day background keep the user's
  // actual accent, but text is checked independently on its rendered surface.
  assert.match(css,/__node\{[^}]*background:var\(--dp-orange\)/);
});
