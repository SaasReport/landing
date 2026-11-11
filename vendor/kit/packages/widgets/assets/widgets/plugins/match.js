/* The match archetype's runtime: external records slide across to their expected partners and lock; the unmatched ones stay apart,
   turn to the attention colour and open the investigation card (also by keyboard). Reduced motion: the reconciled state. */
import { reduced, countUp } from "../lib/motion.js";

export default function mount(w, { $, $$, sequence }) {
  const root = $("[data-kw-match]", w), numerals = root.dataset.numerals || "0123456789";
  const ext = $$('[data-side="ext"]', root), card = $("[data-kw-match-card]", root), open = $("[data-kw-match-open]", root);
  const showCard = (on) => { if (!card) return; card.hidden = !on; open.setAttribute("aria-expanded", String(on)); if (on) card.focus?.(); };
  open?.setAttribute("aria-expanded", "false"); if (card) card.hidden = true;
  open?.addEventListener("click", () => showCard(card.hidden));
  $("[data-kw-match-close]", root)?.addEventListener("click", () => { showCard(false); open?.focus(); });
  root.addEventListener("keydown", (e) => { if (e.key === "Escape" && card && !card.hidden) { showCard(false); open?.focus(); } });
  // an exception record is itself the way in: focusable, it opens the card
  for (const r of ext.filter((x) => x.dataset.state === "exception")) { r.tabIndex = 0; r.setAttribute("role", "button"); r.removeAttribute("aria-hidden"); r.setAttribute("aria-label", open?.textContent || ""); r.addEventListener("click", () => showCard(true)); r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Space" || e.key === " ") { e.preventDefault(); showCard(true); } }); }
  const run = async () => {
    if (reduced()) return;
    const alive = sequence(w);
    showCard(false);
    root.classList.remove("is-done"); root.classList.add("is-running");
    ext.forEach((r) => { r.dataset.phase = "apart"; });
    void root.offsetWidth;
    $$(".kw-match__totals [data-kw-count]", root).forEach((s, i) => countUp(s, { numerals, ms: 1400 + i * 200 }));
    for (const r of ext) { await new Promise((ok) => setTimeout(ok, 140)); if (!alive()) return; r.dataset.phase = r.dataset.state === "exception" ? "flag" : "lock"; }
    await new Promise((ok) => setTimeout(ok, 500)); if (!alive()) return;
    root.classList.remove("is-running"); root.classList.add("is-done");
  };
  $("[data-kw-match-run]", root).addEventListener("click", run);
  w.kwAutoplay = run;
  root.classList.add("is-done");
  ext.forEach((r) => { r.dataset.phase = r.dataset.state === "exception" ? "flag" : "lock"; });
}
