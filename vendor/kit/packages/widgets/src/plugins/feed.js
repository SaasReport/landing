/** The `feed` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { stepBase } from "../scenario-kit.js";
import { terminalNotify, TERMINAL_NOTIFY_USAGE } from "./_terminal-notify.js";
import { esc, arrow, withDate, toneAttr, p, timeEl, decision } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "feed", version: "1.0.0",
  describes: "a notification or decision stream: one item per step, with its actor, tone, time, channels and actions",
  reads: ["actors","steps"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/feed.js",
  exports: { "terminal-notify": terminalNotify },
  exportUsage: { "terminal-notify": TERMINAL_NOTIFY_USAGE },
  needs: () => null,
  derive: (sc) => ({ items: sc.steps.map((s) => stepBase(sc, s)) }),
  render(w, c, f, locale, h) {
    return `<div class="kw__bar"><button type="button" class="kw-btn" data-kw-replay>${esc(c.play)}</button></div>
<ol class="kw-feed" data-kw-items aria-live="polite">${w.data.items.map((it) => `<li class="kw-feed__item"${toneAttr(it.tone)}>
<span class="kw-feed__icon" aria-hidden="true">${esc(it.icon || "")}</span>
<div class="kw-feed__body"><p class="kw-feed__meta"><span><b>${esc(it.actor)}</b>${it.to ? ` <span aria-hidden="true">${arrow(locale)}</span> ${esc(it.to)}` : ""}</span>${it.at ? `<span>${timeEl(f, it.at)}</span>` : ""}${it.event ? `<code dir="ltr">${esc(it.event)}</code>` : ""}${decision(c, it.decision)}</p>
<p class="kw-feed__title">${esc(it.action)}</p>${p("kw-feed__text", withDate(f, it.outcome, it.at))}${p("kw-feed__detail", withDate(f, it.detail, it.at))}
${it.channels?.length ? `<p class="kw-chips" aria-label="${esc(c.channels)}">${it.channels.map((ch) => `<span class="kw-chip"${it.fails === ch ? ' data-fails="1"' : ""}>${esc(c.ch?.[ch] || ch)}${it.fails === ch ? ` <small>${esc(c.fails)}</small>` : ""}</span>`).join("")}</p>` : ""}
${it.rules?.length ? `<ul class="kw-rules" aria-label="${esc(c.rules)}">${it.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
${it.actions?.length ? `<div class="kw-acts">${it.actions.map((a, i) => `<button type="button" class="kw-btn${i ? " kw-btn--ghost" : ""}" data-kw-act data-done="${esc(a.done || c.done)}" data-result="${esc(a.result)}"${toneAttr(a.tone)}>${esc(a.label)}</button>`).join("")}<p class="kw-result" data-kw-result hidden></p></div>` : ""}
</div></li>`).join("")}</ol>`;
  },
  check: () => [],
};
