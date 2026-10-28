{{banner}}
(() => {
  "use strict";
  const root = document.querySelector("[data-dx]");
  const cards = [...document.querySelectorAll(".dx-card")];
  if (!root || !cards.length) return;
  const panel = root.querySelector("[data-dx-filters]");
  const qInput = root.querySelector("[data-dx-q]");
  const select = root.querySelector("[data-dx-sector]");
  const count = root.querySelector("[data-dx-count]");
  const none = root.querySelector("[data-dx-none]");
  const clears = [...root.querySelectorAll("[data-dx-clear]")];
  const chips = [...document.querySelectorAll("[data-dx-f]")];
  const tiers = [...root.querySelectorAll("[data-dx-tier]")];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fa = (n) => KitFormat.digits(n, "{{locale.digits}}");
  // same normalisation as scripts/build-directory.mjs (data-q is written with it)
  const norm = (s) => String(s || "").toLowerCase()
    .replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/ة/g, "ه").replace(/[أإآ]/g, "ا").replace(/ؤ/g, "و")
    .replace(/[ً-ٰٟـ]/g, "").replace(/[‌‍‎‏]/g, "")
    .replace(/[۰-۹٠-٩]+/g, (d) => KitFormat.toLatinDigits(d))
    .replace(/\s+/g, " ").trim();
  const words = (s) => (s || "").split(" ").filter(Boolean);

  const items = cards.map((el) => ({ el, cat: [el.dataset.cat], tier: [el.dataset.tier], tag: words(el.dataset.tags), sector: words(el.dataset.sectors), q: el.dataset.q || "" }));
  const GROUPS = ["cat", "tier", "tag", "sector"];
  const state = { cat: new Set(), tier: new Set(), tag: new Set(), sector: new Set(), q: "" };
  const known = { sector: new Set([...select.options].map((o) => o.value).filter(Boolean)) };
  for (const b of chips) (known[b.dataset.dxF] ||= new Set()).add(b.dataset.v);

  const matchQ = (it) => { const t = words(norm(state.q)); return t.every((w) => it.q.includes(w)); };
  const match = (it, skip) => matchQ(it) && GROUPS.every((g) => g === skip || !state[g].size || it[g].some((v) => state[g].has(v)));
  const active = () => !!state.q.trim() || GROUPS.some((g) => state[g].size);

  function read() {
    const p = new URLSearchParams(location.search);
    for (const g of GROUPS) state[g] = new Set((p.get(g) || "").split(",").map((v) => v.trim()).filter((v) => known[g]?.has(v)));
    state.q = (p.get("q") || "").slice(0, 100);
  }
  function write() {
    const url = new URL(location.href);
    for (const g of GROUPS) if (state[g].size) url.searchParams.set(g, [...state[g]].join(",")); else url.searchParams.delete(g);
    if (state.q.trim()) url.searchParams.set("q", state.q.trim()); else url.searchParams.delete("q");
    history.replaceState(history.state, "", url.pathname + (url.search.replace(/%2C/gi, ",")) + url.hash);
  }

  function render() {
    let shown = 0;
    for (const it of items) { const on = match(it); it.el.hidden = !on; if (on) shown++; }
    for (const sec of tiers) {
      const n = items.filter((it) => !it.el.hidden && it.tier[0] === sec.dataset.dxTier).length;
      sec.hidden = n === 0;
      const tn = sec.querySelector("[data-dx-tn]"); if (tn) tn.textContent = fa(n);
    }
    // faceted counts: how many would match if this value were chosen, keeping the other groups
    for (const b of chips) {
      const g = b.dataset.dxF, v = b.dataset.v;
      const n = items.filter((it) => match(it, g) && it[g].includes(v)).length;
      b.querySelector("[data-dx-n]").textContent = fa(n);
      b.setAttribute("aria-pressed", String(state[g].has(v)));
      b.classList.toggle("is-zero", n === 0 && !state[g].has(v));
    }
    select.value = [...state.sector][0] || "";
    if (qInput.value !== state.q) qInput.value = state.q;
    count.textContent = active() ? `${fa(shown)} {{s.text.1|tl}} ${fa(items.length)} {{s.text.2|tl}}` : `${fa(items.length)} {{s.text.2|tl}}`;
    none.hidden = shown > 0;
    clears.forEach((b) => { b.disabled = !active(); });
  }
  const update = () => { render(); write(); };

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dx-f]");
    if (b) {
      const set = state[b.dataset.dxF];
      if (set.has(b.dataset.v)) set.delete(b.dataset.v); else set.add(b.dataset.v);
      update();
      if (b.closest(".dx-chain")) root.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      return;
    }
    if (e.target.closest("[data-dx-clear]")) {
      GROUPS.forEach((g) => state[g].clear()); state.q = "";
      update(); qInput.focus();
    }
  });
  select.addEventListener("change", () => { state.sector = new Set(select.value ? [select.value] : []); update(); });
  let t;
  qInput.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { state.q = qInput.value.slice(0, 100); update(); }, 150); });
  qInput.addEventListener("keydown", (e) => { if (e.key === "Escape" && qInput.value) { qInput.value = ""; state.q = ""; update(); } });

  // A link to a card the filters hide (e.g. «{{s.under}} …» or a shared #id) clears the filters first.
  const reveal = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = id && document.getElementById(id);
    if (!el || !el.classList.contains("dx-card") || !el.hidden) return;
    GROUPS.forEach((g) => state[g].clear()); state.q = "";
    update();
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  };
  addEventListener("hashchange", reveal);

  panel.hidden = false;
  read();
  render();
  reveal();
})();
