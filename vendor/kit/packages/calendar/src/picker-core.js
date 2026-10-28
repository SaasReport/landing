/* Calendar date picker core — the DatePicker web component class on the calendar engine, without registering an
   element: a project subclasses it (static tag / prefix) and calls definePicker(). picker.js registers <kit-date-picker>.
   Jalali month grid (Saturday first, Persian digits, RTL), business-day aware (weekend profile,
   official holidays as a solid orange node, predicted lunar holidays as a dashed hollow node),
   T+n settlement preview, single or range selection, inline or as a popup around a text input.
   The lunar Hijri date it shows is Umm al-Qura by default (`hijri="civil"` for the tabular calendar).
   Brand book v3: flat, orange + black + rail gray, circular nodes; no glow, no gradients.

   The pure helpers below (monthMatrix, parseInput, isDisabled, rangeSelect, moveKey …) carry all
   the logic and run in Node; the custom element is registered only where a DOM exists. */
import * as C from "./index.js";
import { COPY, fill } from "./copy.js";
import { toHijri, HIJRI_VARIANTS } from "./hijri.js";

const T = COPY.picker;
export const PREDICTED_NOTE = T.predicted;
export const WEEKDAY_SHORT = T.weekdayShort;
const pad = (n) => String(n).padStart(2, "0");

/* ------------------------------------------------------------------ pure helpers */
/** Jalali text of a day number: "1405/07/08" (or Persian digits with { digits: "fa" }). */
export function formatJalali(n, { digits = "latin" } = {}) {
  const j = C.toJalali(n), s = `${j.jy}/${pad(j.jm)}/${pad(j.jd)}`;
  return digits === "fa" ? C.fa(s) : s;
}
const inRange = (n) => { const jy = C.toJalali(n).jy; return jy >= C.RANGE.min && jy <= C.RANGE.max; };

function parseOne(s) {
  if (!/^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/.test(s)) return null;
  try { const n = C.parseDate(s); return Number.isFinite(n) && inRange(n) ? n : null; } catch { return null; /* what the user typed is not a date: no selection (null) */ }
}
/** Parse what a person typed. Persian, Arabic-Indic or Latin digits; "/", "-" or "." separators;
 *  Jalali (year < 1700) or Gregorian. Returns { date } | { start, end } | { jy, jm, partial: true } | null. */
export function parseInput(text) {
  const s = C.latin(String(text ?? "")).replace(/[‌‎‏]/g, "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const parts = s.split(/\s*(?:–|—|~|\sتا\s|\s-\s)\s*/);
  if (parts.length === 2) {
    const a = parseOne(parts[0].trim()), b = parseOne(parts[1].trim());
    return a != null && b != null ? { start: Math.min(a, b), end: Math.max(a, b) } : null;
  }
  const n = parseOne(s);
  if (n != null) return { date: n };
  const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.]?$/);
  if (m) {
    const jy = +m[1], jm = +m[2];
    if (jy >= C.RANGE.min && jy <= C.RANGE.max && jm >= 1 && jm <= 12) return { jy, jm, partial: true };
  }
  return null;
}
/** min/max attribute value (ISO or Jalali, any digits) → day number, or null. */
export function parseBound(v) {
  if (v == null || String(v).trim() === "") return null;
  if (typeof v === "number") return v;
  const r = parseInput(v);
  return r && r.date != null ? r.date : null;
}
/** A day is disabled when it falls outside [min, max], or — with businessOnly — is not a business day. */
export function isDisabled(n, { min = null, max = null, businessOnly = false, profile = "bank" } = {}) {
  if (min != null && n < min) return true;
  if (max != null && n > max) return true;
  return !!businessOnly && !C.isBusinessDay(n, { profile });
}
/** Range selection: first pick sets start; second sets end (swapping if earlier); a third restarts. */
export function rangeSelect(state, n) {
  const s = state || {};
  if (s.start == null || s.end != null) return { start: n, end: null };
  if (n < s.start) return { start: n, end: s.start };
  return { start: s.start, end: n };
}
export function shiftMonth(jy, jm, k) {
  const idx = jy * 12 + (jm - 1) + k, y = Math.floor(idx / 12), m = (idx % 12) + 1;
  if (y < C.RANGE.min) return { jy: C.RANGE.min, jm: 1 };
  if (y > C.RANGE.max) return { jy: C.RANGE.max, jm: 12 };
  return { jy: y, jm: m };
}
/** Same day-of-month k months away, clamped to the month length (31 Shahrivar → 30 Mehr). */
export function addMonths(n, k) {
  const j = C.toJalali(n), t = shiftMonth(j.jy, j.jm, k);
  return C.fromJalali(t.jy, t.jm, Math.min(j.jd, C.monthLength(t.jy, t.jm)));
}
/** Keyboard model for an RTL grid: the next day sits to the LEFT. Returns the new day or null. */
export function moveKey(n, key, { shift = false, rtl = true } = {}) {
  const lr = rtl ? 1 : -1;
  switch (key) {
    case "ArrowLeft": return n + lr;
    case "ArrowRight": return n - lr;
    case "ArrowDown": return n + 7;
    case "ArrowUp": return n - 7;
    case "PageDown": return addMonths(n, shift ? 12 : 1);
    case "PageUp": return addMonths(n, shift ? -12 : -1);
    case "Home": return n - C.weekday(n);
    case "End": return n + (6 - C.weekday(n));
    default: return null;
  }
}
const holList = (n) => C.holidaysOn(n).map((h) => ({ title: h.title, status: h.status }));

/** Month grid, Saturday first: weeks of 7 cells, null where the day belongs to another month. */
export function monthMatrix(jy, jm, o = {}) {
  const { profile = "bank", value = null, range = null, preview = null, today = C.today() } = o;
  const first = C.fromJalali(jy, jm, 1), length = C.monthLength(jy, jm), lead = C.weekday(first);
  const weekend = C.PROFILES[profile] ? C.PROFILES[profile].weekend : C.PROFILES.bank.weekend;
  let lo = null, hi = null;
  if (range && range.start != null) {
    const end = range.end != null ? range.end : preview;
    if (end != null) [lo, hi] = range.start <= end ? [range.start, end] : [end, range.start];
  }
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= length; d++) {
    const n = first + d - 1, st = C.dayStatus(n, { profile }), hol = holList(n);
    cells.push({
      n, jd: d, iso: C.toISO(n), weekday: C.weekday(n),
      business: st.business, weekend: st.weekend, holiday: hol.length > 0,
      predicted: hol.length > 0 && hol.every((h) => h.status === "predicted"), holidays: hol,
      disabled: isDisabled(n, o), today: n === today,
      selected: range ? n === range.start || n === range.end : n === value,
      rangeStart: lo != null && hi > lo && n === lo, rangeEnd: lo != null && hi > lo && n === hi,
      inRange: lo != null && n > lo && n < hi,
    });
  }
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { jy, jm, title: `${C.J_MONTHS[jm - 1]} ${C.fa(jy)}`, length, first, weekend, weeks };
}
/** The lunar Hijri date the picker shows. Umm al-Qura by default (the published calendar most readers
 *  check against); "civil" (the tabular calendar the engine's holiday prediction uses) on request. Falls back to
 *  civil where the runtime's Intl has no Umm al-Qura table or the day is outside it, so a picker never breaks. */
export function hijriLong(n, variant = "umalqura") {
  let h;
  if (variant !== "civil") { try { h = toHijri(n, "umalqura"); } catch { h = null; /* outside the Umm al-Qura range: the Hijri line is not shown */ } }
  if (!h) h = toHijri(n, "civil");
  return `${C.fa(h.hd)} ${C.H_MONTHS[h.hm - 1]} ${C.fa(h.hy)}`;
}
const hijriVariant = (v) => (HIJRI_VARIANTS.includes(v) ? v : "umalqura");
/** Everything a form needs about one day — the `change` event detail. `hijri`: "umalqura" (default) or "civil". */
export function dayDetail(n, { profile = "bank", settlement = null, hijri = "umalqura" } = {}) {
  const d = C.describe(n, { profile });
  const out = {
    jalali: d.jalali.text, iso: d.iso, date: n, long: d.jalali.long, gregorian: d.gregorian.long, hijri: hijriLong(n, hijriVariant(hijri)), hijriVariant: hijriVariant(hijri),
    weekday: d.weekday_fa, business: d.business, weekend: d.weekend, holidays: holList(n),
  };
  if (settlement != null && Number.isInteger(+settlement)) {
    const t = +settlement, r = C.settlement(n, t, { profile });
    out.settlement = { t, date: r.date, iso: C.toISO(r.date), jalali: formatJalali(r.date), long: C.describe(r.date).jalali.long, uncertain: r.uncertain };
  }
  return out;
}

/* ------------------------------------------------------------------ the element */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICONS = {
  // In RTL "back" points right.
  prev: svg("M9 6l6 6-6 6"), next: svg("M15 6l-6 6 6 6"),
  prevY: svg("M6 6l6 6-6 6M12 6l6 6-6 6"), nextY: svg("M18 6l-6 6 6 6M12 6l-6 6 6 6"),
  cal: svg("M4 7h16M4 7v12h16V7M4 7V5h16v2M8 3v4M16 3v4M8 11h2M14 11h2M8 15h2M14 15h2"),
};
let uid = 0;

const Base = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

export class DatePicker extends Base {
  /** The element name a project registers and the prefix of every class the picker renders (the theme CSS uses the
   *  same two values: tokens.picker.tag / tokens.picker.prefix). A project subclasses and overrides both. */
  static tag = "kit-date-picker";
  static prefix = "kitdp";
  get _p() { return this.constructor.prefix; }
  static get observedAttributes() { return ["profile", "business-only", "settlement", "range", "min", "max", "value", "theme", "digits", "hijri"]; }

  constructor() {
    super();
    this._id = `${this._p}${++uid}`;
    this._value = null; this._range = { start: null, end: null }; this._preview = null;
    this._focus = null; this._hover = null; this._view = null; this._open = false;
    this._onDocDown = (e) => this._docDown(e);
    this._onReflow = () => this._open && this._place();
  }

  /* ---------------- attributes → options */
  get _opts() {
    const profile = C.PROFILES[this.getAttribute("profile")] ? this.getAttribute("profile") : "bank";
    return { profile, businessOnly: this.hasAttribute("business-only"), min: parseBound(this.getAttribute("min")), max: parseBound(this.getAttribute("max")) };
  }
  get _isRange() { return this.hasAttribute("range"); }
  get _settle() { const s = this.getAttribute("settlement"); return s != null && s !== "" && Number.isInteger(+s) && +s >= 0 ? +s : null; }
  get _digits() { return this.getAttribute("digits") === "latin" ? "latin" : "fa"; }
  get _hijri() { return hijriVariant(this.getAttribute("hijri")); }
  get _popup() { return !!this._input; }

  /* ---------------- public API */
  /** ISO date (single) or "start/end" ISO interval (range); "" when empty. */
  get value() {
    if (this._isRange) return this._range.start != null && this._range.end != null ? `${C.toISO(this._range.start)}/${C.toISO(this._range.end)}` : "";
    return this._value != null ? C.toISO(this._value) : "";
  }
  set value(v) {
    const s = String(v ?? "");
    const r = parseInput(s.includes("/") && /^\d{4}-/.test(s) ? s.replace("/", " – ") : s);
    if (this._isRange) this._range = r && r.start != null ? { start: r.start, end: r.end } : r && r.date != null ? { start: r.date, end: r.date } : { start: null, end: null };
    else this._value = r && r.date != null ? r.date : null;
    const n = this._isRange ? this._range.start : this._value;
    if (n != null) { this._focus = n; this._setView(n); }
    this._writeInput(false);
    this._render();
  }
  /** Jalali text ("1405/07/08", or "1405/07/08 – 1405/07/12" for a range). */
  get jalali() {
    if (this._isRange) return this._range.start != null && this._range.end != null ? `${formatJalali(this._range.start)} – ${formatJalali(this._range.end)}` : "";
    return this._value != null ? formatJalali(this._value) : "";
  }
  get valueAsNumber() { return this._isRange ? this._range.start : this._value; }
  get start() { return this._range.start != null ? C.toISO(this._range.start) : ""; }
  get end() { return this._range.end != null ? C.toISO(this._range.end) : ""; }
  get detail() { return this._detail(); }
  get isOpen() { return this._open; }
  show() { this._openPanel(false); }
  close() { this._closePanel(false); }

  /* ---------------- lifecycle */
  connectedCallback() {
    if (!this._panel) this._build();
    document.addEventListener("pointerdown", this._onDocDown, true);
    window.addEventListener("resize", this._onReflow);
    window.addEventListener("scroll", this._onReflow, true);
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._onDocDown, true);
    window.removeEventListener("resize", this._onReflow);
    window.removeEventListener("scroll", this._onReflow, true);
  }
  attributeChangedCallback(name, old, val) {
    if (!this._panel || old === val) return;
    if (name === "value") { this.value = val; return; }
    if (name === "range") { this._range = { start: this._value, end: this._value }; }
    if (name === "theme") this._applyTheme();
    this._render();
  }

  _build() {
    const forId = this.getAttribute("for");
    this._input = (forId && document.getElementById(forId)) || this.querySelector("input");
    this.classList.add(`${this._p}-host`);
    const p = document.createElement("div");
    p.className = `${this._p}`;
    p.id = `${this._id}-panel`;
    p.dir = "rtl"; p.lang = "fa";
    this._panel = p;
    this._applyTheme();
    if (this._popup) {
      this.classList.add(`${this._p}-host--popup`);
      p.classList.add(`${this._p}--popup`);
      p.setAttribute("role", "dialog");
      p.setAttribute("aria-label", T.dialog);
      p.hidden = true;
      if ("popover" in HTMLElement.prototype) p.popover = "manual";
      const inp = this._input;
      inp.setAttribute("aria-haspopup", "dialog");
      inp.setAttribute("aria-expanded", "false");
      inp.setAttribute("aria-controls", p.id);
      inp.setAttribute("autocomplete", "off");
      const tg = document.createElement("button");
      tg.type = "button"; tg.className = `${this._p}-toggle`;
      tg.setAttribute("aria-label", T.open); tg.setAttribute("aria-haspopup", "dialog"); tg.setAttribute("aria-expanded", "false"); tg.setAttribute("aria-controls", p.id);
      tg.title = T.pick;
      tg.innerHTML = ICONS.cal;
      this._toggle = tg;
      if (this.contains(inp)) inp.after(tg); else this.append(tg);
      tg.addEventListener("click", () => (this._open ? this._closePanel(true) : this._openPanel(true)));
      inp.addEventListener("input", () => this._fromInput());
      inp.addEventListener("click", () => { if (!this._open) this._openPanel(false); });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || (e.altKey && e.key === "ArrowDown")) { e.preventDefault(); this._openPanel(true); }
        else if (e.key === "Escape" && this._open) { e.preventDefault(); this._closePanel(false); }
        else if (e.key === "Enter" && this._open) { this._closePanel(false); }
        else if (e.key === "Tab" && this._open) this._closePanel(false);
      });
    }
    this.append(p);
    // initial value: attribute, else what the input holds
    const init = this.getAttribute("value") ?? (this._input ? this._input.value : "");
    const r = parseInput(init.includes("/") && /^\d{4}-/.test(init) ? init.replace("/", " – ") : init);
    if (r && r.start != null) this._range = { start: r.start, end: r.end };
    if (r && r.date != null) { this._value = r.date; if (this._isRange) this._range = { start: r.date, end: r.date }; }
    this._focus = (this._isRange ? this._range.start : this._value) ?? C.today();
    this._setView(this._focus);
    if (this.getAttribute("value") && this._input) this._writeInput(false);

    p.addEventListener("click", (e) => this._click(e));
    p.addEventListener("keydown", (e) => this._key(e));
    p.addEventListener("pointerover", (e) => { const c = e.target.closest("[data-day]"); if (c) this._hoverDay(+c.dataset.day); });
    p.addEventListener("pointerleave", () => this._hoverDay(null));
    p.addEventListener("focusin", (e) => { const c = e.target.closest("[data-day]"); if (c && +c.dataset.day !== this._focus) { this._focus = +c.dataset.day; this._sync(); } });
    p.addEventListener("focusout", (e) => {
      if (!this._popup || !this._open) return;
      const to = e.relatedTarget;
      if (to && !this.contains(to) && to !== this._input) this._closePanel(false);
    });
    this._render();
  }
  _applyTheme() {
    const t = this.getAttribute("theme");
    this._panel.classList.toggle(`${this._p}--dark`, t === "dark");
    this._panel.classList.toggle(`${this._p}--light`, t === "light");
    this._panel.classList.toggle(`${this._p}--auto`, t === "auto");
  }
  _setView(n) { const j = C.toJalali(n); this._view = { jy: j.jy, jm: j.jm }; }

  /* ---------------- rendering */
  _render() {
    if (!this._panel) return;
    const o = this._opts, v = this._view;
    const m = monthMatrix(v.jy, v.jm, { ...o, value: this._value, range: this._isRange ? this._range : null, preview: this._isRange ? this._preview : null });
    // keep the roving focus inside the visible month
    if (!(this._focus >= m.first && this._focus < m.first + m.length)) {
      const sel = this._isRange ? this._range.start : this._value;
      this._focus = sel != null && sel >= m.first && sel < m.first + m.length ? sel : m.first + Math.min(C.toJalali(this._focus ?? m.first).jd, m.length) - 1;
    }
    const hid = `${this._id}-title`, fid = `${this._id}-foot`;
    const head = `<div class="${this._p}__head">
        <button type="button" class="${this._p}__nav" data-nav="-12" aria-label="${T.prevYear}" title="${T.prevYear}">${ICONS.prevY}</button>
        <button type="button" class="${this._p}__nav" data-nav="-1" aria-label="${T.prevMonth}" title="${T.prevMonth}">${ICONS.prev}</button>
        <div class="${this._p}__title" id="${hid}" aria-live="polite">${esc(m.title)}</div>
        <button type="button" class="${this._p}__nav" data-nav="1" aria-label="${T.nextMonth}" title="${T.nextMonth}">${ICONS.next}</button>
        <button type="button" class="${this._p}__nav" data-nav="12" aria-label="${T.nextYear}" title="${T.nextYear}">${ICONS.nextY}</button>
      </div>`;
    const wk = `<div role="row" class="${this._p}__row ${this._p}__wk">${C.WEEKDAYS.map((w, i) => `<span role="columnheader" aria-label="${w}" title="${w}"${m.weekend.includes(i) ? ' class="is-off"' : ""}>${WEEKDAY_SHORT[i]}</span>`).join("")}</div>`;
    const rows = m.weeks.map((w) => `<div role="row" class="${this._p}__row">${w.map((c) => (c ? this._cell(c, fid) : `<span role="gridcell" class="${this._p}__d is-empty"></span>`)).join("")}</div>`).join("");
    this._panel.innerHTML = `${head}
      <div role="grid" class="${this._p}__grid" aria-labelledby="${hid}"${this._isRange ? ' aria-multiselectable="true"' : ""}>${wk}${rows}</div>
      <div class="${this._p}__foot" id="${fid}" aria-live="polite"></div>
      <div class="${this._p}__acts"><button type="button" class="${this._p}__act" data-today>${T.today}</button>${this._popup ? `<button type="button" class="${this._p}__act" data-close>${T.close}</button>` : ""}</div>`;
    this._foot();
    if (this._open) this._place();
  }
  _cell(c, fid) {
    const cls = [`${this._p}__d`];
    if (c.weekend) cls.push("is-weekend");
    if (c.holiday) cls.push(c.predicted ? "is-pred" : "is-hol");
    if (c.disabled) cls.push("is-disabled");
    if (c.today) cls.push("is-today");
    if (c.selected) cls.push("is-sel");
    if (c.rangeStart) cls.push("is-start");
    if (c.rangeEnd) cls.push("is-end");
    if (c.inRange) cls.push("is-in");
    const d = C.describe(c.n);
    const titles = c.holidays.map((h) => h.title + (h.status === "predicted" ? ` (${PREDICTED_NOTE})` : ""));
    const label = [d.jalali.long, ...(c.holiday ? [fill(T.holiday, { titles: titles.join(T.comma) })] : c.weekend ? [T.weekend] : []), ...(c.disabled ? [T.disabled] : [])].join(T.comma);
    const tip = c.holiday ? titles.join("\n") : "";
    return `<span role="gridcell" class="${cls.join(" ")}" data-day="${c.n}" tabindex="${c.n === this._focus ? 0 : -1}" aria-selected="${c.selected || c.inRange}"${c.disabled ? ' aria-disabled="true"' : ""}${c.today ? ' aria-current="date"' : ""} aria-label="${esc(label)}" aria-describedby="${fid}"${tip ? ` title="${esc(tip)}"` : ""}><b>${C.fa(c.jd)}</b>${c.holiday ? `<i class="${this._p}__node" aria-hidden="true"></i>` : ""}</span>`;
  }
  _foot() {
    const f = this._panel.querySelector(`.${this._p}__foot`);
    if (!f) return;
    const n = this._hover ?? this._focus, o = this._opts;
    const d = dayDetail(n, { profile: o.profile, settlement: this._settle, hijri: this._hijri });
    const chip = d.holidays.length ? (d.holidays.every((h) => h.status === "predicted") ? ["pred", T.chipPredicted] : ["hol", T.chipOfficial]) : d.weekend ? ["off", T.chipWeekend] : ["ok", T.chipWork];
    let html = `<div class="${this._p}__f1"><b>${esc(d.long)}</b><span class="${this._p}__chip c-${chip[0]}">${chip[1]}</span></div>
      <div class="${this._p}__f2"><bdi>${esc(d.gregorian)}</bdi>، <bdi>${esc(d.hijri)}</bdi></div>`;
    if (d.holidays.length) html += `<ul class="${this._p}__hols">${d.holidays.map((h) => `<li class="${h.status === "predicted" ? "is-pred" : "is-hol"}"><i aria-hidden="true"></i><span>${esc(h.title)}${h.status === "predicted" ? `<em>${PREDICTED_NOTE}</em>` : ""}</span></li>`).join("")}</ul>`;
    if (d.settlement) html += `<div class="${this._p}__settle" data-settle>${fill(T.settle, { t: d.settlement.t })}<b>${esc(d.settlement.long)}</b>${d.settlement.uncertain ? ` <em>${PREDICTED_NOTE}</em>` : ""}</div>`;
    if (this._isRange && this._range.start != null) {
      const a = this._range.start, b = this._range.end ?? this._preview;
      if (b != null) { const [lo, hi] = a <= b ? [a, b] : [b, a]; const r = C.businessDaysBetween(lo - 1, hi, { profile: o.profile }); html += `<div class="${this._p}__rng">${fill(T.range, { from: esc(C.fa(formatJalali(lo))), to: esc(C.fa(formatJalali(hi))), days: C.fa(hi - lo + 1), business: C.fa(r.business) })}</div>`; }
      else html += `<div class="${this._p}__rng">${T.rangeEnd}</div>`;
    }
    f.innerHTML = html;
  }
  /** Cheap update after focus moves within the visible month. */
  _sync() {
    const cells = this._panel.querySelectorAll("[data-day]");
    for (const c of cells) c.tabIndex = +c.dataset.day === this._focus ? 0 : -1;
    this._foot();
  }
  _hoverDay(n) {
    if (this._hover === n) return;
    this._hover = n;
    if (this._isRange && this._range.start != null && this._range.end == null) { this._preview = n; this._paintRange(); }
    this._foot();
  }
  /** Repaint the in-between highlight without rebuilding the grid (keeps focus and hover target). */
  _paintRange() {
    const a = this._range.start, b = this._range.end ?? this._preview;
    const [lo, hi] = a == null || b == null ? [null, null] : a <= b ? [a, b] : [b, a];
    for (const c of this._panel.querySelectorAll("[data-day]")) {
      const n = +c.dataset.day, sel = n === this._range.start || n === this._range.end, mid = lo != null && n > lo && n < hi;
      c.classList.toggle("is-in", mid);
      c.classList.toggle("is-start", lo != null && hi > lo && n === lo);
      c.classList.toggle("is-end", lo != null && hi > lo && n === hi);
      c.classList.toggle("is-sel", sel);
      c.setAttribute("aria-selected", String(sel || mid));
    }
  }
  _focusCell() { const c = this._panel.querySelector(`[data-day="${this._focus}"]`); if (c) c.focus({ preventScroll: true }); }

  /* ---------------- interaction */
  _click(e) {
    const t = e.target;
    // A picker inside a <label> must not let the label forward this click to the input.
    e.preventDefault();
    const nav = t.closest("[data-nav]");
    if (nav) {
      const k = +nav.dataset.nav, v = shiftMonth(this._view.jy, this._view.jm, k);
      const jd = Math.min(C.toJalali(this._focus).jd, C.monthLength(v.jy, v.jm));
      this._view = v; this._focus = C.fromJalali(v.jy, v.jm, jd);
      this._render();
      this._panel.querySelector(`[data-nav="${k}"]`)?.focus();
      return;
    }
    if (t.closest("[data-today]")) { const n = C.today(); this._focus = n; this._setView(n); this._render(); this._focusCell(); return; }
    if (t.closest("[data-close]")) { this._closePanel(true); return; }
    const c = t.closest("[data-day]");
    if (c) this._select(+c.dataset.day);
  }
  _key(e) {
    if (e.key === "Escape") {
      if (this._popup) { e.preventDefault(); e.stopPropagation(); this._closePanel(true); }
      return;
    }
    const cell = e.target.closest("[data-day]");
    if (!cell) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._select(+cell.dataset.day); return; }
    const n = moveKey(+cell.dataset.day, e.key, { shift: e.shiftKey });
    if (n == null) return;
    e.preventDefault();
    if (!inRange(n)) return;
    this._focus = n; this._hover = null;
    if (this._isRange && this._range.start != null && this._range.end == null) this._preview = n;
    const j = C.toJalali(n);
    if (j.jy !== this._view.jy || j.jm !== this._view.jm) { this._view = { jy: j.jy, jm: j.jm }; this._render(); }
    else { if (this._preview === n) this._paintRange(); this._sync(); }
    this._focusCell();
  }
  _select(n) {
    if (isDisabled(n, this._opts)) return;
    this._focus = n;
    if (this._isRange) {
      this._range = rangeSelect(this._range, n);
      this._preview = null;
      if (this._range.end == null) { this._render(); this._focusCell(); return; }
    } else this._value = n;
    this._writeInput(true);
    this._render();
    this.dispatchEvent(new CustomEvent("change", { bubbles: true, detail: this._detail() }));
    if (this._popup) this._closePanel(true); else this._focusCell();
  }
  _detail() {
    const o = { profile: this._opts.profile, settlement: this._settle, hijri: this._hijri };
    if (!this._isRange) return this._value != null ? dayDetail(this._value, o) : null;
    const { start, end } = this._range;
    if (start == null || end == null) return null;
    const hol = []; for (let n = start; n <= end; n++) for (const h of C.holidaysOn(n)) hol.push({ date: C.toISO(n), title: h.title, status: h.status });
    return { jalali: this.jalali, iso: this.value, start: dayDetail(start, o), end: dayDetail(end, o), days: end - start + 1, business: C.businessDaysBetween(start - 1, end, { profile: o.profile }).business, holidays: hol };
  }
  _writeInput(notify) {
    if (!this._input) return;
    const text = this._isRange
      ? (this._range.start != null && this._range.end != null ? `${formatJalali(this._range.start, { digits: this._digits })} – ${formatJalali(this._range.end, { digits: this._digits })}` : "")
      : (this._value != null ? formatJalali(this._value, { digits: this._digits }) : "");
    if (this._input.value === text) return;
    this._input.value = text;
    if (notify) { this._writing = true; this._input.dispatchEvent(new Event("input", { bubbles: true })); this._writing = false; }
  }
  _fromInput() {
    if (this._writing) return;
    const r = parseInput(this._input.value);
    if (!r) return;
    if (r.partial) { this._view = { jy: r.jy, jm: r.jm }; this._render(); return; }
    if (r.start != null && this._isRange) { this._range = { start: r.start, end: r.end }; this._focus = r.start; }
    else if (r.date != null) { if (this._isRange) this._range = { start: r.date, end: r.date }; else this._value = r.date; this._focus = r.date; }
    else return;
    this._setView(this._focus);
    this._render();
  }

  /* ---------------- popup */
  _openPanel(focusGrid) {
    if (!this._popup || this._open) { if (focusGrid) this._focusCell(); return; }
    this._open = true;
    this._fromInput();
    const p = this._panel;
    p.hidden = false;
    try { p.showPopover?.(); } catch { /* not a popover or already open */ }
    this._input.setAttribute("aria-expanded", "true"); this._toggle.setAttribute("aria-expanded", "true");
    this._render();
    if (focusGrid) this._focusCell();
  }
  _closePanel(refocus) {
    if (!this._open) return;
    this._open = false; this._hover = null; this._preview = null;
    const p = this._panel;
    try { p.hidePopover?.(); } catch { /* the popover is already hidden or was never shown */ }
    p.hidden = true;
    this._input.setAttribute("aria-expanded", "false"); this._toggle.setAttribute("aria-expanded", "false");
    if (refocus) this._input.focus();
  }
  _docDown(e) {
    if (!this._open) return;
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (this.contains(t) || t === this._input || this._panel.contains(t)) return;
    this._closePanel(false);
  }
  _place() {
    const p = this._panel, a = this._input.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const anchor = this.contains(this._input) ? this.getBoundingClientRect() : a;
    p.style.position = "fixed";
    const w = p.offsetWidth, h = p.offsetHeight, gap = 6, m = 8;
    let left = anchor.right - w; // RTL: align right edges
    left = Math.max(m, Math.min(left, vw - w - m));
    let top = anchor.bottom + gap;
    if (top + h > vh - m && anchor.top - gap - h >= m) top = anchor.top - gap - h;
    top = Math.max(m, Math.min(top, vh - h - m));
    p.style.left = `${Math.round(left)}px`; p.style.top = `${Math.round(top)}px`;
  }
}


/** Register a picker class under its tag (once). Returns the class. */
export function definePicker(cls = DatePicker, tag = cls.tag) {
  if (typeof customElements !== "undefined" && typeof HTMLElement !== "undefined" && !customElements.get(tag)) customElements.define(tag, cls);
  return cls;
}
