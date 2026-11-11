import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src=(relative)=>readFileSync(new URL(relative,import.meta.url),"utf8");
test("each semantic text role follows the surface that paints behind it",()=>{
 const css=src("../../site/theme/styles.css");
 const shell=src("../../site/src/shell-markup.js");
 const kit=src("../../cloudflare/assets/kit.css");
 const darkSurface = css.split("/* black surfaces */")[1]?.split("/* orange surfaces")[0] || "";
 assert.match(darkSurface,/(?:^|\n)\s*color:var\(--text\);/, "dark scopes must resolve their inherited foreground, not only override tokens");
 assert.match(css,/\.hero,\.final\{--text:\{\{color\.onAccent\}\}; --muted:\{\{color\.onAccent\}\}; --accent-text:\{\{color\.onAccent\}\};/);
 assert.match(css,/\.mock\{--surface:\{\{color\.surface\}\};--text:var\(--black\);--muted:var\(--gray\);--accent-text:\{\{color\.accentText\}\};/);
 assert.match(css,/\.f \.err\{font-size:12\.5px;color:var\(--st-err\)\}/);
 assert.match(css,/\.lc__tabs button\{[^}]*color:var\(--text\)/);
 assert.match(shell,/\.kshell__sections a\.on\{color:var\(--accent-text,var\(--c-accent-text,var\(--orange,var\(--accent\)\)\)\);font-weight:700\}/);
 assert.match(kit,/\.chip small\{color:inherit;opacity:1\}/);
});
