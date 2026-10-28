import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read=(path)=>readFileSync(new URL("../../site/theme/"+path,import.meta.url),"utf8");
test("component overlays inherit the actual foreground role of the background they paint",()=>{
  const styles=read("styles.css"), showcase=read("showcase.css"), content=read("content.css");
  const terminal=read("terminal.css"), notify=read("notify.css");
  assert.match(styles,/\.vflow li\.on::before\{background:var\(--black\);border-color:var\(--black\);color:\{\{color\.onInk\}\}/);
  assert.match(styles,/\.code__copy:hover\{color:\{\{color\.onInk\}\}/);
  assert.match(styles,/\.f input,\.f select,\.f textarea\{width:100%;background:\{\{color\.surface\}\};color:\{\{color\.ink\}\}/);
  assert.match(showcase,/\.pg__res \.seg button\[aria-selected="true"\] b\{color:\{\{color\.onAccent\}\}/);
  assert.match(content,/\.rx__like\[aria-pressed="true"\] b\{color:\{\{color\.onAccent\}\}/);
  assert.match(terminal,/\.tphone \.notif\{background:\{\{color\.surface\}\};color:\{\{color\.ink\}\}/);
  assert.match(terminal,/\.ask \.tv-row \.btn:disabled\{color:\{\{color\.onInk\}\};background:\{\{color\.inkRaised\}\};border-color:\{\{color\.onInkMuted\}\}/);
  assert.match(notify,/\.ntf__btn--ghost\{background:transparent;color:\{\{color\.onInk\}\}/);
});
