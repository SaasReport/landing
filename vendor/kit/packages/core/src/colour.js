/**
 * The colour derivation: ONE source for the site theme, the emails and every project that reads the colour canon (docs/COLOUR.md).
 * Pure functions of #RRGGBB tokens: contrast, mix, the washes, the surfaces each text role lands on (TEXT_ON), the roles derived
 * from the tokens (derivedColors) and the one rule for text on a solid fill (fillOn). @saasreport/site re-exports it; @saasreport/comms calls it.
 */

/**
 * The registry of tone roles: every solid fill a text can sit on, and the role of the text on it (one rule, fillOn, derives each).
 * The theme CSS (--c-<role> / --c-on-<role>), the static and rendered contrast gates, the directory's category colours and the
 * email roles all read this one map; none keeps a list of its own.
 */
export const TONES = {
  accent: "onAccent", ok: "onOk", warn: "onWarn", err: "onErr", muted: "onMuted", ink: "onInk",
  chart1: "onChart1", chart2: "onChart2", chart3: "onChart3", chart4: "onChart4", chart5: "onChart5", chart6: "onChart6",
};
/** The fill roles, in registry order. */
export const FILL_ROLES = Object.keys(TONES);
/** The categorical series roles (chart1 ... chart6): each starts from the token chartBase<n> of the token defaults, before the 3:1 adjustment. */
export const CHART_ROLES = FILL_ROLES.filter((r) => /^chart/.test(r));
/** The fills a directory category may be painted with (a chart colour or a status colour: never muted or ink). */
export const CATEGORY_ROLES = [...FILL_ROLES.filter((r) => /^chart/.test(r)), ...FILL_ROLES.filter((r) => ["accent", "ok", "warn", "err"].includes(r))];
/** The surfaces a text lands on, as theme roles (a light page, a card, a sink, the black surfaces, an accent fill). */
export const SURFACE_ROLES = ["bg", "surface", "sink", "ink", "inkRaised", "inkDeep", "accent"];

const rgbOf = (c) => (Array.isArray(c) ? c : (c = /^#[0-9a-f]{3}$/i.test(c) ? "#" + c.slice(1).split("").map((x) => x + x).join("") : c, [1, 3, 5].map((i) => parseInt(String(c).slice(i, i + 2), 16))));
/**
 * WCAG 2 relative luminance (0 to 1) of [r, g, b] (0 to 255) or #RRGGBB. THE one formula: the email, the static and rendered gates and
 * the page pass all call it. It is a self-contained function (no outer reference), so a gate that runs inside a page is given its
 * source (`relativeLuminance.toString()`) instead of keeping a copy.
 */
export function relativeLuminance(c) {
  const v = Array.isArray(c) ? c : [1, 3, 5].map((i) => parseInt(String(c).slice(i, i + 2), 16));
  const lin = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(v[0]) + 0.7152 * lin(v[1]) + 0.0722 * lin(v[2]);
}
/** WCAG 2 contrast ratio (1 to 21) of two colours, each [r, g, b] or #RRGGBB (#RGB too). */
export function contrast(a, b) {
  const x = relativeLuminance(rgbOf(a)), y = relativeLuminance(rgbOf(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** a over b at opacity `alpha` (#RRGGBB): what a translucent wash paints. */
export function mix(a, b, alpha) {
  const ch = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(ch(a, i) * alpha + ch(b, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * The theme's translucent washes behind text: the colour, its opacity and the surfaces it is painted over. One map:
 * the theme CSS reads the opacity from it ({{wash.accent}} → rgba({{color.accent|rgb}},{{wash.accent}})) and the
 * contrast check composites each wash over each of its surfaces.
 *   accent      the eyebrow pill, promo and key chips (on the page, on cards, in the brand teaser and modals)
 *   accentDeep  the eyebrow in deep or seed sections
 *   ok/warn/err status badges and lab chips
 *   ink         the mock app card's steps and counters
 */
export const WASHES = {
  accent: { colour: "accent", alpha: 0.08, over: ["bg", "surface"] },
  accentDeep: { colour: "accent", alpha: 0.14, over: ["bg", "surface"] },
  ok: { colour: "ok", alpha: 0.12, over: ["bg", "surface"] },
  warn: { colour: "warn", alpha: 0.12, over: ["bg", "surface"] },
  err: { colour: "err", alpha: 0.1, over: ["bg", "surface"] },
  ink: { colour: "ink", alpha: 0.04, over: ["bg", "surface"] },
};

/**
 * Where each text colour lands: [surface, minimum] per role. A surface is a token, "wash:<name>" (that wash over every
 * surface it is painted on) or a fixed theme surface. derivedColors computes the roles against exactly these
 * surfaces, and checkContrast checks every role on every one of them (WCAG AA: 4.5:1; 3:1 for large display text).
 */
export const TEXT_ON = {
  accentText: ["bg", "surface", "accentTint", "wash:accent", "wash:accentDeep"],
  dimOnLight: ["bg", "surface", "sink", "dashBg", "accentTint", "wash:ink"],
  dimOnDark: ["ink", "inkRaised", "inkDeep"],
  muted: ["bg", "surface", "sink"],
  ok: ["bg", "surface", "wash:ok"],
  warn: ["bg", "surface", "wash:warn"],
  err: ["bg", "surface", "wash:err"],
  accentOnDark: ["ink", "inkRaised", "inkDeep"],
  accentBright: ["ink", "inkDeep"],
  onInk: ["ink", "inkRaised", "inkDeep", "inkHover"],
  onInkMuted: ["ink", "inkRaised", "inkDeep"],
  onInkDim: ["ink", "inkRaised", "inkDeep"],
  onInkFaint: ["ink", "inkDeep"],
  onDarkOk: ["ink", "inkDeep"],
  onDarkWarn: ["ink", "inkDeep"],
  onDarkErr: ["ink", "inkDeep"],
  onAccent: ["accent", "accentPress"],
  // text on a solid fill painted with a tone (a status chip, a player badge, a category dot): derived per fill, never one fixed colour
  onOk: ["ok"], onWarn: ["warn"], onErr: ["err"], onMuted: ["muted"],
  onChart1: ["chart1"], onChart2: ["chart2"], onChart3: ["chart3"], onChart4: ["chart4"], onChart5: ["chart5"], onChart6: ["chart6"],
};


const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || "");
/**
 * Every place a TEXT_ON / UI_ON surface name stands for, resolved or not: [{ name, hex, token }]. A wash is one place per surface under it;
 * `token` is the colour role that is missing when `hex` is undefined (an unknown name, or a token the project does not have). The gates
 * read this, so a surface that resolves to nothing is a finding, never a pair that quietly disappears.
 */
export function surfaceSlots(c, name) {
  if (name.startsWith("wash:")) {
    const w = WASHES[name.slice(5)];
    if (!w) return [{ name, hex: undefined, token: name }];
    return w.over.map((o) => {
      const missing = [w.colour, o].find((t) => !isHex(c[t]));
      return { name: `${name} over ${o}`, hex: missing ? undefined : mix(c[w.colour], c[o], w.alpha), token: missing };
    });
  }
  return [{ name, hex: isHex(c[name]) ? c[name] : undefined, token: name }];
}
/** The colours behind one TEXT_ON surface name: [{ name, hex }] (a wash expands to one colour per surface under it); what does not resolve is left out (see surfaceSlots). */
export function surfaceColours(c, name) {
  return surfaceSlots(c, name).filter((x) => x.hex).map(({ name: n, hex }) => ({ name: n, hex }));
}

/** Every surface a role lands on, as colours: { role: [{ name, hex }] }. */
export function surfaces(c) {
  return Object.fromEntries(Object.entries(TEXT_ON).map(([role, list]) => [role, list.flatMap((n) => surfaceColours(c, n))]));
}

/**
 * `from` moved towards `to` in small steps until it reaches `min`:1 against every one of `against` (the first colour
 * that does; `to` itself if none does). A colour that already passes is returned unchanged.
 */
export function ensureContrast(from, against, min, to) {
  const ok = (x) => against.every((b) => contrast(x, b) >= min);
  for (let i = 0; i <= 100; i++) { const x = i ? mix(to, from, i / 100) : from.toUpperCase(); if (ok(x)) return x; }
  return to;
}

/**
 * Colours the theme derives from the tokens (a project that sets one itself gets exactly that colour, and checkContrast holds it to AA):
 *   accentEm    the emphasis colour on an accent surface (ink, or onInk when ink does not read on the accent)
 *   onAccent    text and icons on an accent fill: fillOn
 *   pillBorder  the border of an accent-tinted pill: the accent washed into the card surface
 *   accentText  accent-coloured text on light surfaces: the accent darkened towards ink until it is AA on every surface of TEXT_ON.accentText
 *   dimOnLight  tertiary text on light surfaces: dim darkened towards ink until AA on every surface of TEXT_ON.dimOnLight
 *   dimOnDark   tertiary text on black surfaces: onInkFaint lightened towards onInk until AA on every surface of TEXT_ON.dimOnDark
 *   focus, focusOnDark, control, controlOnDark, disabled   non-text roles held to 3:1 (WCAG 1.4.11) on the surfaces they sit on
 *   chart1-6    categorical colours, 3:1 on the light surfaces and apart under colour-blind simulation (chartBase1-6 of the token defaults)
 *   onOk, onWarn, onErr, onMuted, onChart1-6   text on each solid tone fill (TONES): fillOn, the same rule as onAccent
 */
/** Text on a solid fill: the on-ink colour when it reads there (4.5:1), else ink, whichever reads better. The ONE rule for onAccent and every tone's on-role. */
export const fillOn = (c, bg) => (contrast(c.onInk, bg) >= 4.5 || contrast(c.onInk, bg) >= contrast(c.ink, bg) ? c.onInk : c.ink);

export const derivedColors = (c) => {
  // surfaces first: roles below are computed against them
  const surf = { ...c, inkDeep: c.inkDeep || mix(c.black, c.ink, 0.5), inkHover: c.inkHover || mix(c.onInk, c.ink, 0.12) };
  const on = (role) => TEXT_ON[role].flatMap((n) => surfaceColours(surf, n)).map((x) => x.hex);
  const light = ["bg", "surface", "sink", "dashBg"].map((n) => surf[n]).filter(Boolean);
  const onAccent = c.onAccent || fillOn(c, c.accent);
  const out = {
    inkDeep: surf.inkDeep, inkHover: surf.inkHover,
    accentEm: contrast(c.ink, c.accent) >= 4.5 ? c.ink : c.onInk,
    // text and icons on an accent surface: the on-ink colour when it reads there (4.5:1), else ink (white on a bright orange is 3.1:1)
    onAccent,
    // the border of an accent-tinted pill (an email's step chip): the accent washed into the card surface, one derivation for the site and the email
    pillBorder: c.pillBorder || mix(c.accent, c.surface || c.bg || c.onInk, 0.27),
    accentText: c.accentText || ensureContrast(c.accent, on("accentText"), 4.5, c.ink),
    dimOnLight: c.dimOnLight || ensureContrast(c.dim, on("dimOnLight"), 4.5, c.ink),
    dimOnDark: c.dimOnDark || ensureContrast(c.onInkFaint, on("dimOnDark"), 4.5, c.onInk),
    // non-text roles (WCAG 1.4.11, 3:1): the focus ring on light and on black surfaces, the border of an interactive control, a disabled control's mark
    focus: c.focus || ensureContrast(c.accent, light, 3, c.ink),
    focusOnDark: c.focusOnDark || ensureContrast(c.accentOnDark, [surf.ink, surf.inkRaised, surf.inkDeep], 3, c.onInk),
    control: c.control || ensureContrast(c.line2, light, 3, c.ink),
    controlOnDark: c.controlOnDark || ensureContrast(c.railDark, [surf.ink, surf.inkRaised, surf.inkDeep], 3, c.onInk),
    disabled: c.disabled || ensureContrast(c.rail, light, 3, c.ink),
  };
  // chart series: categorical colours that stay 3:1 on the light surfaces and apart under colour-blind simulation (chartBase1-6 of the token defaults, checkChart)
  CHART_ROLES.forEach((role, i) => { out[role] = c[role] || ensureContrast(c[`chartBase${i + 1}`], light, 3, c.ink); });
  for (const [fill, role] of Object.entries(TONES)) if (role !== "onAccent" && role !== "onInk") { const bg = out[fill] || c[fill]; if (bg) out[role] = c[role] || fillOn(c, bg); }   // onAccent is above; onInk is a token
  return out;
};

