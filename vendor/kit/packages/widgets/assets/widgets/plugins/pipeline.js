/* The pipeline archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const stages = $$(".kw-pipe__stage", w), status = $("[data-kw-status]", w);
  $("[data-kw-run]", w).addEventListener("click", async () => {
    const alive = sequence(w);
    stages.forEach((s) => { s.dataset.state = "todo"; });
    for (const s of stages) { if (!alive()) return; s.dataset.state = "now"; status.textContent = s.dataset.label; await wait(700); if (!alive()) return; s.dataset.state = "done"; }
  });
  return { autoplay: "[data-kw-run]" };
}
