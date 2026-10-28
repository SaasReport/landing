/* The flow archetype's runtime: an amount token travels the path hop by hop, the status sequence advances, the markers settle,
   and for an API call the response appears when the call completes. Plays once when half on screen; the button replays it.
   Reduced motion: the finished state stays, with no token. No content of its own. */
import { reduced, countUp } from "../lib/motion.js";

export default function mount(w, { $, $$, sequence }) {
  const root = $("[data-kw-flow]", w), numerals = root.dataset.numerals || "0123456789";
  const hops = $$(".kw-flow__hop", root), statuses = $$(".kw-flow__status", root), token = $(".kw-flow__token", root), track = $(".kw-flow__track", root);
  const status = $("[data-kw-flow-status]", root), response = $("[data-kw-flow-response]", root), amount = $(".kw-flow__amount [data-kw-count]", root);
  const centre = (el) => { const r = el.getBoundingClientRect(), t = track.getBoundingClientRect(); return [r.left - t.left + r.width / 2, r.top - t.top + r.height / 2]; };
  const labelOf = (i) => { const s = [...statuses].reverse().find((x) => +x.dataset.hop <= i); return s; };
  const setHop = (i) => {
    hops.forEach((h, k) => { h.dataset.state = k < i ? "done" : k === i ? "now" : "todo"; });
    const cur = labelOf(i);
    statuses.forEach((s) => { const done = +s.dataset.hop <= i; s.dataset.state = done ? (s === cur ? "now" : "done") : "todo"; if (s === cur) s.setAttribute("aria-current", "step"); else s.removeAttribute("aria-current"); });
    if (cur) status.textContent = cur.textContent;
  };
  const finish = () => { hops.forEach((h) => { h.dataset.state = "done"; }); statuses.forEach((s) => { s.dataset.state = "done"; s.removeAttribute("aria-current"); }); statuses.at(-1)?.setAttribute("aria-current", "step"); if (statuses.at(-1)) status.textContent = statuses.at(-1).textContent; if (response) response.hidden = false; token.hidden = true; };
  async function run() {
    if (reduced()) { finish(); return; }
    const alive = sequence(w);
    if (response) response.hidden = true;
    token.hidden = false; token.textContent = amount?.dataset.kwFinal ?? amount?.textContent ?? "";
    if (token.textContent === "") token.classList.add("is-dot"); else token.classList.remove("is-dot");
    setHop(0);
    let [x, y] = centre($(".kw-flow__node", hops[0]));
    token.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
    amount && countUp(amount, { numerals, ms: 700 });
    for (let i = 1; i < hops.length; i++) {
      await new Promise((r) => setTimeout(r, 420)); if (!alive()) return;
      const [nx, ny] = centre($(".kw-flow__node", hops[i]));
      const a = token.animate([{ transform: `translate(${x}px,${y}px) translate(-50%,-50%)` }, { transform: `translate(${nx}px,${ny}px) translate(-50%,-50%)` }], { duration: 650, easing: "cubic-bezier(.45,.05,.25,1)", fill: "forwards" });
      try { await a.finished; } catch (e) { if (e?.name !== "AbortError") throw e; } // AbortError: a replay cancelled this hop, and alive() ends the old run
      if (!alive()) return;
      a.commitStyles?.(); a.cancel(); token.style.transform = `translate(${nx}px,${ny}px) translate(-50%,-50%)`;
      x = nx; y = ny; setHop(i);
    }
    await new Promise((r) => setTimeout(r, 380)); if (!alive()) return;
    finish();
  }
  $("[data-kw-flow-run]", root).addEventListener("click", run);
  w.kwAutoplay = run;
}
