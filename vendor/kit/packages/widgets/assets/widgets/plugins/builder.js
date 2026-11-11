/* The builder archetype's runtime: each choice recomposes the preview network (the network archetype's own morph) and the figures
   count the selection. Reduced motion: the preview changes at once. No content of its own. */
import { mountNetwork } from "./network.js";
import { countUp, reduced } from "../lib/motion.js";

export default function mount(w, { $, $$ }) {
  const root = $("[data-kw-builder]", w), netRoot = $("[data-kw-net]", root), form = $("[data-kw-bld-form]", root);
  const island = JSON.parse($("[data-kw-net-data]", netRoot).textContent);
  const data = island.data, numerals = netRoot.dataset.numerals || "0123456789";
  const ctrl = mountNetwork(netRoot, { data });
  const cfg = data.configurations[0];
  const figs = $$("[data-fig]", root);
  const selection = () => $$("input[type=checkbox]:checked", form).map((i) => i.value);
  const num = (n) => String(n).replace(/[0-9]/g, (x) => numerals[x]);
  const update = (animate) => {
    const chosen = selection();
    const order = data.nodes.filter((n) => chosen.includes(n.id)).map((n) => n.id);
    cfg.nodes = order.length ? order : [];
    cfg.edges = cfg.nodes.map((id) => ["hub", id]);
    ctrl.morphTo(data, "preview");
    for (const f of figs) {
      const step = f.dataset.step, n = chosen.filter((id) => !step || id.startsWith(`${step}--`)).length, dd = $("dd", f);
      dd.dataset.kwFinal = num(n);
      if (animate && !reduced()) countUp(dd, { numerals, ms: 400, from: Math.max(0, n - 1) }); else dd.textContent = num(n);
    }
  };
  form.addEventListener("change", () => update(true));
  update(false);
}
