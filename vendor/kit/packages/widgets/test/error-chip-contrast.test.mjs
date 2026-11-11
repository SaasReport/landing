import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../theme/widgets.css", import.meta.url), "utf8");
test("pressed error chips never paint error-red text on dark ink", () => {
  assert.match(css, /\.kw-chip\[data-fails\]\{border-color:var\(--kw-err\);color:var\(--kw-err\)\}/);
  assert.match(css, /\.kw-chip\[data-fails\]\[aria-pressed="true"\]\{color:var\(--kw-surface\)\}/);
  const selected = css.indexOf('.kw-chip[data-fails][aria-pressed="true"]');
  assert.ok(selected > css.indexOf('.kw-chip[data-fails]{'), "selected-state override must follow general error role");
  assert.ok(selected > css.indexOf('.kw-chip[aria-pressed="true"]{'), "error pressed override must follow selected background");
});
