/**
 * Design tokens: colours, radii, fonts and font files, logo and image files. The kit defaults are a neutral
 * theme; every project sets its own brand values explicitly in its site config.
 */
import { contrast, mix, WASHES, TEXT_ON, surfaceColours, surfaceSlots, surfaces, ensureContrast, fillOn, derivedColors, CHART_ROLES, TONES, FILL_ROLES, CATEGORY_ROLES, SURFACE_ROLES } from "@saasreport/core/colour";
export { contrast, mix, WASHES, TEXT_ON, surfaceColours, surfaceSlots, surfaces, ensureContrast, fillOn, derivedColors, CHART_ROLES, TONES, FILL_ROLES, CATEGORY_ROLES, SURFACE_ROLES };

export const DEFAULT_TOKENS = {
  color: {
    accent: "#1D4ED8",        // the one accent: buttons, links, active states, the hero and final cover
    accentPress: "#1E40AF",   // accent, pressed / hover
    accentOnDark: "#93C5FD",  // accent tint that reads on black surfaces (code, consoles)
    accentBright: "#60A5FA",  // brighter accent for keywords and highlights on black
    accentTint: "#EFF6FF",    // pale accent wash (notes)
    ink: "#111111",           // text, borders, black surfaces
    rail: "#BDBDBD",          // rails and connector lines
    railDark: "#5C5C5C",      // rails on black surfaces
    bg: "#FAFAFA",            // page background
    surface: "#FFFFFF",       // cards and paper sections
    dashBg: "#F6F6F6",        // dashboard backgrounds
    sink: "#F2F2F2",          // recessed areas
    line: "#E5E5E5",
    line2: "#D4D4D4",
    muted: "#666666",
    // tertiary text (timestamps, pending steps, labels): the base grey. The theme never shows it as is: it shows
    // dimOnLight on light surfaces and dimOnDark on black ones (derivedColors), each computed to reach WCAG AA there
    dim: "#8A8A8A",
    ok: "#127436",            // success text and marks, also on its 12% wash over the page and cards: AA there
    warn: "#A24A08",          // warning text, also on its 12% wash over the page and cards: AA there
    err: "#B91C1C",
    black: "#000000",         // the pure black the deep surfaces (inkDeep) are mixed from
    // categorical series before the 3:1 adjustment (derivedColors chart1-6): blue, orange, violet, brown, grey, red; chosen farthest-apart under normal, protan, deutan and tritan vision
    chartBase1: "#0072B2", chartBase2: "#DD6611", chartBase3: "#8800FF", chartBase4: "#774444", chartBase5: "#888899", chartBase6: "#AA0000",
    onInk: "#FFFFFF",         // text and icons on ink surfaces (notifications, consoles)
    onInkMuted: "#D8D8D4",    // secondary text on ink
    onInkDim: "#A6A6A2",      // tertiary marks on ink (close buttons)
    onInkFaint: "#8E8E89",    // the faintest text on black surfaces (timestamps, ids): still AA on inkRaised
    inkRaised: "#151515",     // a raised surface on black (cards and inputs in dark sections, the date picker on black)
    inkTrack: "#3A3A3A",      // progress tracks on ink
    onDarkOk: "#4ADE80",      // status colours that read on black surfaces (consoles, terminals, dark sections)
    onDarkWarn: "#F5A524",
    onDarkErr: "#F87171",
  },
  // Motion of the theme's components (notifications): a project with its own motion system sets these.
  motion: { ui: "220ms", easing: "cubic-bezier(.2,.7,.2,1)" },
  // The date picker's element name and class prefix (@saasreport/calendar picker-core: a subclass with static tag/prefix).
  picker: { tag: "kit-date-picker", prefix: "kitdp" },
  radius: { btn: "10px", card: "14px", lg: "18px" },
  font: {
    sans: "Noto Sans",        // family name used across the theme (quoted in CSS)
    mono: "Noto Sans Mono",
    faces: [],                // [{ family, weight, src, format }] → @font-face rules (self-hosted files)
    preload: [],              // font files to <link rel="preload">
  },
  logo: {
    nav: { src: "/brand/logo-nav.png", width: 198, height: 45 },
    footer: { src: "/brand/logo-footer.png", width: 280, height: 82 },
    icon: { src: "/brand/app-icon-512.png", width: 512, height: 512 },
  },
  images: {
    og: { src: "/og.png", width: 1200, height: 630, type: "image/png" },
    podcastCover: { src: "/brand/podcast-cover-600.png", width: 220, height: 220 },
  },
  icons: [
    { rel: "icon", href: "/favicon.ico", sizes: "any" },
    { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  ],
  manifest: "/site.webmanifest",
  css: {
    banners: {},              // { "styles.css": "/* … */" } first comment of each theme file
    notes: { railFrame: "rail frame around clean product mockups: accent rail on one half, rail grey on the other, circular end nodes", brandGuide: "brand guide" },
  },
};

const HEX = /^#[0-9A-Fa-f]{6}$/;
const LEN = /^\d+(\.\d+)?(px|rem|em)$/;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Deep-merge project tokens over the defaults (arrays replace). */
export function resolveTokens(tokens = {}, base = DEFAULT_TOKENS) {
  const out = { ...base };
  for (const [k, v] of Object.entries(tokens || {})) out[k] = isObj(v) && isObj(base[k]) ? resolveTokens(v, base[k]) : v;
  return out;
}

/** Problems with a (resolved) tokens object. */
export function checkTokens(t, where = "tokens") {
  const p = [];
  for (const [k, v] of Object.entries(t.color || {})) if (!HEX.test(v)) p.push(`${where}.color.${k}: "${v}" is not a #RRGGBB colour`);
  for (const k of Object.keys(DEFAULT_TOKENS.color)) if (!t.color?.[k]) p.push(`${where}.color.${k}: missing`);
  for (const k of ["btn", "card", "lg"]) if (!LEN.test(t.radius?.[k] || "")) p.push(`${where}.radius.${k}: expected a length like 10px`);
  for (const k of ["sans", "mono"]) if (!t.font?.[k] || /["{};]/.test(t.font[k])) p.push(`${where}.font.${k}: expected a family name`);
  (t.font?.faces || []).forEach((f, i) => {
    if (!f.family || !f.src || !f.weight) p.push(`${where}.font.faces[${i}]: needs family, weight and src`);
    if (f.src && !f.src.startsWith("/") && !/^https:\/\//.test(f.src)) p.push(`${where}.font.faces[${i}].src: a site path or https URL`);
  });
  for (const k of ["nav", "footer", "icon"]) {
    const l = t.logo?.[k];
    if (!l?.src || !l.width || !l.height) p.push(`${where}.logo.${k}: needs src, width and height`);
  }
  if (!t.images?.og?.src) p.push(`${where}.images.og: needs src`);
  p.push(...checkContrast(t, where));
  return p;
}


const WHAT = {
  accentText: "accent text on light surfaces and the accent's washes (--accent-text: eyebrows, labels)",
  dimOnLight: "tertiary text on light surfaces (--dim)", dimOnDark: "tertiary text on black surfaces (--dim)",
  muted: "secondary text", ok: "the success colour", warn: "the warning colour", err: "the error colour",
  accentOnDark: "accent text on black surfaces (consoles, terminals, dark sections, stat numbers)", accentBright: "keywords and highlights on black",
  onInk: "text on black", onInkDim: "tertiary text on black (--muted on black surfaces)", onAccent: "text on an accent surface (buttons, the hero, chips)", onInkMuted: "secondary text on black", onInkFaint: "the faintest text on black",
  onOk: "text on a solid success fill", onWarn: "text on a solid warning fill", onErr: "text on a solid error fill", onMuted: "text on a solid muted fill",
  onChart1: "text on a solid chart-1 fill", onChart2: "text on a solid chart-2 fill", onChart3: "text on a solid chart-3 fill", onChart4: "text on a solid chart-4 fill", onChart5: "text on a solid chart-5 fill", onChart6: "text on a solid chart-6 fill",
  onDarkOk: "the success colour on black", onDarkWarn: "the warning colour on black", onDarkErr: "the error colour on black",
};


// Colour-vision-deficiency simulation (Machado et al. 2009, severity 1) on linear sRGB, then CIE Lab distance.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toRgb = (hex) => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
function lab(rgbLin) {
  const [r, g, b] = rgbLin.map((v) => Math.min(1, Math.max(0, v)));
  const xyz = [0.4124 * r + 0.3576 * g + 0.1805 * b, 0.2126 * r + 0.7152 * g + 0.0722 * b, 0.0193 * r + 0.1192 * g + 0.9505 * b];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [x, y, z] = [f(xyz[0] / 0.95047), f(xyz[1]), f(xyz[2] / 1.08883)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
/** Lab distance between two #RRGGBB colours as seen under a vision type ("normal", "protan", "deutan", "tritan"). */
export function colourDistance(a, b, vision = "normal") {
  const see = (hex) => { const v = toRgb(hex); return vision === "normal" ? v : CVD[vision].map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]); };
  const [p, q] = [lab(see(a)), lab(see(b))];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
/** Minimum Lab distance between any two series colours under normal, protan, deutan and tritan vision. */
/** The series colours before the 3:1 adjustment: the chartBase tokens of the defaults. */
export const CHART_BASE = CHART_ROLES.map((_, i) => DEFAULT_TOKENS.color[`chartBase${i + 1}`]);
export const CHART_MIN_DISTANCE = 12;
export function chartProblems(c, where = "tokens") {
  const series = CHART_ROLES.map((_, i) => c[`chart${i + 1}`]).filter((h) => HEX.test(h || ""));
  const p = [];
  for (let i = 0; i < series.length; i++) for (let j = i + 1; j < series.length; j++) for (const v of ["normal", "protan", "deutan", "tritan"]) {
    const d = colourDistance(series[i], series[j], v);
    if (d < CHART_MIN_DISTANCE) p.push(`${where}.color.chart${i + 1} and chart${j + 1} are ${d.toFixed(1)} apart under ${v} vision, below ${CHART_MIN_DISTANCE}: series must stay distinguishable without hue`);
  }
  return p;
}

/**
 * Every text pair the theme relies on, from TEXT_ON: [text, surface, minimum, what] (a wash surface expanded per
 * surface under it), and the emphasis on an accent surface (large display text: 3:1). Each pair is
 * [text, surface, minimum, what, surfaceHex, missingToken]: a surface that resolves to nothing has no hex and names the token that is missing, so
 * the gate reports it (checkContrast) instead of the pair quietly disappearing.
 */
const rawPairs = (c) => [
  ...Object.entries(TEXT_ON).flatMap(([role, list]) => list.flatMap((n) => surfaceSlots(c, n)).map((x) => [role, x.name, 4.5, WHAT[role] || role, x.hex, x.token])),
  ["accentEm", "accent", 3, "emphasis on an accent surface (hero, final call to action)", c.accent, "accent"],
  ...Object.entries(UI_ON).flatMap(([role, list]) => list.flatMap((n) => surfaceSlots(c, n)).map((x) => [role, x.name, 3, WHAT_UI[role] || role, x.hex, x.token])),
];
/**
 * The pairs that cannot be judged because a colour is not there, FAIL-CLOSED: [{ token, why }], one per (token, pair), empty when every
 * text role and every surface of every pair resolves to a #RRGGBB. `token` is the missing colour role (a text role, a surface, or the
 * colour a wash is mixed from; an unknown wash name is reported under its own name); a pair never quietly drops out of the gate.
 */
export function contrastGaps(c) {
  const gaps = [];
  for (const [f, n, , what, b, token] of rawPairs(c)) {
    if (!HEX.test(c[f] || "")) gaps.push({ token: f, why: `${what} is checked on ${n}` });
    if (!HEX.test(b || "")) gaps.push({ token: token || n, why: `${f} is checked on ${n}` });
  }
  return gaps;
}
/**
 * Every pair a theme is held to: [text role, surface name, minimum ratio, what it is for, surface #RRGGBB, surface token]. It THROWS
 * (an Error with `.gaps`, the contrastGaps) when any role or surface does not resolve, so a caller can never mistake a missing colour
 * for a pair that passes or for no pair: use contrastGaps to read what is missing, or checkContrast, which reports it as findings.
 */
export function contrastPairs(c) {
  const gaps = contrastGaps(c);
  if (gaps.length) throw Object.assign(new Error(`contrast pairs cannot be computed, no colour for: ${[...new Set(gaps.map((g) => g.token))].join(", ")}`), { gaps });
  return rawPairs(c);
}

/**
 * Non-text roles (WCAG 1.4.11): the colour, the surfaces it lands on, always 3:1. Focus rings, the border of an interactive
 * control, disabled marks and the chart series.
 */
export const UI_ON = {
  focus: ["bg", "surface", "sink"],
  focusOnDark: ["ink", "inkRaised", "inkDeep"],
  control: ["bg", "surface"],
  controlOnDark: ["ink", "inkRaised", "inkDeep"],
  disabled: ["bg", "surface"],
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`chart${i + 1}`, ["bg", "surface"]])),
};
const WHAT_UI = {
  focus: "the focus ring on light surfaces", focusOnDark: "the focus ring on black surfaces", control: "the border of an interactive control (inputs, ghost buttons, chips)",
  controlOnDark: "the border of an interactive control on black", disabled: "a disabled control's mark", chart1: "a chart series", chart2: "a chart series", chart3: "a chart series",
  chart4: "a chart series", chart5: "a chart series", chart6: "a chart series",
};
/** The pairs of the default tokens (documentation; checkContrast computes them for the project's tokens). */
export const CONTRAST_PAIRS = TEXT_ON;

/** Contrast problems of a (resolved) tokens object's colours: every role on every surface it lands on, below AA. */
export function checkContrast(t, where = "tokens") {
  const problems = [], reported = new Set();
  // fail closed: a colour that is not there is a finding, once, never a pair that quietly disappears from the gate
  const gap = (token, why) => { if (!reported.has(token)) { reported.add(token); problems.push(`${where}.color.${token}: no colour (${why}), so the contrast pairs on it cannot be judged`); } };
  for (const k of Object.keys(DEFAULT_TOKENS.color)) if (!HEX.test(t.color?.[k] || "")) gap(k, "a base token of the theme");
  let derived = {};
  try { derived = derivedColors(t.color || {}); } catch (e) { if (!reported.size) problems.push(`${where}.color: the derived roles cannot be computed (${e.message})`); return problems; }
  if (reported.size) return problems;   // the derived roles rest on the base tokens: name what is missing first
  const c = { ...t.color, ...derived };
  for (const g of contrastGaps(c)) gap(g.token, g.why);
  if (reported.size) return problems;
  for (const [f, n, min, what, b] of contrastPairs(c)) {
    const r = contrast(c[f], b);
    if (r < min) problems.push(`${where}.color.${f} on ${n}: ${r.toFixed(2)}:1, below the ${min}:1 that ${what} needs (WCAG AA)`);
  }
  return problems.concat(chartProblems(c, where));
}

/**
 * The colour canon in CSS: every colour role (a token or a derived colour) is a custom property --c-<kebab-name> declared once,
 * in :root, by the theme's styles.css ({{colorVars}}). Every other rule reads var(--c-…), a wash or an alpha is
 * color-mix(in srgb, var(--c-…) N%, transparent): no colour literal anywhere else (kit check tokens).
 */
export const roleVar = (name) => `--c-${name.replace(/[A-Z0-9]+/g, (m, i) => (i ? "-" : "") + m.toLowerCase())}`;
/** Every colour role of resolved tokens as { name: "#RRGGBB" }: tokens first, derived colours over them. */
export const colorRoles = (color) => Object.fromEntries(Object.entries({ ...color, ...derivedColors(color) }).filter(([, v]) => HEX.test(v)));
/** The :root declarations of the colour roles, one per line. */
export const colorVars = (color) => Object.entries(colorRoles(color)).map(([k, v]) => `  ${roleVar(k)}:${v};`).join("\n");
/**
 * The roles the Worker's server-rendered pages read (packages/cloudflare/assets/kit.css declares them as --c-<name> and the
 * Worker's brand.colors overrides them): a project's kit.config.js sets `brand.colors: workerColors(tokens.color)` instead of
 * writing the colours a second time.
 */
export const workerColors = (color) => {
  const r = colorRoles(color);
  return { accent: r.accent, "accent-ink": r.onAccent, "accent-text": r.accentText, ink: r.ink, muted: r.muted, bg: r.bg, surface: r.surface, sink: r.sink, line: r.line, "line-2": r.line2, rail: r.rail,
    err: r.err, ok: r.ok, focus: r.focus, control: r.control, "on-ink": r.onInk, "on-ink-muted": r.onInkMuted, "on-ink-dim": r.onInkDim, "ink-raised": r.inkRaised,
    // the tone fills and their derived text roles: the content-tag chips (docs/TAGS.md) paint with these
    warn: r.warn, "on-ok": r.onOk, "on-warn": r.onWarn, "on-err": r.onErr, "chart-1": r.chart1, "chart-2": r.chart2, "chart-3": r.chart3, "chart-4": r.chart4, "chart-5": r.chart5, "chart-6": r.chart6,
    "on-chart-1": r.onChart1, "on-chart-2": r.onChart2, "on-chart-3": r.onChart3, "on-chart-4": r.onChart4, "on-chart-5": r.onChart5, "on-chart-6": r.onChart6 };
};
/**
 * The inline style of a solid tone: the fill (--c) and the text colour derived for that fill (--on-c): `--c:var(--c-chart-2);--on-c:var(--c-on-chart-2)`.
 * The theme paints text on a tone with var(--on-c, <the fixed role for the fallback fill>), so the text colour is chosen per background.
 */
export const toneStyle = (colorHex, role) => {
  const ref = String(role).match(/^var\(--c-([\w-]+)\)$/);   // a role written as its custom property: var(--c-chart-2) → chart2
  const r = ref ? ref[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()) : String(role), on = "on" + r.charAt(0).toUpperCase() + r.slice(1);
  if (!(r in colorHex) || !(on in colorHex)) throw new Error(`unknown tone "${r}": a tone is a colour role that has a derived text role (${on}); accent, ink, ok, warn, err, muted, chart1 ... chart6`);
  return `--c:var(${roleVar(r)});--on-c:var(${roleVar(on)})`;
};
/** { name: "var(--c-name)" } for the templates that paint with a role (CSS, inline SVG, script strings). */
export const colorRefs = (color) => Object.fromEntries(Object.keys(colorRoles(color)).map((k) => [k, `var(${roleVar(k)})`]));

/** "#1D4ED8" → "29,78,216" (for rgba()). */
export const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");

/** The @font-face rules for the theme's self-hosted fonts, one per line. */
export function fontFaces(t) {
  return (t.font.faces || []).map((f) => `@font-face{font-family:"${f.family}";src:url("${f.src}") format("${f.format || formatOf(f.src)}");font-weight:${f.weight};font-display:swap}`).join("\n");
}
const formatOf = (src) => ({ ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" })[src.split(".").pop().toLowerCase()] || "truetype";
export const fontType = (src) => `font/${src.split(".").pop().toLowerCase()}`;
