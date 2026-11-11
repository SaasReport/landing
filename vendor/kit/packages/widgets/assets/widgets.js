/* The widget runtime core of @saasreport/widgets: the loader and what every archetype shares (tabs, sequences, the audience
   filter, play-once-when-seen). Each archetype's behaviour is its plugin's runtime module (widgets/plugins/<id>.js next to this
   file), loaded only when a widget of that archetype is on the page. No content of its own: every word it shows is
   already in the page (generated from the project's widgets.spec.json) or in its data-* attributes. Keyboard and
   screen-reader friendly; honours prefers-reduced-motion. */
(() => {
  "use strict";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  // where this script lives: the plugins' runtime modules are next to it (widgets/plugins/<id>.js, widgets/lib/*.js)
  const BASE = (() => { const s = document.currentScript; try { return new URL(s.dataset.kwBase || "widgets/", s.src); } catch { return new URL("widgets/", location.href); } })();
  const runs = new WeakMap();
  /** Start a sequence on an element, cancelling the previous one. */
  const sequence = (el) => { const token = {}; runs.set(el, token); return () => runs.get(el) === token; };

  /** Tabs (roles, playground): arrow keys, Home/End; one panel visible. */
  function tabs(w) {
    const list = $$("[data-kw-tab]", w), panels = $$("[data-kw-panel]", w);
    const pick = (i, focus) => {
      list.forEach((t, j) => { t.setAttribute("aria-selected", String(i === j)); t.tabIndex = i === j ? 0 : -1; });
      panels.forEach((p, j) => { p.hidden = i !== j; });
      if (focus) list[i].focus();
    };
    const rtl = getComputedStyle(w).direction === "rtl";
    list.forEach((t, i) => {
      t.addEventListener("click", () => pick(i));
      t.addEventListener("keydown", (e) => {
        const k = e.key, n = list.length;
        const step = k === "ArrowRight" ? (rtl ? -1 : 1) : k === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
        if (step) { e.preventDefault(); pick((i + step + n) % n, true); }
        if (k === "Home") { e.preventDefault(); pick(0, true); }
        if (k === "End") { e.preventDefault(); pick(n - 1, true); }
      });
    });
    pick(0);
  }

  /** The page's audience filter: shows the scenarios for one audience. */
  function filter(root) {
    const chips = $$("[data-kw-aud]", root); if (!chips.length) return;
    const empty = $("[data-kw-empty]", root);
    chips.forEach((c) => c.addEventListener("click", () => {
      const a = c.dataset.kwAud;
      chips.forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
      let shown = 0;
      $$(".kw-sc", root).forEach((s) => { const on = !a || s.dataset.audiences.split(" ").includes(a); s.hidden = !on; shown += on; });
      $$(".kw-uc", root).forEach((u) => { u.hidden = !$$(".kw-sc", u).some((s) => !s.hidden); });
      if (empty) empty.hidden = shown > 0;
    }));
  }

  // A widget plays once by itself the first time half of it is on screen (not with reduced motion); its buttons replay it.
  const io = !reduce && "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return; io.unobserve(e.target);
    const w = e.target; if (w.kwAutoplay) w.kwAutoplay(); else if (w.kwAuto) $(w.kwAuto, w)?.click();
  }), { threshold: 0.35 }) : null;
  const api = { $, $$, reduce, wait, sequence, tabs };
  /** The module of an archetype's runtime (ES module next to this script); an archetype without one is static. */
  const idOf = (w) => w.dataset.widget || w.dataset.kwArchetype;
  const load = (id) => import(new URL(`plugins/${id}.js`, BASE).href);
  async function enhance(w) {
    // The canonical plugin manifest declares runtime:null for HTML-only archetypes.
    // Never request a nonexistent module or treat a 404 as a legitimate module load.
    if (w.dataset.kwRuntime === "static") return;
    try {
      const mod = await load(idOf(w)).catch((e) => { if (/dynamically imported module|Importing a module script failed/i.test(String(e?.message))) return null; throw e; });
      if (!mod?.default) return;
      const r = await mod.default(w, api);
      if (r?.autoplay) w.kwAuto = r.autoplay;
      if (io && (w.kwAutoplay || w.kwAuto)) io.observe(w);
    } catch (e) { console.error(`archetype ${idOf(w)}:`, e); }
  }
  function init(root = document) {
    $$("[data-widget],[data-kw-archetype]", root).forEach((w) => { if (w.dataset.kwReady) return; w.dataset.kwReady = "1"; w.classList.add("is-live"); enhance(w); });
    $$(".kw-page", root).forEach(filter);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init()); else init();
  window.KitWidgets = { init };
})();
