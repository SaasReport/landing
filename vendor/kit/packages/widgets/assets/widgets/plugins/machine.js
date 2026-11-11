/* The machine archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence, tabs }) {
  tabs(w);
  const status = $("[data-kw-status]", w);
  const current = () => { const g = $$("[data-kw-panel]", w).find((p) => !p.hidden); return g && $$("[data-kw-machine]", g).find((m) => !m.hidden); };
  $$("[data-kw-panel]", w).forEach((g) => $$("[data-kw-pick]", g).forEach((b) => b.addEventListener("click", () => {
    $$("[data-kw-pick]", g).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $$("[data-kw-machine]", g).forEach((m, k) => { m.hidden = k !== +b.dataset.kwPick; });
    pulse();
  })));
  const pulse = async () => {
    const m = current(); if (!m) return;
    const alive = sequence(w), order = m.dataset.path.split(" "), states = $$("[data-state]", m);
    states.forEach((x) => { x.dataset.on = ""; });
    for (const id of order) {
      await wait(560); if (!alive()) return;
      const el = states.find((x) => x.dataset.state === id); if (!el) continue;
      states.forEach((x) => { if (x.dataset.on === "now") x.dataset.on = "done"; });
      el.dataset.on = "now"; status.textContent = $("b", el)?.textContent || "";
    }
  };
  $("[data-kw-pulse]", w)?.addEventListener("click", pulse);
  $$("[data-kw-tab]", w).forEach((t) => t.addEventListener("click", pulse));
  w.kwAutoplay = pulse;
}
