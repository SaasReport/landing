/** The `screens` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { actorOf } from "../scenario-kit.js";
import { esc, fields, fillIn } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "screens", version: "1.0.0",
  describes: "mock screens of what each actor sees, one at a time",
  reads: ["screens","actors"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/screens.js",
  needs: (sc) => ((sc.screens || []).length ? null : "needs \"screens\""),
  derive: (sc) => ({ screens: sc.screens.map((x) => ({ ...x, actor: actorOf(sc, x.actor)?.label })) }),
  render(w, c, f, locale, h) {
    const n = w.data.screens.length;
    return `<div class="kw-screens" data-kw-screens>${w.data.screens.map((s, i) => `<figure class="kw-phone" data-kw-screen aria-label="${esc(fillIn(c.screen, { n: f.num(i + 1), total: f.num(n) }))}">
<figcaption><b>${esc(s.title)}</b><small>${esc(s.actor)}</small></figcaption>${fields(c, f, s.lines)}${s.cta ? `<span class="kw-phone__cta">${esc(s.cta)}</span>` : ""}</figure>`).join("")}</div>
${n > 1 ? `<div class="kw__bar kw__bar--end"><button type="button" class="kw-btn kw-btn--ghost" data-kw-prev aria-label="${esc(c.prev)}">${esc(c.back)}</button><button type="button" class="kw-btn" data-kw-nextscreen aria-label="${esc(c.nextScreen)}">${esc(c.next)}</button><span class="kw-status" data-kw-status aria-live="polite"></span></div>` : ""}`;
  },
  check: () => [],
};
