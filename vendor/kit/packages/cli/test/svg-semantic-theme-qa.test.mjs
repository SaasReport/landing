import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = file => readFileSync(new URL(file, import.meta.url),"utf8");
test("stroke-only SVG paths and lines do not become invented text in neutral QA",()=>{
 const qa=read("../src/theme-qa.js"),net=read("../../widgets/theme/plugins/network.css");
 const netting=read("../../widgets/theme/plugins/netting.css"),split=read("../../widgets/theme/plugins/split.css");
 assert.match(qa,/path\|line\|polyline\|polygon\|rect\|circle\|ellipse\|svg\|g/);
 assert.match(net,/path\.kw-net__edge\.is-down/);
 assert.match(netting,/line\.kw-net-mesh/);
 assert.match(netting,/line\.kw-net-spoke/);
 assert.match(split,/path\.kw-split__band/);
 assert.match(net,/\.kw-net__node\.is-down\{opacity:1;border-style:dashed\}/);
 assert.match(net,/\.kw-net__flow\.is-dim\{opacity:1;border-style:dashed;color:var\(--kw-ink\)\}/);
});
test("visible status text and checklist checks consume matching canonical background text roles",()=>{
 const css=read("../../widgets/theme/widgets.css");
 for(const [tone,on] of [["ok","onOk"],["warn","onWarn"],["err","onErr"],["brand","onAccent"]]){
   assert.ok(css.includes('--kw-on-t:{{color.'+on+'}}'),tone);
 }
 assert.match(css,/kw-scene__dot::after\{[^}]*color:var\(--kw-on-t,var\(--kw-on-accent\)\)/);
 assert.match(css,/kw-sm__state\[data-kind="initial"\] b::before\{[^}]*color:var\(--kw-accent-text\)/);
});
