/* The screens archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const screens = $$("[data-kw-screen]", w), status = $("[data-kw-status]", w);
  if (screens.length < 2) return;
  let at = 0;
  const show = () => { screens.forEach((s, i) => { s.hidden = i !== at; }); if (status) status.textContent = screens[at].getAttribute("aria-label"); };
  $("[data-kw-prev]", w).addEventListener("click", () => { at = (at - 1 + screens.length) % screens.length; show(); });
  $("[data-kw-nextscreen]", w).addEventListener("click", () => { at = (at + 1) % screens.length; show(); });
  show();
}
