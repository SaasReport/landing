/** The `chain` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { expected, stepBase } from "../scenario-kit.js";
import { esc, arrow, toneAttr, p, fields, expectedBox, decision } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "chain", version: "1.0.0",
  describes: "a chain of authority or custody: each link is an actor and what it did, ending in the decision and its evidence",
  reads: ["actors","steps","outcomes"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/chain.js",
  needs: (sc) => (sc.steps.length < 2 ? "needs at least two steps (links)" : null),
  derive: (sc) => ({ links: sc.steps.map((s) => stepBase(sc, s)), expected: expected(sc) }),
  render(w, c, f, locale, h) {
    const n = w.data.links.length;
    return `<div class="kw__bar"><button type="button" class="kw-btn" data-kw-walk>${esc(c.walk)}</button></div>
<ol class="kw-chain" data-kw-items>${w.data.links.map((l, i) => `<li class="kw-chain__link"${toneAttr(l.tone)} data-kind="${esc(l.actorKind || "")}">
<div class="kw-chain__node" aria-hidden="true">${esc(f.num(i + 1))}</div>
<div class="kw-chain__card"><p class="kw-chain__who"><b>${esc(l.actor)}</b>${l.to ? ` <span aria-hidden="true">${arrow(locale)}</span> ${esc(l.to)}` : ""}${decision(c, l.decision)}</p>
<p class="kw-chain__what">${esc(l.action)}</p><div class="kw-chain__more" data-kw-more>${p("", l.detail)}${p("kw-chain__out", l.outcome)}${fields(c, null, l.fields)}</div></div>
${i < n - 1 ? '<span class="kw-chain__rail" aria-hidden="true"></span>' : ""}</li>`).join("")}</ol>${expectedBox(c, w.data.expected)}`;
  },
  check: () => [],
};
