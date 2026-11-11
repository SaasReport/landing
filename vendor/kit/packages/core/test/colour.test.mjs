// The colour derivation lives in ONE package (@saasreport/core/colour); the site re-exports it, the emails call it, and every list of
// fill roles (the gates, the directory's categories, the schema) is the one registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "../src/colour.js";

const TOKENS = { accent: "#FF5A00", ink: "#0B0B0B", onInk: "#FFFFFF", muted: "#6B6B6B", ok: "#127436", warn: "#A24A08", err: "#B91C1C", bg: "#FAFAF7", surface: "#FFFFFF", sink: "#F0EFE8", dashBg: "#F4F3EE", accentTint: "#FFF1E8", dim: "#8A8A85", onInkFaint: "#8E8E89", line2: "#9A9A94", railDark: "#5C5C5C", rail: "#B8B8B8", inkRaised: "#1A1A1A", accentOnDark: "#FF8A4D", black: "#000000", chartBase1: "#0072B2", chartBase2: "#DD6611", chartBase3: "#8800FF", chartBase4: "#774444", chartBase5: "#888899", chartBase6: "#AA0000" };

test("the site re-exports the derivation, it does not copy it", async () => {
  const site = await import("@saasreport/site");
  for (const k of ["derivedColors", "fillOn", "mix", "contrast", "ensureContrast", "TEXT_ON", "TONES", "FILL_ROLES", "CATEGORY_ROLES", "SURFACE_ROLES"]) assert.equal(site[k], core[k], `${k} is the core's`);
});

test("every tone in the registry has its on-role derived by fillOn, and TEXT_ON judges it on that fill", () => {
  const d = core.derivedColors(TOKENS);
  for (const [fill, on] of Object.entries(core.TONES)) {
    if (on === "onInk") continue;   // a token
    const bg = d[fill] || TOKENS[fill];
    assert.ok(core.TEXT_ON[on], `${on} is a TEXT_ON role`);
    // computed, not compared with the function that derives it: the text on every tone fill is AA
    assert.ok(core.contrast(d[on] ?? TOKENS[on], bg) >= 4.5, `${on} ${d[on]} on ${fill} ${bg}: ${core.contrast(d[on] ?? TOKENS[on], bg).toFixed(2)}:1`);
  }
});

test("pillBorder is the accent washed into the surface, never a white literal: a dark surface gives a dark border", () => {
  assert.equal(core.derivedColors(TOKENS).pillBorder, core.mix(TOKENS.accent, TOKENS.surface, 0.27));
  assert.equal(core.derivedColors({ ...TOKENS, surface: "#101010" }).pillBorder, core.mix(TOKENS.accent, "#101010", 0.27));
});

test("the directory schema's colour roles, the category roles and the registry are one list", () => {
  const find = (o) => (o && typeof o === "object" ? (o.colorRole?.enum ? o.colorRole.enum : Object.values(o).map(find).find(Boolean)) : null);
  for (const file of ["directory.schema.json", "directory-v2.schema.json"]) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
    assert.deepEqual([...find(schema)].sort(), [...core.CATEGORY_ROLES].sort(), `${file} must match the canonical role registry`);
  }
  for (const r of core.CATEGORY_ROLES) assert.ok(core.FILL_ROLES.includes(r), r);
});

test("no package source writes a white or black literal for a derivation (the literals are the token defaults: black and chartBase1-6 included)", () => {
  const src = readFileSync(new URL("../src/colour.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/["']#(fff|ffffff)["']/i.test(src));
  assert.ok(!/["']#[0-9a-f]{6}["']/i.test(src), "colour.js holds no colour literal at all: the black and the chart bases are tokens");
});

test("one contrast formula: no package writes the WCAG luminance coefficients but @saasreport/core/colour (the gates that run in a page are given its source)", async () => {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const root = new URL("../../", import.meta.url);
  const hits = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(new URL(`${e.name}/`, dir))) : [new URL(e.name, dir)]));
    const src = new URL(`${d.name}/src/`, root);
    if (!existsSync(src)) continue;
    // site/src/tokens.js holds the CIE XYZ matrix of the colour-blind simulation: a different formula
    for (const f of walk(src)) if (/\.(m?js)$/.test(f.pathname) && /0\.2126\s*\*?\s*\w*[\s\S]{0,20}0\.7152|\[0\.2126, 0\.7152, 0\.0722\]/.test(readFileSync(f, "utf8")) && !/core\/src\/colour\.js$|site\/src\/tokens\.js$/.test(f.pathname)) hits.push(f.pathname.split("/packages/")[1]);
  }
  assert.deepEqual(hits, []);
  assert.ok(Math.abs(core.contrast("#000000", "#FFFFFF") - 21) < 1e-9 && Math.abs(core.contrast([255, 255, 255], "#FFF") - 1) < 1e-9);
});

test("WCAG 2.1: the sRGB threshold is 0.04045 and the extremes are exact", () => {
  assert.equal(core.relativeLuminance("#000000"), 0);
  assert.ok(Math.abs(core.relativeLuminance("#FFFFFF") - 1) < 1e-12);
  // 0x0B / 255 = 0.04314 is above 0.04045 and 0x0A / 255 = 0.03922 is below: both branches, continuous at the join
  assert.ok(Math.abs(core.relativeLuminance([10, 10, 10]) - 10 / 255 / 12.92) < 1e-12);
  assert.ok(Math.abs(core.relativeLuminance([11, 11, 11]) - ((11 / 255 + 0.055) / 1.055) ** 2.4) < 1e-12);
});

test("surfaceSlots: a surface or wash that resolves to nothing is reported with the token that is missing", () => {
  assert.deepEqual(core.surfaceSlots({ bg: "#FFFFFF" }, "sink"), [{ name: "sink", hex: undefined, token: "sink" }]);
  const w = core.surfaceSlots({ bg: "#FFFFFF", surface: "#FFFFFF", ink: "#111111" }, "wash:err");
  assert.deepEqual(w.map((x) => [x.name, x.hex, x.token]), [["wash:err over bg", undefined, "err"], ["wash:err over surface", undefined, "err"]]);
  assert.deepEqual(core.surfaceSlots(TOKENS, "bg"), [{ name: "bg", hex: TOKENS.bg, token: "bg" }]);
});
