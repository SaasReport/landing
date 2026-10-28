/* The playground archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence, tabs }) {
  tabs(w);
  $$("[data-kw-panel]", w).forEach((panel) => {
    const res = $("[data-kw-response]", panel), send = $("[data-kw-send]", panel);
    res.hidden = true;
    send.addEventListener("click", async () => { res.hidden = true; send.disabled = true; await wait(350); res.hidden = false; send.disabled = false; });
  });
}
