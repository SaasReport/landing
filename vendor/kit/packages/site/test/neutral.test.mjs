// Shared components carry no project's names or colours: the theme reads them from tokens, defaults keep the old values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCss, readTheme } from "../src/css.js";
import { resolveTokens } from "../src/tokens.js";
import { renderAsset } from "../src/assets.js";

const locale = { counter: "decimal", arrow: new Proxy({}, { get: () => "→" }), dir: "rtl", strings: new Proxy({}, { get: () => "x" }) };
const css = (file, tokens) => renderCss(readTheme(file), { file, tokens: resolveTokens(tokens), locale, name: "X" });

test("defaults keep the previous values (status colours, picker names, notification motion)", () => {
  assert.match(css("styles.css", {}), /--c-on-dark-warn:#F5A524;/);
  assert.match(css("styles.css", {}), /--st-warn:var\(--c-on-dark-warn\)/);
  assert.match(css("datepicker.css", {}), /^kit-date-picker\{/m);
  assert.match(css("notify.css", {}), /transition:opacity 220ms cubic-bezier\(\.2,\.7,\.2,1\)/);
});

test("a project's tokens replace every one of them", () => {
  const t = { color: { onDarkWarn: "#F7A8BE", onInk: "#FFF8EE", onInkMuted: "#E3D6DF", onInkDim: "#CBBFC5", inkTrack: "#4E1746" },
    motion: { ui: "240ms", easing: "ease" }, picker: { tag: "x-date-picker", prefix: "xdp" } };
  for (const f of ["styles.css", "showcase.css", "terminal.css"]) assert.doesNotMatch(css(f, t), /#F5A524|245,165,36/i, f);
  const dp = css("datepicker.css", t);
  assert.doesNotMatch(dp.split("\n").slice(1).join("\n"), /saasreport/); assert.match(dp, /^x-date-picker\{/m); assert.match(dp, /\.xdp__d/);
  const n = css("notify.css", t);
  assert.doesNotMatch(n, /#D8D8D4|#A6A6A2|#3A3A3A|\.22s/); assert.match(n, /240ms ease/);
});

test("notify.js: limits and timings from data, defaults otherwise", () => {
  const base = { name: "X", ns: { global: "X", key: "x" } };
  const def = renderAsset("notify.js", { strings: { fa: { text: ["", "a", "b", "c", "d", "e", "f"] } } }, base, { code: "fa" });
  assert.match(def, /const MAX = 4;/); assert.match(def, /: 5200\)/);
  const own = renderAsset("notify.js", { strings: { fa: { text: ["", "a", "b", "c", "d", "e", "f"] } }, data: { max: 3, timeout: 6000, exitMs: 240 } }, base, { code: "fa" });
  assert.match(own, /const MAX = 3;/); assert.match(own, /: 6000\)/); assert.match(own, /reduce \? 0 : 240\)/);
});
