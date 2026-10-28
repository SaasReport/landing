/** The `roles` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { pick } from "../scenario-kit.js";
import { esc, arrow, p } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "roles", version: "1.0.0",
  describes: "a role switcher / stakeholder map: each actor, what it sees and what it does in the scenario",
  reads: ["actors","steps"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/roles.js",
  needs: (sc) => (sc.actors.length < 2 ? "needs at least two actors" : null),
  derive: (sc) => ({
    roles: sc.actors.map((a) => ({ ...pick(a, ["id", "label", "role", "kind", "sees"]), does: sc.steps.filter((s) => s.actor === a.id).map((s) => s.action) })),
    links: sc.steps.filter((s) => s.to).map((s) => ({ from: s.actor, to: s.to, label: s.chip || s.action })),
  }),
  render(w, c, f, locale, h) {
    const id = (i) => `${w.id}-${w.locale}-role-${i}`;
    const label = (aid) => w.data.roles.find((r) => r.id === aid)?.label || aid;
    return `<div class="kw-tabs" role="tablist" aria-label="${esc(w.title)}">${w.data.roles.map((r, i) => `<button type="button" role="tab" id="${id(i)}-tab" aria-controls="${id(i)}" aria-selected="${i === 0}" data-kw-tab data-kind="${esc(r.kind)}">${esc(r.label)}</button>`).join("")}</div>
${w.data.roles.map((r, i) => `<div class="kw-role" role="tabpanel" id="${id(i)}" aria-labelledby="${id(i)}-tab" data-kw-panel>
<h5>${esc(r.label)}</h5>${p("kw-role__role", r.role)}
${r.sees?.length ? `<p class="kw-role__k">${esc(c.sees)}</p><ul>${r.sees.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
${r.does?.length ? `<p class="kw-role__k">${esc(c.does)}</p><ul>${r.does.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
${w.data.links.filter((l) => l.from === r.id || l.to === r.id).map((l) => `<p class="kw-role__link">${esc(label(l.from))} <span aria-hidden="true">${arrow(locale)}</span> ${esc(label(l.to))}: ${esc(l.label)}</p>`).join("")}</div>`).join("")}`;
  },
  check: () => [],
};
