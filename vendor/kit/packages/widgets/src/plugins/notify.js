/** The `notify` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { actorOf, stepBase } from "../scenario-kit.js";
import { terminalNotify, TERMINAL_NOTIFY_USAGE } from "./_terminal-notify.js";
import { esc, withDate, toneAttr, p, val, decision, fillIn } from "../html-kit.js";

export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "notify", version: "1.0.0",
  describes: "a notification centre on device mockups (phone lock screen, approver console, dashboard, inbox): notifications arrive in turn; each opens an animated scene (chain hops, checklist, seal, revocation cascade); approve / decline / verify / revoke, the initiator never approves",
  reads: ["devices","steps","actors"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: "../../assets/widgets/plugins/notify.js",
  exports: { "terminal-notify": terminalNotify },
  exportUsage: { "terminal-notify": TERMINAL_NOTIFY_USAGE },
  spec: {
    key: "devices", shared: true,
    resolve: (raw, { T, list }) => list(raw, async (d) => ({ id: d.id, kind: d.kind, label: await T(d.label), actor: d.actor })),
  },
  validate(scenario) {
    const p = [], w = `scenarios.${scenario.id}`, act = new Set(scenario.actors.map((a) => a.id)), devs = new Set((scenario.devices || []).map((d) => d.id));
    for (const d of scenario.devices || []) if (!act.has(d.actor)) p.push(`${w}.devices.${d.id}: unknown actor "${d.actor}"`);
    for (const st of scenario.steps) {
      if (st.device && !devs.has(st.device)) p.push(`${w}.steps.${st.id}: unknown device "${st.device}"`);
      if (st.initiator && !act.has(st.initiator)) p.push(`${w}.steps.${st.id}: unknown actor "${st.initiator}" (initiator)`);
      for (const a of st.actions || []) if (a.by && !act.has(a.by)) p.push(`${w}.steps.${st.id}: unknown actor "${a.by}" (action by)`);
    }
    return p;
  },
  needs: (sc) => {
    if (!(sc.devices || []).length) return "needs \"devices\"";
    const empty = sc.devices.find((d) => !sc.steps.some((s) => s.device === d.id));
    return empty ? `device "${empty.id}" receives no notification (every device needs at least one step with that device)` : null;
  },
  derive: (sc, ctx) => ({
    asOf: ctx.asOf,
    devices: sc.devices.map((d) => ({ id: d.id, kind: d.kind, label: d.label, actor: actorOf(sc, d.actor)?.label })),
    items: sc.steps.filter((s) => s.device).map((s) => ({
      ...stepBase(sc, s), device: s.device,
      ...(s.initiator ? { initiator: actorOf(sc, s.initiator)?.label } : {}),
      ...(s.scene ? { scene: s.scene } : {}),
      ...(s.actions ? { actions: s.actions.map((a) => ({ ...a, ...(a.by ? { by: actorOf(sc, a.by)?.label, blocked: a.kind === "approve" && a.by === s.initiator } : {}) })) } : {}),
    })),
  }),
  render(w, c, f, locale, h) {
    const base = `${w.id}-${w.locale}`;
    const scene = (it, i) => {
      const sc = it.scene; if (!sc) return "";
      const items = sc.items.map((x) => `<li${x.tone ? toneAttr(x.tone) : ""}><span class="kw-scene__dot" aria-hidden="true"></span><b>${esc(x.label)}</b>${x.value != null && x.value !== "" ? ` <span>${val(c, f, x.value)}</span>` : ""}</li>`).join("");
      return `<div class="kw-scene kw-scene--${esc(sc.kind)}" id="${esc(base)}-scene-${i}" data-kw-scene="${esc(sc.kind)}">${sc.title ? `<p class="kw-scene__title">${esc(sc.title)}</p>` : ""}<ol class="kw-scene__list">${items}</ol>${sc.kind === "seal" ? `<p class="kw-scene__seal"><code dir="ltr" data-kw-hash>${esc(sc.hash || "")}</code><span class="kw-scene__stamp" aria-hidden="true">✓</span></p>` : ""}</div>`;
    };
    const order = new Map(w.data.items.map((it, i) => [it, i]));
    const card = (it) => {
      const i = order.get(it);
      return `<li class="kw-nc__n"${toneAttr(it.tone)} data-kw-n="${i}" data-device="${esc(it.device)}">
<div class="kw-nc__head"><span class="kw-nc__icon" aria-hidden="true">${esc(it.icon || "")}</span><p class="kw-nc__meta"><b>${esc(it.actor)}</b><time>${it.at ? esc(f.date(it.at)) : esc(c.now)}</time></p></div>
<p class="kw-nc__title">${esc(it.action)}</p>${p("kw-nc__body", withDate(f, it.outcome || it.detail, it.at))}
<p class="kw-nc__tags">${it.chip ? `<span class="kw-chip">${esc(it.chip)}</span>` : ""}${decision(c, it.decision)}</p>
${it.scene ? `<button type="button" class="kw-nc__open" aria-expanded="true" aria-controls="${esc(base)}-scene-${i}" data-kw-open>${esc(c.details)}</button>${scene(it, i)}` : ""}
${it.actions?.length ? `<div class="kw-acts">${it.actions.map((a, j) => `<button type="button" class="kw-btn${j || a.blocked ? " kw-btn--ghost" : ""}" data-kw-act data-kind="${esc(a.kind || "")}" data-done="${esc(a.done || c.done)}" data-result="${esc(a.blocked ? c.initiatorBlocked : a.result)}"${a.blocked ? ' data-blocked="1"' : ""}${toneAttr(a.blocked ? "err" : a.tone)}>${a.blocked ? esc(fillIn(c.selfApprove, { who: a.by })) : `${esc(a.label)}${a.by ? ` <small>${esc(a.by)}</small>` : ""}`}</button>`).join("")}<p class="kw-result" data-kw-result hidden></p></div>` : ""}
</li>`;
    };
    // phones first: the stage puts the phone large on the start side and the other devices beside it
    const devices = [...w.data.devices].sort((x, y) => (x.kind === "phone" ? 0 : 1) - (y.kind === "phone" ? 0 : 1));
    const count = (d) => w.data.items.filter((it) => it.device === d.id).length;
    const device = (d) => `<figure class="kw-dev kw-dev--${esc(d.kind)}" id="${esc(base)}-dev-${esc(d.id)}" data-kw-dev="${esc(d.id)}" role="tabpanel" aria-label="${esc(d.label)}">
${d.kind === "phone" ? `<div class="kw-dev__lock" aria-hidden="true"><span class="kw-dev__notch"></span><p class="kw-dev__time" data-kw-clock></p><p class="kw-dev__date">${esc(f.date(w.data.asOf))}</p></div>` : ""}
<figcaption class="kw-dev__bar"><span class="kw-dev__dots" aria-hidden="true"><i></i><i></i><i></i></span><b>${esc(d.label)}</b><small>${esc(d.actor)}</small></figcaption>
<ol class="kw-dev__stack" aria-live="polite">${w.data.items.filter((it) => it.device === d.id).map(card).join("")}</ol></figure>`;
    // the other devices in two columns balanced by how many notifications each receives (no row gaps, no dead column)
    const side = (list) => {
      const cols = [[], []], load = [0, 0];
      for (const d of [...list].sort((x, y) => count(y) - count(x))) { const k = load[0] <= load[1] ? 0 : 1; cols[k].push(d); load[k] += count(d) + 1; }
      const order = (col) => list.filter((d) => col.includes(d));
      return `<div class="kw-nc__side">${cols.filter((col) => col.length).map((col) => `<div class="kw-nc__col">${order(col).map(device).join("")}</div>`).join("")}</div>`;
    };
    return `<div class="kw-nc" data-kw-nc data-numerals="${esc(f.numerals)}">
<div class="kw__bar"><button type="button" class="kw-btn" data-kw-play aria-pressed="false" data-play="${esc(c.play)}" data-pause="${esc(c.pause)}">${esc(c.play)}</button><span class="kw-status" data-kw-status aria-live="polite"></span></div>
<div class="kw-nc__tabs" role="tablist" aria-label="${esc(w.title)}">${devices.map((d, k) => `<button type="button" role="tab" aria-selected="${k === 0}" aria-controls="${esc(base)}-dev-${esc(d.id)}" data-kw-devtab="${esc(d.id)}">${esc(d.label)} <span class="kw-nc__badge" data-kw-badge>${esc(f.num(count(d)))}</span></button>`).join("")}</div>
<div class="kw-nc__stage${devices[0]?.kind === "phone" ? " has-phone" : ""}">${devices[0]?.kind === "phone" ? `<div class="kw-nc__main">${device(devices[0])}</div>${side(devices.slice(1))}` : side(devices)}</div>
</div>`;
  },
  check: () => [],
};
