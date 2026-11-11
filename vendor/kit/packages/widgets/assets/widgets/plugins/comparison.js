/* The comparison archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  $$("[data-kw-col]", w).forEach((b) => b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    $$("[data-kw-col]", w).forEach((x) => x.setAttribute("aria-pressed", "false"));
    $$("td[data-col]", w).forEach((td) => td.classList.toggle("is-picked", on && td.dataset.col === b.dataset.kwCol));
    b.setAttribute("aria-pressed", String(on));
  }));
}
