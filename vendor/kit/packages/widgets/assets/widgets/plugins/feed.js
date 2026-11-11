/* The feed archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const items = $$(".kw-feed__item", w);
  $("[data-kw-replay]", w)?.addEventListener("click", async () => {
    const alive = sequence(w);
    items.forEach((x) => x.classList.add("is-hidden"));
    for (const x of items) { await wait(420); if (!alive()) return; x.classList.remove("is-hidden"); x.classList.add("is-new"); setTimeout(() => x.classList.remove("is-new"), 900); }
  });
  $$("[data-kw-act]", w).forEach((b) => b.addEventListener("click", () => {
    const box = b.closest(".kw-acts"), out = $("[data-kw-result]", box);
    $$("[data-kw-act]", box).forEach((x) => { x.disabled = true; });
    b.textContent = b.dataset.done; b.setAttribute("aria-pressed", "true");
    out.textContent = b.dataset.result; out.hidden = false; out.dataset.tone = b.dataset.tone || "ok";
  }));
  return { autoplay: "[data-kw-replay]" };
}
