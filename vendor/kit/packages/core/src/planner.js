/**
 * planner(config, content): what every series publishes on which day. Pure and deterministic.
 *   due(day)            → entries publishing that day (topic with content, report (tables even without a theme
 *                          when series.empty = "tables"), term by rotation)
 *   slotsOn(day)        → every slot that day, including empty ones ({ missing: true })
 *   range(from, to)     → due entries of every day in [from, to]
 *   find(series, ref)   → the entry for a date, month key, term slug or entry slug (or null)
 *   rotation(series)    → a term series' publishing order;   dayOf(series, slug) → day number or null
 * Entry: { series, kind, day, date, key, slug, item, publishAt, number?, category?, missing }
 *   day: day number (days since 1970-01-01); date: ISO date of the slot; publishAt: ISO UTC of `at` in site.timezone;
 *   number: 1-based position in the rotation (term series).
 */
import { defineConfig } from "./config.js";
import { normalizeContent } from "./content.js";
import { toDay, iso, jsWeekday, ymd, monthLength, monthKey, monthIndex, zonedToUtc } from "./dates.js";
import { fill } from "./i18n.js";

/** Round-robin across categories: each category's first term (in category order), then each one's second, … */
export function roundRobin(categories, terms) {
  const by = new Map(categories.map((c) => [c.key, []]));
  for (const t of terms) { if (!by.has(t.category)) by.set(t.category, []); by.get(t.category).push(t); }
  const lists = [...by.values()], out = [];
  for (let r = 0; out.length < terms.length; r++) for (const l of lists) if (l[r]) out.push(l[r]);
  return out;
}

export function planner(config, content = {}) {
  config = defineConfig(config);
  const norm = normalizeContent(config, content);
  const tz = config.site.timezone;

  const S = config.series.map((s) => {
    const c = norm[s.id] || { items: [], categories: [] };
    const p = { s, c, start: s.start ? toDay(s.start) : null, end: s.end ? toDay(s.end) : null };
    if (s.kind === "topic") p.by = new Map(c.items.map((w) => [w.date, w]));
    if (s.kind === "report") p.by = new Map(c.items.map((r) => [r.month, r]));
    if (s.kind === "term") {
      p.order = s.rotation === "sequential" ? [...c.items] : roundRobin(c.categories, c.items);
      p.index = new Map(p.order.map((t, i) => [t.slug, i]));
      p.cats = new Map(c.categories.map((x) => [x.key, x]));
      p.first = p.start == null ? null : firstSlotFrom(s, p.start);
    }
    return p;
  });
  const byId = new Map(S.map((p) => [p.s.id, p]));
  const get = (id) => { const p = byId.get(typeof id === "string" ? id : id?.id); if (!p) throw new Error(`unknown series "${id}"`); return p; };

  function isSlot(s, n) {
    if (s.every === "day") return true;
    if (s.every === "week") return jsWeekday(n) === s.on;
    const { y, m, d } = ymd(config, n), len = monthLength(config, y, m);
    return d === (s.on === -1 ? len : Math.min(s.on, len));
  }
  function firstSlotFrom(s, n) { for (let d = n; d < n + 400; d++) if (isSlot(s, d)) return d; return n; }
  function slotIndex(p, n) {
    if (p.first == null || n < p.first) return -1;
    if (p.s.every === "day") return n - p.first;
    if (p.s.every === "week") return Math.floor((n - p.first) / 7);
    return monthIndex(monthKey(config, n)) - monthIndex(monthKey(config, p.first));
  }
  function slotDay(p, idx) {
    if (p.s.every === "day") return p.first + idx;
    if (p.s.every === "week") return p.first + idx * 7;
    let d = p.first; for (let i = 0; i < idx; i++) d = firstSlotFrom(p.s, d + 1);
    return d;
  }
  const slugOf = (s, vars) => (typeof s.slug === "function" ? s.slug(vars) : fill(s.slug, vars));

  function entry(p, n) {
    const s = p.s, date = iso(n);
    const e = { series: s.id, kind: s.kind, day: n, date, key: null, slug: null, item: null, publishAt: zonedToUtc(n, s.at, tz), missing: false };
    if (s.kind === "topic") { e.key = date; e.item = p.by.get(date) || null; e.slug = slugOf(s, { id: s.id, date, month: monthKey(config, n) }); }
    else if (s.kind === "report") { e.key = monthKey(config, n); e.item = p.by.get(e.key) || null; e.slug = slugOf(s, { id: s.id, date, month: e.key }); }
    else {
      const idx = slotIndex(p, n);
      e.number = idx + 1;
      e.item = p.order[idx] || null;
      e.key = e.item?.slug ?? null;
      e.category = e.item ? p.cats.get(e.item.category) || null : null;
      e.slug = e.item ? slugOf(s, { id: s.id, date, slug: e.item.slug, number: e.number }) : null;
    }
    e.missing = !e.item;
    return e;
  }
  const inWindow = (p, n) => (p.start == null || n >= p.start) && (p.end == null || n <= p.end);

  function slotsOn(day) {
    const n = toDay(day), out = [];
    for (const p of S) if (inWindow(p, n) && isSlot(p.s, n)) out.push(entry(p, n));
    return out;
  }
  const publishes = (e) => !e.missing || (e.kind !== "term" && config.series.find((s) => s.id === e.series).empty === "tables");
  const due = (day) => slotsOn(day).filter(publishes);
  function range(from, to) {
    const a = toDay(from), b = toDay(to), out = [];
    for (let d = a; d <= b; d++) out.push(...due(d));
    return out;
  }

  function find(seriesId, ref) {
    const p = get(seriesId), s = p.s;
    if (ref == null) return null;
    if (s.kind === "term") {
      let i = p.index.get(ref);
      if (i == null) { const t = p.order.findIndex((x, k) => slugOf(s, { id: s.id, slug: x.slug, number: k + 1, date: "" }) === ref); i = t < 0 ? null : t; }
      if (i == null || p.first == null) return null;
      return entry(p, slotDay(p, i));
    }
    let n = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) n = toDay(ref);
    else if (s.kind === "report" && /^\d{4}-\d{2}$/.test(ref)) {
      const [y, m] = ref.split("-").map(Number);
      for (let d = 1; d <= monthLength(config, y, m); d++) { const x = monthDay(y, m, d); if (isSlot(s, x)) { n = x; break; } }
    } else {
      const hit = (s.kind === "topic" ? [...p.by.keys()].map((k) => toDay(k)) : [...p.by.keys()].map((k) => find(s.id, k)?.day).filter((x) => x != null))
        .find((d) => entry(p, d).slug === ref);
      n = hit ?? null;
    }
    if (n == null || !isSlot(s, n)) return null;
    return entry(p, n);
  }
  const monthDay = (y, m, d) => (config.calendar.system === "jalali" ? toDay(`${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`) : toDay(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`));

  const rotation = (id) => [...(get(id).order || [])];
  function dayOf(id, slug) { const p = get(id); const i = p.index?.get(slug); return i == null || p.first == null ? null : slotDay(p, i); }

  return { config, content: norm, due, slotsOn, range, find, rotation, dayOf, isSlot: (id, day) => isSlot(get(id).s, toDay(day)) };
}
