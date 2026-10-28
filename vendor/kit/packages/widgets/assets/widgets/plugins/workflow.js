/* The workflow archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const steps = $$("[data-kw-step]", w), status = $("[data-kw-status]", w);
  let at = 0;
  const show = () => {
    steps.forEach((s, i) => { s.dataset.state = i < at ? "done" : i === at ? "now" : "todo"; if (i === at) s.setAttribute("aria-current", "step"); else s.removeAttribute("aria-current"); });
    status.textContent = $(".kw-wf__n", steps[at])?.textContent || "";
    $("[data-kw-back]", w).disabled = at === 0; $("[data-kw-next]", w).disabled = at === steps.length - 1;
  };
  $("[data-kw-next]", w).addEventListener("click", () => { at = Math.min(at + 1, steps.length - 1); show(); });
  $("[data-kw-back]", w).addEventListener("click", () => { at = Math.max(at - 1, 0); show(); });
  $("[data-kw-reset]", w).addEventListener("click", () => { at = 0; show(); });
  show();
}
