/* The netting archetype's runtime: the gross mesh is drawn, then recedes while every participant's net link to settlement is
   drawn and the gross figure counts down to the net one. Reduced motion: the settled state. No content of its own. */
import { reduced, countUp, parseNumber, formatNumber, easeOut } from "../lib/motion.js";

export default function mount(w, { $, $$ }) {
  const root = $("[data-kw-netting]", w), numerals = root.dataset.numerals || "0123456789", ratio = +root.dataset.ratio || 0.5;
  const gross = $('[data-total="gross"] [data-kw-count]', root), net = $('[data-total="net"] [data-kw-count]', root);
  const mesh = $$(".kw-net-mesh", root), spokes = $$(".kw-net-spoke", root);
  root.style.setProperty("--ratio", String(ratio));
  const run = async () => {
    if (reduced()) return;
    root.classList.remove("is-settled"); root.classList.add("is-gross");
    void root.getBoundingClientRect();
    const g = gross && parseNumber(gross.dataset.kwFinal ?? gross.textContent, numerals);
    if (gross) gross.dataset.kwFinal = gross.dataset.kwFinal ?? gross.textContent;
    net && countUp(net, { numerals, ms: 1400 });
    // the gross figure counts from its own value down to the net one
    const n = net && parseNumber(net.dataset.kwFinal ?? net.textContent, numerals);
    if (gross && g && n) {
      const t0 = performance.now(), from = g.value, to = n.value;
      const tick = (now) => { const k = Math.min(1, (now - t0 - 500) / 1300); if (k > 0) gross.textContent = formatNumber(from + (to - from) * easeOut(k), g, numerals); if (k < 1) requestAnimationFrame(tick); else gross.textContent = gross.dataset.kwFinal; };
      requestAnimationFrame(tick);
    }
    setTimeout(() => { root.classList.remove("is-gross"); root.classList.add("is-settled"); }, 500);
  };
  void mesh; void spokes;
  $("[data-kw-netting-run]", root).addEventListener("click", run);
  w.kwAutoplay = run;
  root.classList.add("is-settled");
}
