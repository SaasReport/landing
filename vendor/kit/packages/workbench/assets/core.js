/* @saasreport/workbench: the pure core of the browser runtime (no DOM). Assembled with the kit's JSON Schema validator
   (createValidator) and ui.js by src/runtime.js into one plain script; tests run it in a bare vm context.
   Parts: fold (the kit search fold), the command grammar, Solar Hijri arithmetic, seeded series, the layout model,
   watchlists, SourceEnvelope helpers, BYO checks (URL, capped fetch, CSV, schema inference, encrypted keys). */

// ---- fold: identical to the site search's (packages/site/assets/shell.js); test/fold.test.mjs proves the parity ----
const fold = (s) => String(s || "").replace(/[™®©]/g, "").normalize("NFKD").replace(/[̀-ًͯ-ٰٟ]/g, "").replace(/[‌-‏]/g, "").replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/ة/g, "ه").replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).toLowerCase();

const isO = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const toDigits = (v, digits) => (digits === "arabext" ? String(v).replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + +d)) : digits === "arab" ? String(v).replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + +d)) : String(v));

// ---- command grammar: VERB [target] [name=value ...] ----
function tokenize(line) {
  const out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || "")))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const keysOf = (c) => [c.verb, ...(c.aliases || [])].map(fold);

/** The command a line starts with: the longest verb or alias phrase (up to 3 words) → { command, rest } or null. */
function matchExact(commands, tokens) {
  for (let n = Math.min(3, tokens.length); n >= 1; n--) {
    const phrase = fold(tokens.slice(0, n).join(" "));
    const command = commands.find((c) => keysOf(c).includes(phrase));
    if (command) return { command, rest: tokens.slice(n) };
  }
  return null;
}
const subseq = (needle, hay) => { let i = 0; for (const ch of hay) if (ch === needle[i]) i++; return i === needle.length; };
function lev1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
/** Ranked suggestions for what has been typed so far (Persian and Latin, folded): exact, prefix, word prefix, substring, one typo, subsequence. */
function suggest(commands, line, limit = 8) {
  const tokens = tokenize(line);
  if (!tokens.length) return commands.slice(0, limit).map((command) => ({ command, score: 1, via: command.verb }));
  const exact = matchExact(commands, tokens);
  const q = fold(exact ? tokens.slice(0, tokens.length - exact.rest.length).join(" ") : tokens[0]);
  const rows = [];
  for (const command of commands) {
    let best = 0, via = command.verb;
    const cands = [command.verb, ...(command.aliases || [])];
    for (const raw of cands) {
      const k = fold(raw);
      const s = k === q ? 100 : k.startsWith(q) ? 80 - Math.min(20, k.length - q.length) : k.split(/\s+/).some((w) => w.startsWith(q)) ? 65 : k.includes(q) ? 55 : q.length >= 4 && lev1(q, k) ? 45 : q.length >= 3 && subseq(q, k) ? 30 : 0;
      if (s > best) { best = s; via = raw; }
    }
    const sum = fold(command.summary || "");
    if (!best && q.length >= 3 && sum.includes(q)) { best = 20; via = command.verb; }
    if (best) rows.push({ command, score: best, via });
  }
  return rows.sort((a, b) => b.score - a.score || a.command.verb.localeCompare(b.command.verb)).slice(0, limit);
}

const TRUE = new Set(["true", "yes", "y", "1", "on", "بله", "آری", "اره"]), FALSE = new Set(["false", "no", "n", "0", "off", "خیر", "نه"]);
/** A date as the user types it: 2026-10-07, 1405/07/15 or 1405-07-15 (Persian or Latin digits) → { iso, jalali } or null. */
function parseDate(text) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(fold(text).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y >= 1700) {
    const t = Date.UTC(y, mo - 1, d); const dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { iso: iso(y, mo, d), jalali: jalaliFor(y, mo, d) };
  }
  if (mo < 1 || mo > 12 || d < 1 || d > (mo <= 6 ? 31 : mo <= 11 ? 30 : isLeapJalali(y) ? 30 : 29)) return null;
  const g = jalaliToGregorian(y, mo, d);
  return { iso: iso(g.gy, g.gm, g.gd), jalali: `${y}/${p2(mo)}/${p2(d)}` };
}
const p2 = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${String(y).padStart(4, "0")}-${p2(m)}-${p2(d)}`;

/** Bind and check a command's arguments: positional words fill the arguments in order, name=value sets one. */
function bindArgs(command, rest, msg = {}) {
  const defs = command.args || [], out = {}, errors = [];
  const named = {}, pos = [];
  for (const w of rest) { const m = /^([a-z][a-z0-9_]*)=(.*)$/.exec(w); if (m && defs.some((a) => a.name === m[1])) named[m[1]] = m[2]; else pos.push(w); }
  let pi = 0;
  for (const a of defs) {
    let raw = a.name in named ? named[a.name] : pos[pi++];
    if (raw === undefined || raw === "") { if (a.default !== undefined) { out[a.name] = a.default; continue; } if (a.required) errors.push({ arg: a.name, message: (msg.argMissing || "{name} is required").replace("{name}", a.name) }); continue; }
    const bad = () => errors.push({ arg: a.name, message: (msg.argInvalid || "{name}: invalid").replace("{name}", a.name) });
    if (a.type === "number" || a.type === "integer") {
      const n = Number(fold(raw).replace(/[,٬،]/g, ""));
      if (!Number.isFinite(n) || (a.type === "integer" && !Number.isInteger(n)) || (a.min != null && n < a.min) || (a.max != null && n > a.max)) { bad(); continue; }
      out[a.name] = n;
    } else if (a.type === "date") { const d = parseDate(raw); if (!d) { bad(); continue; } out[a.name] = d.iso; }
    else if (a.type === "enum") { const hit = (a.enum || []).find((v) => fold(v) === fold(raw)); if (hit === undefined) { bad(); continue; } out[a.name] = hit; }
    else if (a.type === "boolean") { const f = fold(raw); if (TRUE.has(f)) out[a.name] = true; else if (FALSE.has(f)) out[a.name] = false; else { bad(); continue; } }
    else out[a.name] = String(raw).slice(0, 200);
  }
  const extra = pos.slice(pi);
  if (extra.length) errors.push({ arg: "", message: (msg.argExtra || "unexpected: {value}").replace("{value}", extra.join(" ")) });
  return { args: out, errors };
}
/** Parse a whole line → { command, args, errors, suggestions }. An unknown verb yields suggestions and no command. */
function parseLine(commands, line, msg = {}) {
  const tokens = tokenize(line);
  if (!tokens.length) return { command: null, args: {}, errors: [], suggestions: suggest(commands, "") };
  const hit = matchExact(commands, tokens);
  if (!hit) return { command: null, args: {}, errors: [{ arg: "", message: (msg.unknown || "unknown command: {word}").replace("{word}", tokens[0]) }], suggestions: suggest(commands, line) };
  const { args, errors } = bindArgs(hit.command, hit.rest, msg);
  return { command: hit.command, args, errors, suggestions: [] };
}
/** Pane parameters from a command's arguments (each argument's paneParam, default its name). */
const paneArgs = (command, args) => Object.fromEntries(Object.entries(args).map(([k, v]) => [(command.args.find((a) => a.name === k) || {}).paneParam || k, v]));

// ---- Solar Hijri by arithmetic (the 33-year cycle algorithm of @saasreport/calendar; test/jalali.test.mjs proves the parity) ----
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
function jalCal(jy) {
  let bl = BREAKS.length, gy = jy + 621, leapJ = -14, jp = BREAKS[0], jm, jump = 0, n, i;
  for (i = 1; i < bl; i += 1) { jm = BREAKS[i]; jump = jm - jp; if (jy < jm) break; leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4); jp = jm; }
  n = jy - jp; leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150, march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4); if (leap === -1) leap = 4;
  return { leap, gy, march };
}
const div = (a, b) => ~~(a / b), mod = (a, b) => a - ~~(a / b) * b;
const g2d = (gy, gm, gd) => { let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408; d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752; return d; };
const d2g = (jdn) => { let j = 4 * jdn + 139361631; j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908; const i = div(mod(j, 1461), 4) * 5 + 308; const gd = div(mod(i, 153), 5) + 1, gm = mod(div(i, 153), 12) + 1, gy = div(j, 1461) - 100100 + div(8 - gm, 6); return { gy, gm, gd }; };
const j2d = (jy, jm, jd) => { const r = jalCal(jy); return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1; };
const isLeapJalali = (jy) => jalCal(jy).leap === 0;
function jalaliToGregorian(jy, jm, jd) { return d2g(j2d(jy, jm, jd)); }
function gregorianToJalali(gy, gm, gd) {
  const jdn = g2d(gy, gm, gd); let jy = d2g(jdn).gy - 621; const r = jalCal(jy); const jdn1f = g2d(r.gy, 3, r.march); let k = jdn - jdn1f;
  if (k >= 0) { if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 }; k -= 186; } else { jy -= 1; k += 179; if (r.leap === 1) k += 1; }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}
function jalaliFor(gy, gm, gd) { const j = gregorianToJalali(gy, gm, gd); return `${j.jy}/${p2(j.jm)}/${p2(j.jd)}`; }
/** An instant in a fixed-offset zone (Asia/Tehran: +03:30, no DST since 2022) → { gregorian, jalali } as strings "YYYY-MM-DD HH:MM" and "YYYY/MM/DD HH:MM". */
function localStamp(ms, offsetMinutes = 210) {
  const d = new Date(ms + offsetMinutes * 60000), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate(), hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return { gregorian: `${iso(y, m, day)} ${hm}`, jalali: `${jalaliFor(y, m, day)} ${hm}` };
}
/** Weekday index with Saturday = 0 (the Iranian week) of an ISO date. */
const weekdayIndex = (isoDate) => { const [y, m, d] = isoDate.split("-").map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1) % 7; };

// ---- seeded series: a deterministic random walk, never presented as data ----
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
/** Series ending on `asOf` (YYYY-MM-DD): { dates:[iso], series:[{ id, label, unit, decimals, values }] }. Same seed, same series. */
function seededSeries(adapter, asOf) {
  const [y, m, d] = asOf.split("-").map(Number), end = Date.UTC(y, m - 1, d), step = (adapter.stepDays || 1) * 864e5;
  const dates = []; for (let i = adapter.points - 1; i >= 0; i--) { const t = new Date(end - i * step); dates.push(iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())); }
  const series = adapter.series.map((s) => {
    const rnd = mulberry32((adapter.seed ^ hashStr(s.id)) >>> 0); let v = s.base; const values = [];
    for (let i = 0; i < adapter.points; i++) { const z = (rnd() + rnd() + rnd() - 1.5) * 2; v = Math.max(s.base * 0.2, v * (1 + (s.drift || 0) + s.vol * z)); values.push(Number(v.toFixed(s.decimals ?? 0))); }
    return { id: s.id, label: s.label, unit: s.unit, decimals: s.decimals ?? 0, values };
  });
  return { dates, series };
}

// ---- calculators: pure arithmetic ----
function calculate(op, inp) {
  const n = (k) => Number(fold(String(inp[k] ?? "")).replace(/[,٬،\s]/g, ""));
  if (op === "jalali-to-gregorian") { const d = parseDate(inp.date); if (!d || +fold(inp.date).split(/[-/]/)[0] >= 1700) return null; return { gregorian: d.iso, weekday: weekdayIndex(d.iso) }; }
  if (op === "gregorian-to-jalali") { const d = parseDate(inp.date); if (!d || +fold(inp.date).split(/[-/]/)[0] < 1700) return null; return { jalali: d.jalali, weekday: weekdayIndex(d.iso) }; }
  if (op === "rial-toman") { const a = n("amount"); if (!Number.isFinite(a)) return null; return { toman: a / 10, rial: a * 10 }; }
  if (op === "nav") { const a = n("assets"), l = n("liabilities"), u = n("units"); if (![a, l, u].every(Number.isFinite) || u <= 0) return null; return { net: a - l, nav: (a - l) / u }; }
  if (op === "yield") { const s = n("start"), e = n("end"), days = n("days"); if (![s, e, days].every(Number.isFinite) || s <= 0 || days <= 0) return null; const p = (e - s) / s; return { period: p * 100, annual: p * (365 / days) * 100 }; }
  return null;
}

// ---- sandbox parameters: "$state.accounts.0.sheba" reads the sandbox engine's own state (a negative index counts from the end) ----
function fillState(v, state) {
  if (typeof v === "string" && v.startsWith("$state.")) { let o = state; for (const k of v.slice(7).split(".")) { if (o == null) return undefined; o = Array.isArray(o) && /^-?\d+$/.test(k) ? o.at(+k) : o[k]; } return o; }
  if (Array.isArray(v)) return v.map((x) => fillState(x, state));
  if (isO(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillState(x, state)]));
  return v;
}

// ---- layout model: groups (columns) of tabs; persisted by the UI, validated here ----
const MAX_TABS = 12;
let uidN = 0; const uid = () => `p${Date.now().toString(36)}${(uidN++).toString(36)}`;
function layoutFrom(def, id) {
  const l = def.layouts.find((x) => x.id === id) || def.layouts[0];
  return { v: 1, focus: 0, groups: l.groups.map((g) => ({ active: 0, tabs: g.map((t) => ({ k: uid(), pane: t.pane, args: t.args || {} })) })) };
}
function layoutValid(state, paneIds) {
  return isO(state) && state.v === 1 && Array.isArray(state.groups) && state.groups.length >= 1 && state.groups.length <= 4 && state.groups.every((g) => isO(g) && Array.isArray(g.tabs) && g.tabs.length >= 1 && g.tabs.every((t) => isO(t) && typeof t.k === "string" && paneIds.includes(t.pane) && isO(t.args)) && Number.isInteger(g.active) && g.active >= 0 && g.active < g.tabs.length) && Number.isInteger(state.focus) && state.focus >= 0 && state.focus < state.groups.length && state.groups.reduce((n, g) => n + g.tabs.length, 0) <= MAX_TABS;
}
const clone = (v) => JSON.parse(JSON.stringify(v));
function layoutOpen(state, pane, args = {}) {
  const s = clone(state);
  // the same pane anywhere (with any arguments) is reused and focused, so a repeated command never piles up tabs or duplicates a pane in another column
  for (const [gi, g] of s.groups.entries()) { const ti = g.tabs.findIndex((t) => t.pane === pane); if (ti >= 0) { if (JSON.stringify(g.tabs[ti].args) !== JSON.stringify(args)) g.tabs[ti] = { k: uid(), pane, args }; g.active = ti; s.focus = gi; return { state: s, k: g.tabs[ti].k }; } }
  const g = s.groups[s.focus], tab = { k: uid(), pane, args };
  if (s.groups.reduce((n, x) => n + x.tabs.length, 0) >= MAX_TABS) { const drop = g.tabs.findIndex((t, i) => i !== g.active); if (drop >= 0) g.tabs.splice(drop, 1); }
  g.tabs.push(tab); g.active = g.tabs.length - 1;
  return { state: s, k: tab.k };
}
function layoutClose(state, k) {
  const s = clone(state);
  for (const [gi, g] of s.groups.entries()) { const ti = g.tabs.findIndex((t) => t.k === k); if (ti < 0) continue; g.tabs.splice(ti, 1);
    if (!g.tabs.length) { if (s.groups.length === 1) return state; s.groups.splice(gi, 1); s.focus = Math.min(s.focus, s.groups.length - 1); } else g.active = Math.min(g.active, g.tabs.length - 1); return s; }
  return state;
}
function layoutSplit(state, maxGroups = 4) {
  const s = clone(state), g = s.groups[s.focus];
  if (g.tabs.length < 2 || s.groups.length >= maxGroups) return state;
  const [tab] = g.tabs.splice(g.active, 1); g.active = Math.min(g.active, g.tabs.length - 1);
  s.groups.splice(s.focus + 1, 0, { active: 0, tabs: [tab] }); s.focus += 1; return s;
}
function layoutCycle(state, delta) { const s = clone(state), g = s.groups[s.focus]; g.active = (g.active + delta + g.tabs.length) % g.tabs.length; return s; }
function layoutFocus(state, delta) { const s = clone(state); s.focus = (s.focus + delta + s.groups.length) % s.groups.length; return s; }

// ---- watchlists: { v:1, items:[{ ref: "<source>:<series>" }] } ----
const watchValid = (w) => isO(w) && w.v === 1 && Array.isArray(w.items) && w.items.every((i) => isO(i) && typeof i.ref === "string" && /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/.test(i.ref));
const watchAdd = (w, ref, max) => (w.items.some((i) => i.ref === ref) ? { watch: w, status: "exists" } : w.items.length >= max ? { watch: w, status: "full" } : { watch: { v: 1, items: [...w.items, { ref }] }, status: "added" });
const watchRemove = (w, ref) => ({ v: 1, items: w.items.filter((i) => i.ref !== ref) });

// ---- SourceEnvelope ----
/** The badge of a source (derived, never stored): synthetic, sandbox, computed, yours or feed. */
function badgeOf(source) {
  if (source.kind === "customer-endpoint" || source.kind === "customer-dataset") return "yours";
  if (source.kind === "public-feed") return "feed";
  if (source.kind === "sandbox-mock") return source.origin === "sandbox-api" ? "sandbox" : source.origin === "computed" ? "computed" : "synthetic";
  return null;
}
const BADGE_LATIN = { synthetic: "SYNTHETIC", sandbox: "SANDBOX", computed: "COMPUTED", yours: "YOURS", feed: "PUBLIC FEED" };
function makeEnvelope(src, o) {
  const fetchedAt = new Date(o.now ?? Date.now()).toISOString(), asOf = o.asOf || fetchedAt, ms = Date.parse(asOf);
  const ls = localStamp(ms, o.offsetMinutes ?? 210);
  const day = /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(asOf);
  const env = {
    schema: "kit.source-envelope.v1",
    source: { id: src.id, name: isO(src.name) ? src.name : { [o.lang || "fa"]: String(src.name) }, kind: src.kind, ...(src.origin ? { origin: src.origin } : {}), ...(src.homepage ? { homepage: src.homepage } : {}) },
    asOf, asOfLocal: { gregorian: day ? ls.gregorian.slice(0, 10) : ls.gregorian, jalali: day ? ls.jalali.slice(0, 10) : ls.jalali, tz: o.tz || "Asia/Tehran" },
    fetchedAt, licence: src.licence, freshness: src.freshness, reach: src.reach,
    ...(src.units ? { units: src.units } : {}), ...(src.compliance ? { compliance: src.compliance } : {}),
    provenance: { ...src.provenance, ...(o.basis ? { asOfBasis: o.basis } : {}), ...(o.seed != null ? { seed: o.seed } : {}) },
    data: o.data,
  };
  return env;
}
/** Panes never mix sources silently: an envelope is shown only by the pane whose active source it names. */
function acceptEnvelope(validator, env, expectSourceId) {
  const problems = validator.validate(env, "urn:kit:schema:source-envelope:v1").map((p) => `${p.path || "/"}: ${p.message}`);
  if (!problems.length && env.source.id !== expectSourceId) problems.push(`/source/id: this pane reads ${expectSourceId}, the data names ${env.source.id}`);
  return problems;
}

/** The value at a JSON pointer: undefined when a key is missing, null when the answer says null at or above it. */
function valueAt(json, pointer) {
  let v = json;
  for (const k of String(pointer || "").split("/").slice(1)) { if (v == null) return v; v = v[k.replace(/~1/g, "/").replace(/~0/g, "~")]; }
  return v;
}
/** An adapter's declared rows pointer: absence is a declared empty state. `null` (a monitor that has not run yet, a `last` with nothing in it) is no rows, []; a missing key or a non-array stays undefined, which the caller refuses. */
function rowsAt(json, pointer) { const v = valueAt(json, pointer); return v === null ? [] : v; }

const DAY_MS = 86400000, dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
/** The last `days` ELAPSED days of a dated series (by its date axis, never by sample count: 30 monthly samples are not 30 days). */
function sliceByDays(dates, values, days) {
  if (!dates.length) return { dates: [], values: [] };
  const from = dayMs(dates[dates.length - 1]) - (days - 1) * DAY_MS;
  let i = dates.findIndex((d) => dayMs(d) >= from); if (i < 0) i = 0;
  return { dates: dates.slice(i), values: values.slice(i) };
}
/** The ranges a date axis can honestly offer: it spans at least that many days and the range holds two points to draw. */
function rangesFor(dates, options = [30, 90, 365]) {
  if (dates.length < 2) return [];
  const span = (dayMs(dates[dates.length - 1]) - dayMs(dates[0])) / DAY_MS + 1;
  return options.filter((n) => n <= span && sliceByDays(dates, dates, n).dates.length >= 2);
}

/** What a kept dataset is on disk: the canonical SourceEnvelope itself (rows, asOf, basis, provenance) and its schema, nothing derived. */
function keptDataset(entry) { return { v: 2, kind: "dataset", envelope: entry.envelope, schema: entry.schema }; }
/** A kept record back to a source entry. The storage key is the identity (`id`); the record is validated as a SourceEnvelope naming that id and its rows against its schema. Returns { entry } or { problems }. */
function restoreKept(validator, id, v, { maxRows = Infinity } = {}) {
  if (!v || v.kind !== "dataset" || v.v !== 2 || !isO(v.envelope)) return { problems: ["not a kept dataset (v2)"] };
  const problems = acceptEnvelope(validator, v.envelope, id), rows = v.envelope?.data?.rows;
  if (!problems.length && !Array.isArray(rows)) problems.push("/data/rows: not an array");
  if (!problems.length && rows.length > maxRows) problems.push("/data/rows: over the row cap");
  if (!problems.length && isO(v.schema)) problems.push(...checkRows(validator, rows, v.schema, 3));
  return problems.length ? { problems } : { entry: { id, envelope: v.envelope, schema: v.schema || inferSchema(rows) } };
}

/** The one mapping between a kept source and its storage key (save, restore and Forget all use it): the key is the identity. */
const keptKey = (id) => `byo.${id}`;
const idOfKeptKey = (key) => (key.startsWith("byo.") ? key.slice(4) : null);
/** Every kept record of a store, [{ key, value }] (key without the page namespace): { entries, dropped, next } where `next` is above every restored `byo.N`, so a new source never reuses an id. */
function restoreAll(validator, records, opts = {}) {
  const entries = [], dropped = []; let next = 0;
  for (const { key, value } of records) {
    const id = idOfKeptKey(key), r = id ? restoreKept(validator, id, value, opts) : { problems: ["not a kept-dataset key"] };
    if (r.entry) { entries.push(r.entry); next = Math.max(next, Number(/^byo\.(\d+)$/.exec(id)?.[1]) || 0); } else dropped.push({ key, problems: r.problems });
  }
  return { entries, dropped, next };
}

// ---- BYO: the visitor's own endpoint or dataset, browser side only ----
/** Why a URL may not be called (https only, no credentials in the URL, no fragment, a host name); null when it may. */
function checkEndpoint(raw) {
  let u; try { u = new URL(String(raw).trim()); } catch { return "url"; /* not a URL: the problem reported is the url field */ }
  if (u.protocol !== "https:") return "https";
  if (u.username || u.password) return "credentials";
  if (u.hash) return "fragment";
  if (!u.hostname || !u.hostname.includes(".")) return "host";
  return null;
}
/** Read a response body up to `max` bytes (a Content-Length above the cap fails before reading; a stream is cut at the cap). */
async function readCapped(res, max) {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw Object.assign(new Error("size"), { code: "size" });
  if (!res.body || !res.body.getReader) { const t = await res.text(); if (t.length > max) throw Object.assign(new Error("size"), { code: "size" }); return t; }
  const rd = res.body.getReader(), parts = []; let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; if (n > max) { try { await rd.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ } throw Object.assign(new Error("size"), { code: "size" }); } parts.push(value); }
  const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}
/** Fetch the visitor's endpoint from the visitor's browser: https, no cookies, no redirects, a time cap and a size cap. */
async function fetchEndpoint(url, { fetchFn = globalThis.fetch, key, keyHeader, timeoutMs = 8000, maxBytes = 1048576 } = {}) {
  const bad = checkEndpoint(url); if (bad) throw Object.assign(new Error(bad), { code: bad });
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { accept: "application/json, text/csv;q=0.8" }; if (key && keyHeader && /^[A-Za-z0-9-]{1,40}$/.test(keyHeader)) headers[keyHeader] = key;
    const res = await fetchFn(String(url).trim(), { method: "GET", headers, credentials: "omit", mode: "cors", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: ctl.signal });
    if (!res.ok) throw Object.assign(new Error(`http ${res.status}`), { code: "http", status: res.status });
    const text = await readCapped(res, maxBytes);
    let json; try { json = JSON.parse(text); } catch { throw Object.assign(new Error("parse"), { code: "parse" }); }
    return { json, bytes: text.length, date: res.headers.get("last-modified") || res.headers.get("date") };
  } catch (e) {
    if (e && e.code) throw e;
    if (e && e.name === "AbortError") throw Object.assign(new Error("timeout"), { code: "timeout" });
    throw Object.assign(new Error("network"), { code: "network" });   // CORS refusals and network errors look the same to a page
  } finally { clearTimeout(timer); }
}
/** CSV (RFC 4180: quotes, doubled quotes, CRLF; the delimiter is , ; or tab, found in the first line) → { columns, rows }. */
function parseCsv(text, { maxRows = 5000 } = {}) {
  const src = String(text).replace(/^﻿/, ""), first = src.split(/\r?\n/, 1)[0];
  const delim = [",", ";", "\t"].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && !cell) q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; if (rows.length > maxRows + 1) throw Object.assign(new Error("rows"), { code: "rows" }); }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); if (row.some((x) => x !== "")) rows.push(row); }
  if (q) throw Object.assign(new Error("parse"), { code: "parse" });
  if (rows.length < 1) throw Object.assign(new Error("parse"), { code: "parse" });
  const columns = rows[0].map((h, i) => (h.trim() || `col${i + 1}`)), body = rows.slice(1);
  if (body.length > maxRows) throw Object.assign(new Error("rows"), { code: "rows" });
  return { columns, rows: body.map((r) => Object.fromEntries(columns.map((c, i) => { const v = (r[i] ?? "").trim(); const n = v !== "" && /^-?\d+(\.\d+)?$/.test(fold(v)) ? Number(fold(v)) : v; return [c, n]; }))) };
}
/** The rows of a JSON answer: the array itself, `pointer`'s array, or the first array of objects found; null if there is none. */
function findRows(json, pointer) {
  if (pointer) { let v = json; for (const k of pointer.split("/").slice(1)) v = v == null ? v : v[k.replace(/~1/g, "/").replace(/~0/g, "~")]; return Array.isArray(v) ? v : null; }
  if (Array.isArray(json)) return json;
  if (isO(json)) { for (const v of Object.values(json)) if (Array.isArray(v) && v.length && isO(v[0])) return v; for (const v of Object.values(json)) if (isO(v)) { const r = findRows(v); if (r) return r; } }
  return null;
}
/** A JSON Schema (2020-12) inferred from sample rows: each key's type and, when every sampled row has it, required. */
function inferSchema(rows, sample = 200) {
  const take = rows.slice(0, sample), props = Object.create(null), count = Object.create(null);   // no prototype: a key named __proto__ is data
  for (const r of take) for (const [k, v] of Object.entries(r)) { count[k] = (count[k] || 0) + 1; const t = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v; (props[k] ||= new Set()).add(t); }
  const properties = Object.create(null); for (const [k, ts] of Object.entries(props)) { const l = [...ts]; if (l.includes("integer") && l.includes("number")) l.splice(l.indexOf("integer"), 1); properties[k] = { type: l.length === 1 ? l[0] : l }; }
  return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "array", items: { type: "object", properties, required: Object.keys(count).filter((k) => count[k] === take.length) } };
}
/** Check rows against a schema (the user's own or the inferred one): [] when they match, else messages with the row index. */
function checkRows(validator, rows, schema, limit = 5) {
  const out = validator.validate(rows, schema).map((p) => `${p.path || "/"}: ${p.message}`);
  return out.slice(0, limit);
}
// A key kept for the session is encrypted (AES-GCM, key from the visitor's passphrase by PBKDF2) before sessionStorage; never localStorage.
const b64 = (u8) => btoa(String.fromCharCode(...u8)), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sealSecret(secret, pass, subtle = globalThis.crypto.subtle) {
  const enc = new TextEncoder(), salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const base = await subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(secret)));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}
async function openSecret(sealed, pass, subtle = globalThis.crypto.subtle) {
  const o = JSON.parse(sealed), enc = new TextEncoder();
  const base = await subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "PBKDF2", salt: unb64(o.salt), iterations: 210000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, key, unb64(o.ct)));
}

const KitWorkbench = { fillState, fold, tokenize, matchExact, suggest, parseLine, bindArgs, paneArgs, parseDate, jalaliToGregorian, gregorianToJalali, jalaliFor, isLeapJalali, localStamp, weekdayIndex, mulberry32, seededSeries, calculate, layoutFrom, layoutValid, layoutOpen, layoutClose, layoutSplit, layoutCycle, layoutFocus, MAX_TABS, watchValid, watchAdd, watchRemove, badgeOf, BADGE_LATIN, makeEnvelope, acceptEnvelope, checkEndpoint, readCapped, fetchEndpoint, parseCsv, findRows, valueAt, rowsAt, sliceByDays, rangesFor, keptDataset, keptKey, restoreKept, restoreAll, inferSchema, checkRows, sealSecret, openSecret, toDigits, createValidator };
