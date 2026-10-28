/** The `tour` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { actorOf, stepBase } from "../scenario-kit.js";
import { esc, arrow, toneAttr, p, val, decision, fillIn } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "tour", version: "1.0.0",
  describes: "a guided tour: a checklist of tasks, each a run of steps with a callout pinned to a named region of a mock screen; deep links, progress per task, a finish card with the only call to action",
  reads: ["tour","steps","screens"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/tour.js",
  spec: {
    key: "tour", shared: true,
    resolve: async (raw, { T, list }) => ({
      tasks: await list(raw.tasks, async (k) => ({ id: k.id, title: await T(k.title), benefit: await T(k.benefit), steps: k.steps })),
      callouts: raw.callouts || [],
      finish: { title: await T(raw.finish.title), text: await T(raw.finish.text), cta: { label: await T(raw.finish.cta.label), href: raw.finish.cta.href } },
    }),
  },
  needs: (sc) => {
    if (!sc.tour) return "needs \"tour\" (tasks, callouts, finish)";
    const ids = new Set(sc.steps.map((s) => s.id)), used = sc.tour.tasks.flatMap((k) => k.steps);
    if (used.length < 2) return "needs at least two steps across its tasks";
    const missing = used.find((id) => !ids.has(id));
    if (missing) return `task step "${missing}" is not a step of the scenario`;
    for (const c of sc.tour.callouts) {
      if (!used.includes(c.step)) return `callout step "${c.step}" is in no task`;
      const scr = (sc.screens || []).find((x) => x.id === c.screen);
      if (!scr) return `callout screen "${c.screen}" is not one of the scenario's screens`;
      if (![...(scr.lines || []).map((l) => l.id), ...(scr.regions || []).map((r) => r.id)].includes(c.anchor)) return `anchor "${c.anchor}" is not a region of screen "${c.screen}"`;
    }
    return null;
  },
  derive: (sc) => ({
    tasks: sc.tour.tasks.map((k) => ({
      id: k.id, title: k.title, ...(k.benefit ? { benefit: k.benefit } : {}),
      steps: k.steps.map((id) => {
        const s = sc.steps.find((x) => x.id === id), c = sc.tour.callouts.find((x) => x.step === id);
        const scr = c && sc.screens.find((x) => x.id === c.screen);
        return { ...stepBase(sc, s), ...(c ? { screen: { ...scr, actor: actorOf(sc, scr.actor)?.label }, anchor: c.anchor, appearance: c.appearance || "callout", ...(c.beat ? { beat: c.beat } : {}) } : { appearance: "modal" }) };
      }),
    })),
    finish: sc.tour.finish,
  }),
  render(w, c, f, locale, h) {
    const base = `${w.id}-${w.locale}`;
    const all = w.data.tasks.flatMap((k) => k.steps.length);
    const screen = (st) => `<figure class="kw-phone kw-tour__screen" aria-label="${esc(st.screen.title)}"><figcaption><b>${esc(st.screen.title)}</b><small>${esc(st.screen.actor)}</small></figcaption>
${st.screen.regions?.length ? `<p class="kw-chips">${st.screen.regions.map((r) => `<span class="kw-chip"${r.id === st.anchor ? ' data-anchor="1"' : ""}>${esc(r.label)}</span>`).join("")}</p>` : ""}
${st.screen.lines?.length ? `<dl class="kw-kv">${st.screen.lines.map((l) => `<div${l.tone ? toneAttr(l.tone) : ""}${l.id === st.anchor ? ' data-anchor="1"' : ""}><dt>${esc(l.label)}</dt><dd>${val(c, f, l.value)}</dd></div>`).join("")}</dl>` : ""}
${st.screen.cta ? `<span class="kw-phone__cta">${esc(st.screen.cta)}</span>` : ""}</figure>`;
    return `<div class="kw-tour" data-kw-tour data-numerals="${esc(f.numerals)}" data-continue="${esc(c.continue)}" data-finish="${esc(c.finishTour)}" data-next="${esc(c.next)}">
<nav class="kw-tour__list" aria-label="${esc(c.tasks)}"><ol>${w.data.tasks.map((k, i) => `<li><a href="?task=${esc(k.id)}&amp;step=1#w-${esc(base)}" data-kw-task="${esc(k.id)}"><b>${esc(k.title)}</b>${k.benefit ? `<small>${esc(k.benefit)}</small>` : ""}<span class="kw-tour__prog" data-kw-prog data-total="${k.steps.length}" data-label="${esc(c.taskProgress)}">${esc(fillIn(c.taskProgress, { n: f.num(0), total: f.num(k.steps.length) }))}</span><i class="kw-tour__bar" aria-hidden="true"><i></i></i></a></li>`).join("")}</ol></nav>
<div class="kw-tour__stage">
${w.data.tasks.map((k) => `<section class="kw-tour__task" data-kw-tour-task="${esc(k.id)}" aria-labelledby="${esc(base)}-${esc(k.id)}-t"><h5 id="${esc(base)}-${esc(k.id)}-t">${esc(k.title)}</h5>
<ol class="kw-tour__steps">${k.steps.map((st, j) => `<li class="kw-tour__step"${toneAttr(st.tone)} data-kw-tour-step="${j + 1}" data-appearance="${esc(st.appearance)}">
<p class="kw-tour__n">${esc(fillIn(c.stepOf, { n: f.num(j + 1), total: f.num(k.steps.length) }))}</p>
${st.screen ? screen(st) : ""}
<div class="kw-tour__callout" role="note">${st.beat ? `<span class="kw-chip" data-beat="${esc(st.beat)}">${esc(c.beats[st.beat])}</span>` : ""}<p class="kw-tour__who"><b>${esc(st.actor)}</b>${st.to ? ` <span aria-hidden="true">${arrow(locale)}</span> ${esc(st.to)}` : ""}${st.chip ? ` <span class="kw-chip">${esc(st.chip)}</span>` : ""}${decision(c, st.decision)}</p>
<p class="kw-tour__what">${esc(st.action)}</p>${p("kw-tour__detail", st.detail)}${p("kw-tour__out", st.outcome)}${st.rules?.length ? `<ul class="kw-rules">${st.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}</div></li>`).join("")}</ol></section>`).join("\n")}
<section class="kw-tour__finish" data-kw-tour-finish><h5>${esc(w.data.finish.title)}</h5>${p("", w.data.finish.text)}<a class="kw-btn" href="${esc(w.data.finish.cta.href)}">${esc(w.data.finish.cta.label)}</a></section>
</div>
<div class="kw__bar kw__bar--end kw-tour__nav"><button type="button" class="kw-btn kw-btn--ghost" data-kw-back>${esc(c.back)}</button><span class="kw-status" data-kw-status aria-live="polite">${esc(fillIn(c.taskProgress, { n: f.num(1), total: f.num(all[0] || 1) }))}</span><button type="button" class="kw-btn" data-kw-next>${esc(c.next)}</button></div>
</div>`;
  },
  check: () => [],
};
