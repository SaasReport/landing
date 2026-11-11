/* The split archetype's runtime: the amount divides, each allocation's stream is drawn in turn, a dash runs along it at its own
   pace (only while on screen) and its value counts up. Reduced motion: the divided state, no dash. No content of its own. */
import { reduced, countUp } from "../lib/motion.js";

export default function mount(w, { $, $$ }) {
  const root = $("[data-kw-split]", w), numerals = root.dataset.numerals || "0123456789";
  const bands = $$(".kw-split__band", root), rows = $$(".kw-split__to li", root), src = $(".kw-split__src [data-kw-count]", root);
  const run = async () => {
    if (reduced()) { root.classList.remove("is-running"); return; }
    root.classList.remove("is-running", "is-drawn");
    bands.forEach((b) => { b.style.setProperty("--len", String(Math.ceil(b.getTotalLength?.() || 320))); });
    void root.offsetWidth;
    src && countUp(src, { numerals, ms: 700 });
    root.classList.add("is-drawn");
    rows.forEach((r, i) => setTimeout(() => countUp($("[data-kw-count]", r), { numerals, ms: 800 }), 260 + i * 140));
    setTimeout(() => root.classList.add("is-running"), 300 + rows.length * 140);
  };
  // the dashes run only while the figure is on screen and the tab is visible
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => { root.classList.toggle("is-paused", !es[es.length - 1].isIntersecting); }) : null;
  io?.observe(root);
  document.addEventListener("visibilitychange", () => root.classList.toggle("is-paused", document.hidden));
  $("[data-kw-split-run]", root).addEventListener("click", run);
  w.kwAutoplay = run;
  root.classList.add("is-drawn"); if (!reduced()) root.classList.add("is-running");
}
