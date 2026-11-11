/** The `timeline` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { stepBase } from "../scenario-kit.js";
import { esc, withDate, toneAttr, p, timeEl, fillIn } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "timeline", version: "1.0.0",
  describes: "dated events in order (deadlines, holidays, settlements), with the build date marked",
  reads: ["steps"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: null,
  needs: (sc) => (sc.steps.some((s) => s.at) ? null : "needs steps with \"at\" (a date)"),
  derive: (sc, ctx) => ({ asOf: ctx.asOf, events: sc.steps.filter((s) => s.at).map((s) => stepBase(sc, s)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) }),
  render(w, c, f, locale, h) {
    return `<p class="kw-asof">${esc(fillIn(c.asOf, { date: f.date(w.data.asOf) }))}</p>
<ol class="kw-tl">${w.data.events.map((e) => `<li class="kw-tl__ev"${toneAttr(e.tone)} data-when="${e.at < w.data.asOf ? "past" : e.at === w.data.asOf ? "today" : "next"}">
${timeEl(f, e.at)}<div><p class="kw-tl__title">${esc(e.action)}</p>${p("kw-tl__text", withDate(f, e.outcome || e.detail, e.at))}<p class="kw-tl__who">${esc(e.actor)}</p></div></li>`).join("")}</ol>`;
  },
  check: () => [],
};
