{{banner}}
/* The landing's behaviours (src/sections/index.js is the markup contract; theme/styles.css the states). Project-agnostic: it
   holds no copy; every word is in the page, and the numbers are formatted by the kit's one formatter (/format.js, KitFormat).
   Progressive enhancement: without this script (or with scripts blocked) every section is visible and complete; the
   `.reveal` elements are hidden only under html.js, which this script sets. With prefers-reduced-motion nothing moves:
   revealed at once, counters show their value, steps show their end state.

   Hooks it serves (what a section emits):
     .reveal                    fades in once, when it scrolls into view (IntersectionObserver; at once when unavailable)
     [data-count][data-format]  a counter counts up to the number the page holds ("number" (default) or "percent")
     [data-hero-steps]          the hero mock's steps light up one after the other (li.on)
     [data-vflow], [data-gov]   the flow / chain lights up in turn (li.on); the vflow pulse follows
     [data-tabs]                tabs: arrows, Home, End, roving tabindex, aria-controls/labelledby (panels .is-active)
     [data-stepper]             the stepper: same keys, the bar follows (--i, --dir)
     [data-arch]                an architecture layer shows its note (on hover, focus and click)
     [data-modal="id"]          opens <dialog id="m-id">; [data-close], the backdrop and Escape close it; /#id opens it
     [data-mega]                a mega menu: click, Enter and Space toggle aria-expanded; Escape, an outside click and focus
                                leaving close it
     .nav, .nav__progress       .is-stuck once the page scrolled; --p is the scroll progress
     .nav__links a[href^="#"]   the section index: the link of the section in view is .is-active and aria-current="location"
   What it leaves to a project script: the demo mounts (data-sim, data-lifecycle, data-pg, data-dash charts, data-lblog, data-cform
   submit, …) and the project's own forms. */
(() => {
  const doc = document, root = doc.documentElement;
  const $ = (s, r = doc) => r.querySelector(s), $$ = (s, r = doc) => [...r.querySelectorAll(s)];
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmt = (n, percent) => {
    const F = globalThis.KitFormat;
    try { return percent ? F.formatPercent(n, "{{locale.code}}", { numerals: "{{locale.digits}}" }) : F.formatNumber(n, "{{locale.code}}", { numerals: "{{locale.digits}}" }); } catch { return String(n); }
  };
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; };
  /** Calls `fn(el)` once, when `el` is first in view (at once if it already is, or if there is no IntersectionObserver). */
  const once = (els, fn, margin = "0px 0px -8% 0px") => {
    if (!("IntersectionObserver" in window)) { els.forEach(fn); return; }
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); fn(e.target); } }, { rootMargin: margin });
    for (const el of els) { if (inView(el)) fn(el); else io.observe(el); }
  };

  root.classList.add("js");   // the .reveal rules apply under html.js only: no script, no hidden content

  // ---- reveal -------------------------------------------------------------------------------------------------
  const reveals = $$(".reveal");
  if (calm()) reveals.forEach((e) => e.classList.add("in"));
  else once(reveals, (e) => e.classList.add("in"));

  // ---- counters: the page holds the final text; count up to it ---------------------------------------------------
  for (const el of $$("[data-count]")) {
    const to = Number(el.getAttribute("data-count")), final = el.textContent;
    if (!Number.isFinite(to) || calm()) continue;
    const percent = el.getAttribute("data-format") === "percent";
    el.textContent = fmt(0, percent);
    once([el], () => {
      const t0 = performance.now(), ms = 900;
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / ms), e = 1 - (1 - k) ** 3;
        el.textContent = k < 1 ? fmt(Math.round(to * e * 10) / 10, percent) : final;
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // ---- lists that light up in turn (hero steps, vflow, governance chain) ------------------------------------------------
  for (const list of $$("[data-hero-steps], [data-vflow], [data-gov]")) {
    const items = $$(":scope > li", list), pulse = $(".vflow__pulse", list);
    const show = (i) => { items[i]?.classList.add("on"); if (pulse && items[i]) pulse.style.top = `${items[i].offsetTop + 14}px`; };
    if (calm()) { items.forEach((_, i) => show(i)); continue; }
    once([list], () => items.forEach((_, i) => setTimeout(() => show(i), 350 * (i + 1))));
  }

  // ---- tabs ---------------------------------------------------------------------------------------------------------
  let uid = 0;
  const tablist = (box, list, tabs, panels, onSelect) => {
    const id = `lt${++uid}`;
    tabs.forEach((t, i) => { t.id ||= `${id}-t${i}`; if (panels[i]) { panels[i].id ||= `${id}-p${i}`; t.setAttribute("aria-controls", panels[i].id); panels[i].setAttribute("aria-labelledby", t.id); } });
    const select = (i, focus) => {
      tabs.forEach((t, j) => { t.setAttribute("aria-selected", String(i === j)); t.tabIndex = i === j ? 0 : -1; });
      panels.forEach((p, j) => p?.classList.toggle("is-active", i === j));
      if (focus) tabs[i].focus();
      onSelect?.(i);
    };
    const rtl = () => getComputedStyle(list).direction === "rtl";
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(i));
      t.addEventListener("keydown", (e) => {
        const last = tabs.length - 1, step = e.key === "ArrowRight" ? (rtl() ? -1 : 1) : e.key === "ArrowLeft" ? (rtl() ? 1 : -1) : e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        const to = e.key === "Home" ? 0 : e.key === "End" ? last : step ? (i + step + tabs.length) % tabs.length : -1;
        if (to >= 0) { e.preventDefault(); select(to, true); }
      });
    });
    select(Math.max(0, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true")));
  };
  for (const box of $$("[data-tabs]")) {
    const list = $(".tabs__list", box), tabs = list ? $$('[role="tab"]', list) : [];
    if (tabs.length) tablist(box, list, tabs, $$(":scope > .tabs__panel", box));
  }
  for (const box of $$("[data-stepper]")) {
    const list = $(".stepper__rail", box), tabs = $$('[role="tab"]', list);
    box.style.setProperty("--dir", getComputedStyle(box).direction === "rtl" ? "-1" : "1");
    tablist(box, list, tabs, $$(".stepper__panel", box), (i) => box.style.setProperty("--i", String(i)));
  }

  // ---- architecture layers --------------------------------------------------------------------------------------------
  for (const arch of $$("[data-arch]")) {
    const note = $(".arch__note", arch), layers = $$(".arch__layer", arch), hint = note?.textContent;
    const show = (l) => { layers.forEach((x) => x.classList.toggle("on", x === l)); if (note) { note.textContent = l?.getAttribute("data-note") || hint; note.classList.toggle("on", Boolean(l)); } };
    for (const l of layers) for (const ev of ["mouseenter", "focus", "click"]) l.addEventListener(ev, () => show(l));
  }

  // ---- modals ---------------------------------------------------------------------------------------------------------
  const dialogOf = (key) => doc.getElementById(`m-${key}`);
  const open = (key) => { const d = dialogOf(key); if (d && !d.open && typeof d.showModal === "function") { d.showModal(); return true; } return false; };
  const close = (d) => {
    if (!d.open) return;
    if (calm()) { d.close(); return; }
    d.classList.add("is-closing");
    setTimeout(() => { d.classList.remove("is-closing"); d.close(); }, 200);
  };
  doc.addEventListener("click", (e) => {
    const opener = e.target.closest?.("[data-modal]");
    if (opener && !opener.closest("dialog") && dialogOf(opener.getAttribute("data-modal"))) { e.preventDefault(); open(opener.getAttribute("data-modal")); return; }
    if (opener && opener.closest("dialog") && dialogOf(opener.getAttribute("data-modal"))) { e.preventDefault(); close(opener.closest("dialog")); open(opener.getAttribute("data-modal")); return; }
    const x = e.target.closest?.("[data-close]");
    if (x && x.closest("dialog")) { close(x.closest("dialog")); return; }
    if (e.target instanceof HTMLDialogElement && e.target.classList.contains("modal")) close(e.target);   // the backdrop
  });
  const fromHash = () => { const k = decodeURIComponent(location.hash.slice(1)); if (k) open(k); };
  fromHash();
  addEventListener("hashchange", fromHash);

  // ---- mega menus ---------------------------------------------------------------------------------------------------------
  const megas = $$("[data-mega]");
  const shut = (m, focus) => { const b = $("[data-mega-toggle]", m); if (b?.getAttribute("aria-expanded") === "true") { b.setAttribute("aria-expanded", "false"); if (focus) b.focus(); } };
  for (const m of megas) {
    const b = $("[data-mega-toggle]", m);
    b?.addEventListener("click", () => { const was = b.getAttribute("aria-expanded") === "true"; megas.forEach((x) => shut(x)); b.setAttribute("aria-expanded", String(!was)); });
    m.addEventListener("focusout", (e) => { if (!m.contains(e.relatedTarget)) shut(m); });
  }
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") megas.forEach((m) => shut(m, m.contains(doc.activeElement))); });
  doc.addEventListener("click", (e) => { megas.forEach((m) => { if (!m.contains(e.target)) shut(m); }); });

  // ---- nav: stuck, progress, section index ----------------------------------------------------------------------------------
  const nav = $(".nav"), bar = $(".nav__progress span");
  const onScroll = () => {
    nav?.classList.toggle("is-stuck", scrollY > 8);
    const h = root.scrollHeight - innerHeight;
    bar?.style.setProperty("--p", h > 0 ? String(Math.min(1, Math.max(0, scrollY / h))) : "0");
  };
  let queued = false;
  addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; onScroll(); }); } }, { passive: true });
  onScroll();
  const links = $$('.nav__links a[href^="#"]').filter((a) => a.getAttribute("href").length > 1);
  const targets = links.map((a) => doc.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)))).map((el, i) => (el ? [el, links[i]] : null)).filter(Boolean);
  if (targets.length && "IntersectionObserver" in window) {
    const live = new Map();
    const mark = () => {
      const cur = targets.filter(([el]) => live.get(el)).pop();
      for (const [, a] of targets) { const on = cur && cur[1] === a; a.classList.toggle("is-active", Boolean(on)); if (on) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current"); }
    };
    const io = new IntersectionObserver((es) => { for (const e of es) live.set(e.target, e.isIntersecting); mark(); }, { rootMargin: "-30% 0px -60% 0px" });
    targets.forEach(([el]) => io.observe(el));
  }
})();
