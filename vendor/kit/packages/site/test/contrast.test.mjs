// Text contrast: the colour tokens meet WCAG AA for the pairs the theme uses (checkTokens → checkContrast), and the
// theme never paints accent text in the raw accent: --accent-text, which black surfaces set to accentOnDark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_TOKENS, resolveTokens, checkTokens, checkContrast, contrast, derivedColors, surfaces, ensureContrast, mix, WASHES, buildSite } from "../src/index.js";

const THEME = fileURLToPath(new URL("../theme/", import.meta.url));

test("contrast(): WCAG ratios", () => {
  assert.equal(contrast("#000000", "#FFFFFF").toFixed(0), "21");
  assert.equal(contrast("#777777", "#FFFFFF").toFixed(2), "4.48");
  assert.equal(contrast("#FFFFFF", "#777777"), contrast("#777777", "#FFFFFF"));
});

test("the default tokens pass every contrast pair", () => {
  assert.deepEqual(checkContrast(resolveTokens({})), []);
});

test("a dark accent shown as text on black fails; its light tint for dark surfaces passes", () => {
  // a deep purple brand: as text on the default black it is 1.90:1 (1.98:1 on the brand's #0B0B0B) (the stat numbers and "Used this month" the owner reported)
  const bad = resolveTokens({ color: { accent: "#6B2177", accentOnDark: "#6B2177" } });
  const p = checkContrast(bad);
  assert.ok(p.some((x) => x.startsWith("tokens.color.accentOnDark on ink: 1.90:1")), p.join("\n"));
  assert.ok(checkTokens(bad).some((x) => x.includes("accentOnDark on ink")), "checkTokens reports it (checkProject, every build)");
  assert.deepEqual(checkContrast(resolveTokens({ color: { accent: "#6B2177", accentOnDark: "#DDB0E6" } })), []);
});

test("accentEm: ink on a light accent, the on-ink colour on a dark one", () => {
  assert.equal(derivedColors({ ...DEFAULT_TOKENS.color, accent: "#FF5A00" }).accentEm, DEFAULT_TOKENS.color.ink);
  assert.equal(derivedColors({ ...DEFAULT_TOKENS.color, accent: "#6B2177" }).accentEm, DEFAULT_TOKENS.color.onInk);
});

test("the theme paints accent text through --accent-text; black surfaces set it to accentOnDark", () => {
  for (const f of readdirSync(THEME).filter((x) => x.endsWith(".css"))) {
    const css = readFileSync(THEME + f, "utf8");
    assert.doesNotMatch(css, /(?<![-\w])color:var\(--orange\)/, `${f}: accent text must use var(--accent-text)`);
    assert.doesNotMatch(css, /#76766F/i, `${f}: the faint text on black is the onInkFaint token`);
  }
  const styles = readFileSync(THEME + "styles.css", "utf8");
  assert.match(styles, /--accent-text:\{\{color\.accentText\}\}/, ":root: the text-safe accent (derivedColors accentText)");
  assert.match(styles, /\.section--deep,[^{]*\{\n[^\n]*--accent-text:\{\{color\.accentOnDark\}\}/, "black surfaces");
  assert.match(readFileSync(THEME + "terminal.css", "utf8"), /\.txs\{[^\n]*--accent-text:\{\{color\.accentOnDark\}\}/, "the terminal");
});

test("paintedContrast: translucent text and backgrounds are composited over what is behind them", async () => {
  const { paintedContrast } = await import("../src/index.js");
  // opaque: black on white is 21:1
  assert.equal(paintedContrast([0, 0, 0, 1], [[255, 255, 255, 1]]).ratio.toFixed(0), "21");
  // rgba text: 40% black on white is a mid grey, well below 21:1 and below AA
  const half = paintedContrast([0, 0, 0, 0.4], [[255, 255, 255, 1]]);
  assert.deepEqual(half.color, [153, 153, 153]);
  assert.ok(half.ratio < 4.5, String(half.ratio));
  // a translucent white panel over black: the panel is composited onto the black behind it, not read as white
  const panel = paintedContrast([255, 255, 255, 1], [[255, 255, 255, 0.06], [11, 11, 11, 1]]);
  assert.deepEqual(panel.background, [26, 26, 26]);
  assert.ok(panel.ratio > 15);
  // fully transparent layers are skipped; with none at all the canvas is white
  assert.deepEqual(paintedContrast([0, 0, 0, 1], [[0, 0, 0, 0]]).background, [255, 255, 255]);
});

// ---- root causes (2026-10-06, Acme contrast-qa): roles per surface, washes, specificity, the phone bar

test("dim is split by role: dimOnLight reaches AA on every light surface, dimOnDark on every black one", () => {
  // the brand grey #8C8C88 is 3.1:1 on the mock wash and 3.4:1 on white: the kit computes the role colours from it
  const t = resolveTokens({ color: { dim: "#8C8C88", ink: "#0B0B0B", bg: "#FAFAF7", sink: "#F3F2EE", dashBg: "#F7F7F4" } });
  const d = derivedColors(t.color), s = surfaces({ ...t.color, ...d });
  for (const x of s.dimOnLight) assert.ok(contrast(d.dimOnLight, x.hex) >= 4.5, `dimOnLight ${d.dimOnLight} on ${x.name}`);
  for (const x of s.dimOnDark) assert.ok(contrast(d.dimOnDark, x.hex) >= 4.5, `dimOnDark ${d.dimOnDark} on ${x.name}`);
  assert.deepEqual(checkContrast(t), []);
  // a project that sets a role itself gets exactly it, and a failing value fails the build (checkTokens, every build)
  const bad = resolveTokens({ color: { dimOnLight: "#8C8C88", dimOnDark: "#5A5A5A" } });
  const p = checkTokens(bad);
  assert.ok(p.some((x) => x.startsWith("tokens.color.dimOnLight on surface")), p.join("\n"));
  assert.ok(p.some((x) => x.startsWith("tokens.color.dimOnDark on ink")), p.join("\n"));
});

test("every wash is checked over every surface it is painted on: a role that passes over bg but fails over surface fails", () => {
  // a white page and grey cards: the accent text passes on its wash over the page (4.95:1) and fails on the same wash
  // over a card (4.38:1), which a check over bg alone would never see
  const t = resolveTokens({ color: { bg: "#FFFFFF", surface: "#E6E6E6", accent: "#636363", accentText: "#636363", accentTint: "#FFFFFF" } });
  const c = t.color;
  assert.ok(contrast(c.accentText, mix(c.accent, c.bg, 0.08)) >= 4.5 && contrast(c.accentText, mix(c.accent, c.surface, 0.08)) < 4.5);
  const p = checkContrast(t).filter((x) => x.startsWith("tokens.color.accentText"));
  assert.ok(p.length && p.every((x) => / over surface: /.test(x)), p.join("\n"));
  assert.match(p[0], /^tokens\.color\.accentText on wash:accent over surface: 4\.38:1/);
  // the map that the check composites is the one the theme reads its opacities from
  const styles = readFileSync(THEME + "styles.css", "utf8");
  assert.match(styles, /\.eyebrow\{[^}]*background:color-mix\(in srgb,\{\{color\.accent\}\} \{\{wash\.accent\}\}%,transparent\)/);
  assert.match(styles, /\.badge--live\{background:color-mix\(in srgb,\{\{color\.ok\}\} \{\{wash\.ok\}\}%,transparent\)/);
  for (const [k, w] of Object.entries(WASHES)) assert.ok(w.over.includes("surface") && w.over.includes("bg"), `${k} is painted on cards and on the page`);
});

test("accentText: a light accent (orange) is darkened for text on light surfaces and its washes; a dark one is kept", () => {
  const orange = derivedColors(resolveTokens({ color: { accent: "#FF5A00", accentTint: "#FFF1E8" } }).color);
  assert.notEqual(orange.accentText, "#FF5A00");
  assert.ok(contrast(orange.accentText, mix("#FF5A00", DEFAULT_TOKENS.color.bg, 0.14)) >= 4.5);
  assert.equal(derivedColors(resolveTokens({ color: { accent: "#6B2177", accentTint: "#F6EEF7" } }).color).accentText, "#6B2177");
  assert.ok(checkContrast(resolveTokens({ color: { accentText: "#FF5A00" } })).some((x) => x.startsWith("tokens.color.accentText on")));
});

test("status colours are checked on their own washes (badges, lab chips): the old default green fails, the new passes", () => {
  const p = checkContrast(resolveTokens({ color: { ok: "#15803D" } }));
  assert.ok(p.some((x) => x.startsWith("tokens.color.ok on wash:ok over")), p.join("\n"));
  assert.deepEqual(checkContrast(resolveTokens({})), []);
});

test("ensureContrast and mix: the first colour along the way that passes; unchanged when it already does", () => {
  assert.equal(mix("#000000", "#FFFFFF", 0.5), "#808080");
  assert.equal(ensureContrast("#111111", ["#FFFFFF"], 4.5, "#000000"), "#111111");
  const x = ensureContrast("#AAAAAA", ["#FFFFFF"], 4.5, "#000000");
  assert.ok(contrast(x, "#FFFFFF") >= 4.5 && contrast(x, "#FFFFFF") < 4.8, x);
});

test("the theme shows tertiary text only through --dim, which each surface sets to its role; no raw dim or #151515", () => {
  for (const f of readdirSync(THEME).filter((x) => x.endsWith(".css"))) {
    const css = readFileSync(THEME + f, "utf8");
    assert.doesNotMatch(css, /\{\{color\.dim\}\}/, `${f}: use var(--dim) (dimOnLight / dimOnDark by surface)`);
    assert.doesNotMatch(css, /#151515/i, `${f}: the raised black surface is the inkRaised token`);
  }
  const styles = readFileSync(THEME + "styles.css", "utf8"), showcase = readFileSync(THEME + "showcase.css", "utf8");
  assert.match(styles, /--dim:\{\{color\.dimOnLight\}\}/, ":root");
  assert.match(styles, /\.section--deep,[^{]*\{\n[^\n]*--dim:\{\{color\.dimOnDark\}\}/, "black surfaces");
  assert.match(showcase, /\.pg__res,[^{]*\{--accent-text:\{\{color\.accentOnDark\}\};--dim:\{\{color\.dimOnDark\}\}\}/, "the showcase's black panels");
});

test("an eyebrow keeps its own colour and size inside section heads, inner-page heroes and the brand teaser", () => {
  const styles = readFileSync(THEME + "styles.css", "utf8"), terminal = readFileSync(THEME + "terminal.css", "utf8");
  // a <p class="eyebrow"> in a .sec-head was painted muted (0,1,1 beats .eyebrow's 0,1,0): 4.44:1 on its wash
  for (const [css, sel] of [[styles, ".sec-head p"], [styles, ".brand-teaser p"], [terminal, ".tpage .hero-t p"]]) {
    assert.ok(css.includes(`${sel}:not(.eyebrow){`), `${sel} leaves the eyebrow alone`);
    assert.ok(!css.includes(`${sel}{`), `${sel} without :not(.eyebrow)`);
  }
});

test("the phone mockup: the status bar is inside the display (the screen's colour), not over the black bezel", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/sections/index.js", import.meta.url)), "utf8");
  assert.match(src, /<div class="phone__display"><div class="phone__status">[^\n]*<div class="phone__screen" data-screen><\/div><\/div><\/div>/);
  assert.match(readFileSync(THEME + "showcase.css", "utf8"), /\.phone__display\{[^}]*background:var\(--warm\)/);
});

test("every solid tone fill has a derived text role: AA on chart1..6, ok, warn, err and muted, ink where white fails", () => {
  const t = resolveTokens({ color: { accent: "#FF5A00", accentPress: "#E65100" } });
  const c = { ...t.color, ...derivedColors(t.color) };
  for (const [fill, on] of [["ok", "onOk"], ["warn", "onWarn"], ["err", "onErr"], ["muted", "onMuted"], ["accent", "onAccent"], ...[1, 2, 3, 4, 5, 6].map((n) => [`chart${n}`, `onChart${n}`])]) {
    assert.ok(contrast(c[on], c[fill]) >= 4.5, `${on} ${c[on]} on ${fill} ${c[fill]} = ${contrast(c[on], c[fill]).toFixed(2)}`);
  }
  assert.notEqual(c.onChart2, c.onInk, "white on chart-2 (3.5:1) is not used: the text colour is derived per fill");
  assert.deepEqual(checkContrast(t), [], "the pairs are part of the build's contrast gate");
});

test("toneStyle names the fill and its derived text colour; a name without a derived role is an error", async () => {
  const { toneStyle, colorRoles } = await import("../src/tokens.js");
  const hex = colorRoles(resolveTokens({}).color);
  assert.equal(toneStyle(hex, "chart2"), "--c:var(--c-chart-2);--on-c:var(--c-on-chart-2)");
  assert.equal(toneStyle(hex, "var(--c-ok)"), "--c:var(--c-ok);--on-c:var(--c-on-ok)");
  assert.throws(() => toneStyle(hex, "inkRaised"), /unknown tone/);
});

// ---- review of #115 (M1, round 2): the gate fails closed. A role or a surface that resolves to nothing is a finding, never a pair that disappears.
// The expectations come from the declared lists (the token defaults, TEXT_ON, UI_ON, WASHES), not from the code that judges.
test("checkContrast: removing ANY base token of the theme, in turn, is a finding that names it (it used to return [] and every pair on it vanished)", () => {
  const base = resolveTokens({}).color;
  assert.deepEqual(checkContrast({ color: base }), [], "the complete theme is clean");
  const keys = Object.keys(DEFAULT_TOKENS.color);
  assert.ok(keys.length > 30, "the declared list is the whole token set");
  for (const k of keys) {
    const p = checkContrast({ color: Object.fromEntries(Object.entries(base).filter(([x]) => x !== k)) }, "t");
    assert.ok(p.some((x) => x.startsWith(`t.color.${k}: no colour`)), `${k} removed: ${p.join(" | ") || "silently passes"}`);
    assert.equal(p.filter((x) => x.startsWith(`t.color.${k}:`)).length, 1, `${k}: named once`);
  }
});

test("contrastPairs / contrastGaps: every text role, every surface and every wash colour removed in turn, plus an unknown wash, is a gap; contrastPairs throws instead of returning a pair list that is short", async () => {
  const { contrastPairs, contrastGaps, TEXT_ON, UI_ON, WASHES, surfaceSlots } = await import("../src/index.js");
  const base = resolveTokens({}).color;
  const full = { ...base, ...derivedColors(base) };
  assert.deepEqual(contrastGaps(full), [], "the complete theme has no gap");
  const pairs = contrastPairs(full);
  assert.ok(pairs.length > 80 && pairs.every((x) => x.length === 6 && /^#[0-9a-f]{6}$/i.test(x[4])), "every pair resolves to a surface colour");
  const lists = { ...TEXT_ON, ...UI_ON };
  const textRoles = [...Object.keys(lists), "accentEm"];
  const surfaceNames = [...new Set(Object.values(lists).flat())];
  const plain = surfaceNames.filter((n) => !n.startsWith("wash:"));
  const washes = surfaceNames.filter((n) => n.startsWith("wash:"));
  assert.ok(textRoles.length > 20 && plain.length >= 8 && washes.length >= 2, `declared: ${textRoles.length} roles, ${plain.length} surfaces, ${washes.length} washes`);
  const removed = (k) => Object.fromEntries(Object.entries(full).filter(([x]) => x !== k));
  const expectGap = (c, token, what) => {
    assert.ok(contrastGaps(c).some((g) => g.token === token), `${what}: gap on ${token}`);
    assert.throws(() => contrastPairs(c), (e) => e.gaps?.some((g) => g.token === token) && new RegExp(`no colour for: .*${token}`).test(e.message), `${what}: contrastPairs throws naming ${token}`);
  };
  for (const r of textRoles) expectGap(removed(r), r, `text role ${r} removed`);
  for (const n of plain) expectGap(removed(n), n, `surface ${n} removed`);
  for (const w of washes) {
    const def = WASHES[w.slice(5)];
    assert.ok(def, `${w} is a declared wash`);
    for (const t of [def.colour, ...def.over]) expectGap(removed(t), t, `${w}: ${t} removed`);
  }
  assert.deepEqual(surfaceSlots(full, "wash:nope").map((x) => [x.name, x.hex, x.token]), [["wash:nope", undefined, "wash:nope"]], "an unknown wash resolves to nothing, named");
  const saved = TEXT_ON.onInk;
  TEXT_ON.onInk = [...saved, "wash:nope"];
  try { expectGap(full, "wash:nope", "an unknown wash in a declared list"); } finally { TEXT_ON.onInk = saved; }
});


test("the terminal shell paints an explicit on-ink foreground on the ink surface in every locale", () => {
  const css = readFileSync(THEME + "terminal.css", "utf8");
  assert.match(css, /\.txs\{border:[^\n]+background:\{\{color\.ink\}\};color:\{\{color\.onInk\}\}/,
    "do not inherit the page's light --text role on the black terminal surface");
  const c = resolveTokens({}).color;
  assert.ok(contrast(c.onInk, c.ink) >= 4.5, "terminal foreground and painted background must meet WCAG AA");
});

test("terminal shell preserves on-ink contrast even when a host page supplies a conflicting text colour", () => {
  const css = readFileSync(THEME + "terminal.css", "utf8");
  // The initial selector paints the role pair before any nested control inherits
  // --text. Both declarations use site tokens, never fixed brand literals.
  assert.match(css, /\.txs\{background:\{\{color\.ink\}\}!important; color:\{\{color\.onInk\}\}!important;/);
  const c = resolveTokens({}).color;
  assert.ok(contrast(c.ink, c.onInk) >= 4.5);
});
