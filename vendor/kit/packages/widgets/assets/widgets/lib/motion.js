/* Shared motion helpers for the archetype runtimes: reduced motion, a frame loop that pauses off screen and in a hidden tab,
   easing, and counters that count up inside a number the spec wrote (its prefix, grouping and suffix stay as written). No content. */

const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false, addEventListener() {} };
/** True when the visitor asked for no motion: show final states, run no loop. */
export const reduced = () => mq.matches;
export const onReducedChange = (fn) => mq.addEventListener?.("change", () => fn(mq.matches));

export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
export const easeOut = (t) => 1 - (1 - t) ** 3;
export const clamp01 = (t) => Math.min(Math.max(t, 0), 1);

/**
 * A frame loop for one element. `step(now, dt)` returns true while it wants more frames. The loop runs only while the
 * element is on screen and the tab is visible; `kick()` asks for frames (it resumes by itself when the element returns).
 */
export function createLoop(el, step) {
  let visible = true, raf = 0, last = 0, wanted = false, io = null;
  const frame = (now) => {
    raf = 0;
    if (!visible || document.hidden) { last = 0; return; }
    const dt = Math.min(64, last ? now - last : 16.7);
    last = now;
    if (step(now, dt)) raf = requestAnimationFrame(frame); else { wanted = false; last = 0; }
  };
  const kick = () => { wanted = true; if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame); };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; };
  if ("IntersectionObserver" in window) {
    io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) { if (wanted) kick(); } else stop(); }, { rootMargin: "80px" });
    io.observe(el);
  }
  const vis = () => { if (document.hidden) stop(); else if (wanted) kick(); };
  document.addEventListener("visibilitychange", vis);
  return { kick, stop, running: () => raf !== 0, destroy() { stop(); io?.disconnect(); document.removeEventListener("visibilitychange", vis); } };
}

/** Runs `fn` once, the first time the element is at least `ratio` visible (immediately where IntersectionObserver is missing). */
export function whenSeen(el, fn, ratio = 0.3) {
  if (!("IntersectionObserver" in window)) { fn(); return; }
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold: ratio });
  io.observe(el);
}

/* ---------- counters ---------- */
const LATIN = "0123456789";
/** Split a displayed value into prefix, number and suffix; digits in any numeral set (Latin, Persian, Arabic-Indic). */
export function parseNumber(text, numerals = LATIN) {
  const map = (ch) => { const i = numerals.indexOf(ch); return i >= 0 ? String(i) : ch; };
  const norm = Array.from(String(text)).map(map).join("");
  const m = /^([^0-9]*?)(\d[\d,.\u066C\u066B' ]*\d|\d)(.*)$/s.exec(norm);
  if (!m) return null;
  const raw = m[2];
  const dec = /[.,](\d{1,2})$/.exec(raw) && !/[.,]\d{3}$/.test(raw) ? /[.,](\d{1,2})$/.exec(raw)[1].length : 0;
  const digitsOnly = raw.replace(/[^0-9]/g, "");
  const value = Number(digitsOnly) / 10 ** dec;
  const group = /(\d)([,.\u066C ])\d{3}\b/.exec(raw)?.[2] ?? "";
  const point = dec ? (/[.,](\d{1,2})$/.exec(raw) ? raw.slice(-dec - 1, -dec) : ".") : "";
  return { prefix: m[1], suffix: m[3], value, dec, group, point };
}
/** Format a number the way a parsed one was written. */
export function formatNumber(n, p, numerals = LATIN) {
  const fixed = Math.abs(n).toFixed(p.dec);
  const [i, f] = fixed.split(".");
  const grouped = p.group ? i.replace(/\B(?=(\d{3})+(?!\d))/g, p.group) : i;
  const s = grouped + (f ? p.point + f : "");
  return p.prefix + s.replace(/[0-9]/g, (d) => numerals[d]) + p.suffix;
}
/** Count an element's text up from zero (or `from`) to the text it already holds; with reduced motion, or no number in it, it just keeps the text. */
export function countUp(el, { ms = 900, numerals = LATIN, from = 0 } = {}) {
  const finalText = el.dataset.kwFinal ?? el.textContent;
  el.dataset.kwFinal = finalText;
  const p = parseNumber(finalText, numerals);
  const token = (el.kwCount = {});
  if (!p || reduced()) { el.textContent = finalText; return Promise.resolve(); }
  const start = performance.now();
  return new Promise((resolve) => {
    const tick = (now) => {
      if (el.kwCount !== token) return resolve();
      const t = clamp01((now - start) / ms), v = from + (p.value - from) * easeOut(t);
      el.textContent = t >= 1 ? finalText : formatNumber(v, p, numerals);
      if (t < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
}
