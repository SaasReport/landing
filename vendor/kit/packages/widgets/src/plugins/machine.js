/** The `machine` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { esc, arrow, p, fillIn } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "machine", version: "1.0.0",
  describes: "state machines, grouped: pick a group and a machine, its states light up along its transitions (initial to terminal), each with its obligations",
  reads: ["machines"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/machine.js",
  spec: {
    key: "machines", shared: true,
    resolve: (raw, { T, list }) => list(raw, async (m) => ({ id: m.id, group: await T(m.group), title: await T(m.title), summary: await T(m.summary), meta: m.meta ? await list(m.meta, T) : undefined,
      states: await list(m.states, async (x) => ({ id: x.id, label: await T(x.label), kind: x.kind, detail: await T(x.detail), rules: x.rules ? await list(x.rules, T) : undefined })),
      transitions: await list(m.transitions, async (t) => ({ from: t.from, to: t.to, label: await T(t.label) })) })),
  },
  needs: (sc) => {
    if (!(sc.machines || []).length) return "needs \"machines\"";
    for (const m of sc.machines) { const ids = new Set(m.states.map((x) => x.id)); const bad = m.transitions.find((t) => !ids.has(t.from) || !ids.has(t.to)); if (bad) return `machine "${m.id}": transition ${bad.from} → ${bad.to} names a state it does not have`; }
    return null;
  },
  derive: (sc) => {
    // the path a pulse follows: from the initial state, breadth first along transitions
    const path = (m) => { const start = (m.states.find((x) => x.kind === "initial") || m.states[0]).id, seen = [start]; for (let i = 0; i < seen.length; i++) for (const t of m.transitions) if (t.from === seen[i] && !seen.includes(t.to)) seen.push(t.to); return seen; };
    const groups = [...new Set(sc.machines.map((m) => m.group))];
    return { groups, machines: sc.machines.map((m) => ({ ...m, path: path(m) })) };
  },
  render(w, c, f, locale, h) {
    const base = `${w.id}-${w.locale}`, d = w.data;
    const gid = (i) => `${base}-g-${i}`;
    const machine = (m, k) => `<article class="kw-sm" data-kw-machine data-path="${esc(m.path.join(" "))}"${k ? " hidden" : ""}>
<p class="kw-sm__title"><b>${esc(m.title)}</b>${m.meta?.length ? ` <small>${m.meta.map(esc).join(" · ")}</small>` : ""}</p>${p("kw-sm__sum", m.summary)}
<ol class="kw-sm__states">${m.path.map((sid) => m.states.find((x) => x.id === sid)).concat(m.states.filter((x) => !m.path.includes(x.id))).map((x) => `<li class="kw-sm__state" data-state="${esc(x.id)}" data-kind="${esc(x.kind || "")}"><b>${esc(x.label)}</b>${p("kw-sm__detail", x.detail)}${x.rules?.length ? `<ul class="kw-rules">${x.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ol>
<details class="kw-sm__tr"><summary>${esc(fillIn(c.transitions, { n: f.num(m.transitions.length) }))}</summary><ul>${m.transitions.map((t) => `<li><code dir="ltr">${esc(t.from)}</code> <span aria-hidden="true">${arrow(locale)}</span> <code dir="ltr">${esc(t.to)}</code>${t.label ? ` · ${esc(t.label)}` : ""}</li>`).join("")}</ul></details></article>`;
    return `<div class="kw-tabs" role="tablist" aria-label="${esc(w.title)}">${d.groups.map((g, i) => `<button type="button" role="tab" id="${gid(i)}-tab" aria-controls="${gid(i)}" aria-selected="${i === 0}" data-kw-tab>${esc(g)} <small>${esc(f.num(d.machines.filter((m) => m.group === g).length))}</small></button>`).join("")}</div>
${d.groups.map((g, i) => { const ms = d.machines.filter((m) => m.group === g); return `<div class="kw-smg" role="tabpanel" id="${gid(i)}" aria-labelledby="${gid(i)}-tab" data-kw-panel>
${ms.length > 1 ? `<div class="kw-chips kw-sm__pick" role="group" aria-label="${esc(c.machines)}">${ms.map((m, k) => `<button type="button" class="kw-chip" aria-pressed="${k === 0}" data-kw-pick="${k}">${esc(m.title)}</button>`).join("")}</div>` : ""}
${ms.map(machine).join("")}</div>`; }).join("")}
<div class="kw__bar"><button type="button" class="kw-btn" data-kw-pulse>${esc(c.pulse)}</button><span class="kw-status" data-kw-status aria-live="polite"></span></div>`;
  },
  check: () => [],
};
