/* The tour archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const root = $("[data-kw-tour]", w), tasks = $$("[data-kw-tour-task]", w), links = $$("[data-kw-task]", w), finish = $("[data-kw-tour-finish]", w);
  const status = $("[data-kw-status]", w), back = $("[data-kw-back]", w), next = $("[data-kw-next]", w);
  // numerals from @saasreport/format (data-numerals on the tour), never the browser's ICU
  const num = (n) => String(n).replace(/[0-9]/g, (x) => (root.dataset.numerals || "0123456789")[x]);
  const fill = (t, v) => t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? num(v[k]) : m));
  const steps = tasks.map((t) => $$("[data-kw-tour-step]", t));
  const seen = steps.map(() => 0);
  let ti = 0, si = 0, done = false;
  const label = $("[data-kw-prog]", w)?.dataset.label || "{n} / {total}";
  const show = (push) => {
    tasks.forEach((t, i) => { t.dataset.state = !done && i === ti ? "now" : "off"; });
    steps.forEach((list, i) => list.forEach((st, j) => { st.dataset.state = i !== ti ? "off" : j < si ? "done" : j === si ? "now" : "todo"; if (i === ti && j === si && !done) st.setAttribute("aria-current", "step"); else st.removeAttribute("aria-current"); }));
    if (!done) seen[ti] = Math.max(seen[ti], si + 1);
    links.forEach((a, i) => {
      a.setAttribute("aria-current", !done && i === ti ? "step" : "false");
      const pr = $("[data-kw-prog]", a), total = +pr.dataset.total;
      pr.textContent = fill(label, { n: seen[i], total }); a.style.setProperty("--kw-p", `${(100 * seen[i]) / total}%`);
      a.dataset.done = seen[i] === total ? "1" : "";
    });
    finish.hidden = !done;
    const cur = steps[ti][si];
    status.textContent = done ? $("h5", finish).textContent : `${fill(label, { n: si + 1, total: steps[ti].length })}: ${$(".kw-tour__what", cur).textContent}`;
    back.disabled = !done && ti === 0 && si === 0;
    next.disabled = done;
    next.textContent = si < steps[ti].length - 1 ? root.dataset.next : ti < tasks.length - 1 ? root.dataset.continue : root.dataset.finish;
    if (push) {
      try { const u = new URL(location.href); u.searchParams.set("task", tasks[ti].dataset.kwTourTask); u.searchParams.set("step", String(si + 1)); history.replaceState(null, "", u); } catch { /* a sandboxed frame refuses history: the step is not deep-linked */ }
    }
  };
  const go = (d) => {
    if (done) { if (d < 0) { done = false; } show(true); return; }
    if (d > 0) { if (si < steps[ti].length - 1) si++; else if (ti < tasks.length - 1) { ti++; si = 0; } else done = true; }
    else if (si > 0) si--; else if (ti > 0) { ti--; si = steps[ti].length - 1; }
    show(true);
  };
  next.addEventListener("click", () => go(1));
  back.addEventListener("click", () => go(-1));
  links.forEach((a, i) => a.addEventListener("click", (e) => { e.preventDefault(); done = false; ti = i; si = 0; show(true); }));
  const rtl = getComputedStyle(w).direction === "rtl";
  w.addEventListener("keydown", (e) => {
    if (e.target.closest("input,select,textarea")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); go(rtl ? -1 : 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(rtl ? 1 : -1); }
  });
  // deep link: ?task=<id>&step=<n>
  try {
    const q = new URLSearchParams(location.search), k = tasks.findIndex((t) => t.dataset.kwTourTask === q.get("task"));
    if (k >= 0) { ti = k; si = Math.min(Math.max(1, +q.get("step") || 1), steps[k].length) - 1; for (let i = 0; i < k; i++) seen[i] = seen[i]; }
  } catch { /* no readable location in a sandboxed frame: the tour starts at the beginning */ }
  show(false);
}
