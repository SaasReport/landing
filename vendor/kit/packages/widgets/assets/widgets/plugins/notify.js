/* The notify archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const cards = $$("[data-kw-n]", w).sort((a, b) => a.dataset.kwN - b.dataset.kwN), play = $("[data-kw-play]", w), status = $("[data-kw-status]", w);
  const root = $("[data-kw-nc]", w), tabs = $$("[data-kw-devtab]", w), devs = $$("[data-kw-dev]", w);
  const num = (n) => String(n).replace(/[0-9]/g, (x) => (root.dataset.numerals || "0123456789")[x]);
  // lock-screen clock: the visitor's time, in the page's numerals
  const tick = () => { const d = new Date(); $$("[data-kw-clock]", w).forEach((el) => { el.textContent = num(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`); }); };
  tick(); setInterval(tick, 30000);
  // device switcher (shown below 640 px): one device at a time, auto-follows arrivals; badges count what each device received
  const received = new Map(devs.map((d) => [d.dataset.kwDev, 0]));
  const badge = () => tabs.forEach((t) => { const n = received.get(t.dataset.kwDevtab) || 0; const b = $("[data-kw-badge]", t); b.textContent = num(n); b.hidden = !n; });
  const show = (id) => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.kwDevtab === id)));
    devs.forEach((d) => { d.dataset.active = d.dataset.kwDev === id ? "1" : ""; });
    };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.kwDevtab)));
  if (tabs[0]) show(tabs[0].dataset.kwDevtab);
  // scenes: animate their items in sequence (chain hops light, checks tick, a seal resolves, a cascade revokes)
  const runScene = async (sc, alive) => {
    const kind = sc.dataset.kwScene, items = $$(".kw-scene__list > li", sc);
    items.forEach((li) => li.classList.remove("is-on"));
    sc.classList.remove("is-sealed");
    const hash = $("[data-kw-hash]", sc), final = hash?.dataset.final ?? hash?.textContent;
    if (hash) hash.dataset.final = final;
    for (const li of items) { await wait(kind === "cascade" ? 520 : 420); if (!alive()) return; li.classList.add("is-on"); }
    if (hash && final) {
      const chars = "0123456789abcdef";
      for (let k = 0; k < 8 && !reduce; k++) { if (!alive()) return; hash.textContent = [...final].map((ch, j) => (j < (k * final.length) / 8 ? ch : /[0-9a-f]/i.test(ch) ? chars[(j * 7 + k * 3) % 16] : ch)).join(""); await wait(90); }
      hash.textContent = final;
    }
    sc.classList.add("is-sealed");
  };
  const openCard = (card, alive = () => true) => {
    const btn = $("[data-kw-open]", card), sc = btn && $(`#${CSS.escape(btn.getAttribute("aria-controls"))}`, w);
    cards.forEach((c) => { if (c !== card) { c.classList.remove("is-open"); const b = $("[data-kw-open]", c); if (b) b.setAttribute("aria-expanded", "false"); } });
    card.classList.add("is-open");
    if (btn && sc) { btn.setAttribute("aria-expanded", "true"); return runScene(sc, alive); }
    return Promise.resolve();
  };
  cards.forEach((card) => {
    const btn = $("[data-kw-open]", card);
    if (btn) { btn.setAttribute("aria-expanded", "false"); btn.addEventListener("click", () => { stop(); if (card.classList.contains("is-open")) { card.classList.remove("is-open"); btn.setAttribute("aria-expanded", "false"); } else openCard(card, sequence(card)); }); }
    $$("[data-kw-act]", card).forEach((b) => b.addEventListener("click", () => {
      stop();
      const box = b.closest(".kw-acts"), out = $("[data-kw-result]", box);
      out.textContent = b.dataset.result; out.hidden = false; out.dataset.tone = b.dataset.blocked ? "err" : b.dataset.tone || "ok";
      requestAnimationFrame(() => out.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }));
      if (b.dataset.blocked) { b.setAttribute("aria-disabled", "true"); b.classList.remove("is-refused"); void b.offsetWidth; b.classList.add("is-refused"); return; }
      $$("[data-kw-act]", box).forEach((x) => { x.disabled = true; });
      b.setAttribute("aria-pressed", "true");
      const kind = b.dataset.kind;
      if (kind === "verify" || kind === "revoke" || kind === "approve") openCard(card, sequence(card));
    }));
  });
  let playing = false, token = 0;
  const stop = () => { playing = false; token++; devs.forEach((d) => received.set(d.dataset.kwDev, cards.filter((c) => c.dataset.device === d.dataset.kwDev).length)); badge(); play.setAttribute("aria-pressed", "false"); play.textContent = play.dataset.play; cards.forEach((c) => c.classList.remove("is-hidden")); };
  const run = async () => {
    const my = ++token; playing = true; play.setAttribute("aria-pressed", "true"); play.textContent = play.dataset.pause;
    const alive = () => playing && token === my;
    cards.forEach((c) => { c.classList.add("is-hidden"); c.classList.remove("is-open"); });
    devs.forEach((d) => received.set(d.dataset.kwDev, 0)); badge();
    for (const c of cards) {
      await wait(900); if (!alive()) return;
      const stack = c.parentNode; stack.insertBefore(c, stack.firstChild); stack.scrollTop = 0;
      c.classList.remove("is-hidden"); c.classList.add("is-new"); setTimeout(() => c.classList.remove("is-new"), 1200);
      const dev = c.dataset.device; received.set(dev, (received.get(dev) || 0) + 1); badge(); show(dev);
      const tab = tabs.find((t) => t.dataset.kwDevtab === dev); if (tab) { tab.classList.remove("is-ping"); void tab.offsetWidth; tab.classList.add("is-ping"); }
      status.textContent = `${$(".kw-nc__meta b", c)?.textContent || ""}: ${$(".kw-nc__title", c)?.textContent || ""}`;
      if ($("[data-kw-open]", c)) { await openCard(c, alive); if (!alive()) return; await wait(900); }
    }
    if (alive()) { playing = false; play.setAttribute("aria-pressed", "false"); play.textContent = play.dataset.play; }
  };
  play.addEventListener("click", () => (playing ? stop() : run()));
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); run(); } }, { threshold: 0.3 });
    io.observe(w);
  } else cards.forEach((c) => { if ($("[data-kw-open]", c)) { c.classList.add("is-open"); $$(".kw-scene__list > li", c).forEach((li) => li.classList.add("is-on")); $$(".kw-scene", c).forEach((s) => s.classList.add("is-sealed")); } });
}
