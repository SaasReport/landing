/* The chain archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const links = $$(".kw-chain__link", w);
  $("[data-kw-walk]", w)?.addEventListener("click", async () => {
    const alive = sequence(w);
    links.forEach((l) => l.classList.remove("is-lit"));
    for (const l of links) { await wait(650); if (!alive()) return; l.classList.add("is-lit"); }
  });
  return { autoplay: "[data-kw-walk]" };
}
