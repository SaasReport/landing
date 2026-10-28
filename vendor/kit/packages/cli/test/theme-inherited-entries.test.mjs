import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { themeEntries, kitEntries } from "../src/theme-entries.js";
import { THEME_CSS, readTheme } from "@saasreport/site";

test("only Kit's actual templates may inherit its contrast declarations", () => {
  const file=THEME_CSS.find(p=>kitEntries().some(e=>e.file===p));
  assert.ok(file);
  const derived=themeEntries([{file:"project/styles.css",text:readTheme(file)}]);
  assert.ok(derived.length>0);
  assert.ok(derived.every(e=>e.inheritedFromKit===true&&e.file==="project/styles.css"));
  assert.deepEqual(themeEntries([{file:"project/custom.css",text:".x{color:red}"}]),[]);
});
test("dormant upstream declarations are recorded while stale project exemptions fail",()=>{
  const src=readFileSync(new URL("../src/visual-qa.js",import.meta.url),"utf8");
  assert.match(src,/if \(e\.inheritedFromKit === true\)/);
  assert.match(src,/Kit theme case not exercised in this site/);
  assert.match(src,/stale contrast entry of canon\.allow\.json/);
});
