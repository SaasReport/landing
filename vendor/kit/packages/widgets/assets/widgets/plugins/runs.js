/* The runs archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const picks = $$("[data-kw-case]", w), boxes = $$("[data-kw-casebox]", w), stages = $$(".kw-pipe__stage", w), status = $("[data-kw-status]", w);
  let at = 0;
  const run = async () => {
    const alive = sequence(w), stop = +picks[at].dataset.stop, verdict = $("[data-kw-verdict]", boxes[at]);
    stages.forEach((s) => { s.dataset.state = "todo"; delete s.dataset.stop; });
    if (verdict) verdict.hidden = true;
    for (const [i, s] of stages.entries()) {
      if (!alive()) return;
      s.dataset.state = "now"; status.textContent = s.dataset.label; await wait(620); if (!alive()) return;
      if (i === stop) { s.dataset.state = "stop"; s.dataset.stop = picks[at].dataset.decision; break; }
      s.dataset.state = "done";
    }
    if (verdict) verdict.hidden = false;
    status.textContent = verdict ? verdict.textContent.trim() : "";
  };
  picks.forEach((b, i) => b.addEventListener("click", () => { at = i; picks.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); boxes.forEach((x, k) => { x.hidden = k !== i; }); run(); }));
  $("[data-kw-run]", w)?.addEventListener("click", run);
  w.kwAutoplay = run;
}
