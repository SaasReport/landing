/**
 * Landing section templates. Each takes the section's content object `s` and the render context `c`
 * ({ L: locale runtime, d: digits, t: chrome strings, tokens, site }) and returns lines of HTML.
 * The markup (classes and data-* hooks) is the contract with the theme CSS and the client scripts.
 */
import { attr, attrs, button, ico, link, pad, rows, flat } from "../html.js";
import { head, section, actions, note, stage, addon } from "./common.js";
import { roleVar } from "../tokens.js";

const li = (x) => `<li>${x}</li>`;
const span = (x) => `<span>${x}</span>`;
const sel = (i, on = 0) => (i === on ? "true" : "false");
const tone = (x, tag = "span") => (typeof x === "string" ? `<${tag}>${x}</${tag}>` : `<${tag} class="${attr(x.tone)}">${x.text}</${tag}>`);
const status = (x) => `<em class="st st--${attr(x.tone)}">${x.text}</em>`;

/** The opening cover: copy, calls to action and a product mock with steps and counters. */
function hero(s, c) {
  const m = s.mock;
  return [
    ...(s.comment ? [`<!-- ============ ${s.comment} ============ -->`] : []),
    `<section class="hero" id="${attr(s.id || "top")}">`,
    `  <svg class="hero__rails" viewBox="0 0 1440 820" preserveAspectRatio="xMidYMid slice" aria-hidden="true">`,
    `    <path pathLength="1" d="M-20 770 H700 Q740 770 740 730 V700"/>`,
    `    <path pathLength="1" d="M1460 44 H980 Q940 44 940 84 V112"/>`,
    `    <path class="w" pathLength="1" d="M1460 610 H1370 Q1330 610 1330 650 V840"/>`,
    `    <circle cx="740" cy="700" r="9"/><circle cx="940" cy="112" r="9"/>`,
    `  </svg>`,
    `  <div class="wrap hero__grid">`,
    `    <div class="hero__copy">`,
    `      <p class="eyebrow reveal"><span class="dot"></span>${s.eyebrow}</p>`,
    `      <h1 class="hero__title reveal">${s.title}</h1>`,
    ...(s.lead ? [`      <p class="hero__lead reveal">${s.lead}</p>`] : []),
    ...(s.sub ? [`      <p class="hero__sub reveal">${s.sub}</p>`] : []),
    ...(s.strip ? [`      <ul class="vstrip reveal" aria-label="${attr(s.strip.label)}">${s.strip.items.map(li).join("")}</ul>`] : []),
    `      <div class="hero__actions reveal">`,
    ...s.actions.map((a) => `        ${button(a, { size: "lg" })}`),
    `      </div>`,
    ...(s.note ? [`      <p class="hero__note reveal">${ico("check", true)}${s.note}</p>`] : []),
    `    </div>`,
    ``,
    `    <div class="hero__visual reveal">`,
    `      <div class="railed"><span class="rail-node rail-node--top" aria-hidden="true"></span><span class="rail-node rail-node--side" aria-hidden="true"></span>`,
    `      <div class="mock">`,
    `        <div class="mock__bar"><span></span><span></span><span></span><em>${m.bar}</em></div>`,
    `        <div class="mock__head">`,
    `          <div><small>${m.kicker}</small><strong>${m.product}</strong></div>`,
    `          <span class="badge badge--live"><i></i>${m.badge}</span>`,
    `        </div>`,
    `        <ol class="mock__steps" data-hero-steps>`,
    ...m.steps.map((x, i) => `          <li><span class="mock__n">${c.d(i + 1)}</span>${x}<b>${m.stepStatus}</b></li>`),
    `        </ol>`,
    `        <div class="mock__flow" aria-hidden="true"><i></i></div>`,
    `        <div class="mock__stats">`,
    ...m.stats.map((x) => `          <div><strong data-count="${attr(x.count)}"${x.format ? ` data-format="${attr(x.format)}"` : ""}>${c.d(0)}</strong><small>${x.label}</small></div>`),
    `        </div>`,
    `      </div>`,
    `      </div>`,
    `    </div>`,
    `  </div>`,
    `</section>`,
  ];
}

/** A scrolling strip of audiences. */
function audience(s) {
  return [
    ...(s.comment ? [`<!-- ============ ${s.comment} ============ -->`] : []),
    `<section class="audience" aria-label="${attr(s.label)}">`,
    `  <p class="audience__title">${s.title}</p>`,
    `  <div class="marquee"><div class="marquee__track">`,
    `    ${s.items.map(span).join("")}`,
    `    ${s.items.map((x) => `<span aria-hidden="true">${x}</span>`).join("")}`,
    `  </div></div>`,
    `</section>`,
  ];
}

/** A grid of cards: numbered (problems), icon (outcomes) or trend (▲/▼ value cards). */
function cards(s, c) {
  const card = {
    numbered: (x, i) => `<article class="pcard reveal"><span class="pcard__n">${c.d(i + 1)}</span><h3>${x.title}</h3><p>${x.text}</p></article>`,
    icon: (x) => `<article class="bcard reveal"><span class="bcard__i">${ico(x.icon)}</span><h3>${x.title}</h3><p>${x.text}</p></article>`,
    trend: (x) => `<article class="rcard reveal"><span class="rcard__dir rcard__dir--${x.dir === "up" ? "up" : "down"}" aria-hidden="true">${x.dir === "up" ? "▲" : "▼"}</span><h3>${x.title}</h3><p>${x.text}</p></article>`,
  }[s.style || "icon"];
  return section(s, [
    ...head(s.head),
    `    <div class="grid grid--${s.grid || "3"}">`,
    ...s.items.map((x, i) => `      ${card(x, i)}`),
    `    </div>`,
  ]);
}

/** Split: the approach (header with numbered modes and actions) next to a vertical flow. */
function approach(s, c) {
  const r = rows(s.flow);
  const last = r.length - 1;
  return section(s, [
    ...head(s.head, { start: true, extra: [
      ...(s.modes ? [`<ul class="modes3">${s.modes.map((x, i) => `<li><b>${c.d(i + 1)}</b>${x}</li>`).join("")}</ul>`] : []),
      ...(s.actions ? [`<div class="actions">${s.actions.map((a) => button(a)).join("")}</div>`] : []),
    ] }),
    `    <ol class="vflow reveal" data-vflow>`,
    ...r.map((row, ri) => `      ${row.map((x, i) => (ri === last && i === row.length - 1 ? `<li class="is-final">${x}</li>` : li(x))).join("")}`),
    `      <span class="vflow__pulse" aria-hidden="true"></span>`,
    `    </ol>`,
  ], { wrap: "wrap split" });
}

/** Role tabs: one tab per audience, each with who/what and one call to action. */
function roles(s) {
  return section(s, [
    ...head(s.head),
    `    <div class="tabs tabs--icp reveal" data-tabs>`,
    `      <div class="tabs__list" role="tablist">${s.items.map((x, i) => `<button role="tab" aria-selected="${sel(i)}">${ico(x.icon, true)}${x.tab}</button>`).join("")}</div>`,
    ...s.items.map((x, i) => `      <div class="tabs__panel${i === 0 ? " is-active" : ""}" role="tabpanel"><div class="icp"><span class="icp__i">${ico(x.icon)}</span><div><p class="icp__who">${x.who}</p><p class="icp__what">${x.what}</p>${button(x.action)}</div></div></div>`),
    `    </div>`,
  ]);
}

/** Product domains: buttons that open the product's lifecycle. */
function domains(s) {
  return section(s, [
    ...head(s.head),
    `    <div class="grid grid--domains" data-domains>`,
    ...s.items.map((x) => `      <button class="dcard reveal" data-product="${attr(x.product)}">${ico(x.icon)}<h3>${x.title}</h3><p>${x.text}</p><span class="dcard__go">${s.go}${ico("arrow", true)}</span></button>`),
    `    </div>`,
  ]);
}

/** A four-step stepper with example and outputs per step. */
function stepper(s, c) {
  return section(s, [
    ...head(s.head),
    `    <div class="stepper reveal" data-stepper>`,
    `      <div class="stepper__rail" role="tablist" aria-label="${attr(s.label)}">`,
    ...s.steps.map((x, i) => `        <button role="tab" aria-selected="${sel(i)}" data-step="${i}"><span>${c.d(i + 1)}</span>${x.tab}</button>`),
    `        <i class="stepper__bar" aria-hidden="true"></i>`,
    `      </div>`,
    `      <div class="stepper__panels">`,
    ...s.steps.flatMap((x, i) => [
      `        <div class="stepper__panel${i === 0 ? " is-active" : ""}" role="tabpanel">`,
      `          <div><h3>${x.title}</h3><p>${x.text}</p>`,
      `          <p class="ex"><small>${s.exampleLabel}</small>${x.example}</p></div>`,
      `          <div class="outs${x.flow ? " outs--flow" : ""}"><small>${s.outputsLabel}</small>${x.outputs.map((o) => tone(o)).join(x.flow ? `<em>${c.L.arrow.next}</em>` : "")}</div>`,
      `        </div>`,
    ]),
    `      </div>`,
    `    </div>`,
  ]);
}

/** Starter packs: tabs of chips, then sector cards and the seed-data block. */
function packs(s) {
  const seed = s.seed;
  return section(s, [
    ...head(s.head),
    `    <div class="tabs reveal" data-tabs>`,
    `      <div class="tabs__list" role="tablist">`,
    ...s.tabs.map((x, i) => `        <button role="tab" aria-selected="${sel(i)}">${x.tab}</button>`),
    `      </div>`,
    ...s.tabs.map((x, i) => `      <div class="tabs__panel${i === 0 ? " is-active" : ""}" role="tabpanel"><p class="tabs__lead">${x.lead}</p><div class="chips">${x.chips.map(span).join("")}</div></div>`),
    `    </div>`,
    ...(s.sectors ? [
      ``,
      `    <h3 class="sub-title reveal">${s.sectors.title}</h3>`,
      `    <div class="grid grid--3 sectors">`,
      ...s.sectors.items.map((x) => `      <article class="scard reveal">${ico(x.icon)}<h4>${x.title}</h4><p>${x.text}</p></article>`),
      `    </div>`,
    ] : []),
    ...(seed ? [
      ``,
      `    <div class="seed reveal" id="${attr(seed.id || "seed")}">`,
      `      <div class="seed__copy">`,
      `        <p class="eyebrow">${seed.eyebrow}</p>`,
      `        <h3>${seed.title}</h3>`,
      `        <p>${seed.text}</p>`,
      `        <div class="seg" role="tablist" data-seed-tabs>`,
      ...seed.tabs.map((x, i) => `          <button role="tab" aria-selected="${sel(i)}" data-seed="${attr(x.key)}">${x.label}</button>`),
      `        </div>`,
      `      </div>`,
      `      <div class="seed__board" data-seed-board aria-live="polite"></div>`,
      `    </div>`,
    ] : []),
  ]);
}

/** The product lifecycle explorer (filled in by the client script). */
function lifecycle(s) {
  return section(s, [
    ...head(s.head),
    `    <div class="lc reveal" data-lifecycle>`,
    `      <div class="lc__tabs" role="tablist"></div>`,
    `      <div class="lc__track"><ol class="lc__steps"></ol></div>`,
    `      <div class="lc__detail" aria-live="polite"></div>`,
    `      <div class="lc__foot"><button class="btn btn--primary" data-lc-send>${s.send}</button><button class="btn btn--ghost" data-lc-demo>${s.demo}</button></div>`,
    `    </div>`,
  ]);
}

/** Failure simulation: run modes, failure scenarios and a console. */
function simulation(s) {
  let n = 0;
  return section(s, [
    ...head(s.head),
    `    <div class="sim reveal" data-sim>`,
    `      <div class="sim__modes" role="radiogroup" aria-label="${attr(s.modesLabel)}">`,
    ...s.modes.map((x, i) => `        <button role="radio" aria-checked="${sel(i)}" data-mode="${i}"><b>${x.title}</b><small>${x.text}</small></button>`),
    `        <i class="sim__line" aria-hidden="true"><em></em></i>`,
    `      </div>`,
    `      <div class="sim__body">`,
    `        <div class="sim__scen">`,
    `          <p class="sim__label">${s.scenariosLabel}</p>`,
    `          <div class="chips chips--select" data-scenarios>`,
    ...rows(s.scenarios).map((row) => `            ${row.map((x) => `<button aria-pressed="${sel(n++)}">${x}</button>`).join("")}`),
    `          </div>`,
    `          ${button({ label: s.run, icon: "play", block: true, attrs: { "data-sim-run": true } })}`,
    `        </div>`,
    `        <div class="console" aria-live="polite">`,
    `          <div class="console__bar"><span></span><span></span><span></span><em>${s.console.title}</em></div>`,
    `          <ol class="console__log" data-sim-log><li class="muted">${s.console.empty}</li></ol>`,
    `        </div>`,
    `      </div>`,
    `    </div>`,
  ]);
}

/** Worked use cases: tag, flow, packs and a replay button. */
function usecases(s) {
  return section(s, [
    ...head(s.head),
    `    <div class="grid grid--2">`,
    ...s.items.flatMap((x) => [
      `      <article class="ucase reveal">`,
      `        <p class="ucase__tag">${x.tag}</p>`,
      `        <h3>${x.title}</h3>`,
      `        <ol class="uflow">${x.flow.map(li).join("")}</ol>`,
      `        <dl class="ucase__packs">${x.packs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`,
      `        <div class="ucase__run" data-ucase-log hidden></div>`,
      `        ${button({ label: x.run, icon: "play", iconSize: "sm", attrs: { "data-ucase-run": x.key } })}`,
      `      </article>`,
    ]),
    `    </div>`,
  ]);
}

/** Sample apps in phone mockups (scenarios are played by the showcase script). */
function apps(s, c) {
  return section(s, [
    ...head(s.head),
    `    <div class="apps reveal" data-apps>`,
    ...s.items.flatMap((x) => [
      `      <article class="app" data-app="${attr(x.key)}">`,
      `        <header class="app__head"><span class="app__ico">${ico(x.icon)}</span><div><b>${x.title}</b><small>${x.text}</small></div></header>`,
      `        <div class="phone"><div class="phone__island"></div><div class="phone__display"><div class="phone__status"><span data-clock>${c.d(s.clock || "9:41")}</span><i></i></div><div class="phone__screen" data-screen></div></div></div>`,
      `        <div class="app__ctl">${button({ label: s.play, icon: "play", iconSize: "sm", size: "sm", attrs: { "data-app-play": true } })}${button({ label: s.reset, style: "ghost", size: "sm", attrs: { "data-app-reset": true } })}</div>`,
      `        <ol class="app__log" data-app-log aria-live="polite"></ol>`,
      `      </article>`,
    ]),
    `    </div>`,
    ...(s.note ? [`    <p class="apps__note reveal">${s.note}</p>`] : []),
  ]);
}

/** A header and a mount point filled by a client script (widgets gallery and similar). */
function mount(s) {
  return section(s, [...head(s.head), `    <div class="${attr(s.class)}"${attrs(s.attrs)}></div>`]);
}

/** Calendar: the embedded calendar, the engine card with code tabs, and links. */
function calendar(s) {
  const e = s.engine;
  return section(s, [
    ...head(s.head),
    `    <div class="reveal"${attrs(s.mount)}></div>`,
    `    <div class="engine reveal">`,
    `      <div class="engine__copy"><p class="eyebrow">${e.eyebrow}</p><h3>${e.title}</h3>`,
    `        <p>${e.text}</p>`,
    `        <ul class="engine__list">${e.channels.map(([k, v]) => `<li><b>${k}</b>${v}</li>`).join("")}</ul></div>`,
    `      <div class="tabs engine__code" data-tabs>`,
    `        <div class="tabs__list" role="tablist">${e.code.map((x, i) => `<button role="tab" aria-selected="${sel(i)}">${x.tab}</button>`).join("")}</div>`,
    ...e.code.map((x, i) => `        <div class="tabs__panel${i === 0 ? " is-active" : ""}" role="tabpanel"><pre dir="ltr"><code>${x.code}</code></pre></div>`),
    `      </div>`,
    `    </div>`,
    ...actions(s.actions, { defaults: { iconSize: "sm" } }),
  ]);
}

/** A header, one terminal-layer view and an optional demo-data note (notifications, workflows, routing, …). */
function stageSection(s) {
  return section(s, [...head(s.head), ...stage(s.view), ...note(s.note)]);
}

/** Agentic finance: the conditions, the agent request flow with its authority gate, and an add-on view. */
function agentic(s) {
  const a = s.agent;
  return section(s, [
    ...head(s.head, { start: true, extra: [
      `<ul class="checks-list">${s.checks.map(li).join("")}</ul>`,
      `<label class="toggle"><input type="checkbox" data-agent-toggle checked><span class="toggle__ui"></span><span>${s.toggle}</span></label>`,
      button({ label: s.run, icon: "play", attrs: { "data-agent-run": true } }),
      `<div class="agents">`,
      ...rows(s.agents).map((row) => `  ${row.map(span).join("")}`),
      `</div>`,
    ] }),
    `    <div class="agent reveal" data-agent>`,
    `      <div class="agent__req">${ico(a.icon || "agent")}<div><small>${a.from}</small><b>${a.request}</b></div></div>`,
    `      <ol class="agent__flow">`,
    `        ${a.flow.map((x) => (typeof x === "string" ? li(x) : `<li data-gate>${x.text}</li>`)).join("")}`,
    `      </ol>`,
    `      <div class="agent__result" aria-live="polite"></div>`,
    `    </div>`,
  ], { wrap: "wrap split split--rev", after: addon(s.addon) });
}

/** The control surface: KPIs, a chart, recent items and widgets (demo data, animated by the client script). */
function dashboard(s, c) {
  const k = (x) => {
    const num = x.suffix ? `<b><span data-count="${attr(x.count)}">${c.d(0)}</span>${x.suffix}</b>` : `<b data-count="${attr(x.count)}">${c.d(0)}</b>`;
    const tr = x.trend.dir ? `<i class="${attr(x.trend.dir)}">${x.trend.text}</i>` : `<i>${x.trend.text}</i>`;
    return `        <div class="kpi${x.warn ? " kpi--warn" : ""}"><small>${x.label}</small>${num}${tr}</div>`;
  };
  const w = (x) => {
    const viz = x.bars
      ? `<div class="bars">${x.bars.map((b) => `<i style="--v:${b.v}"${b.tone ? ` class="${attr(b.tone)}"` : ""}></i>`).join("")}</div>`
      : `<div class="ring${x.ring.gold ? " ring--gold" : ""}" style="--p:${x.ring.p}"><span>${c.L.percent(x.ring.p)}</span></div>`;
    return `        <div class="widget"><b>${x.title}</b>${viz}<p>${x.legend.map(span).join("")}</p></div>`;
  };
  const acc = "var(--c-accent)";   // a role, never the accent's value (colour canon)
  const ch = s.chart;
  return section(s, [
    ...head(s.head),
    `    <div class="dash reveal" data-dash>`,
    `      <div class="kpis">`,
    ...s.kpis.map(k),
    `      </div>`,
    `      <div class="dash__row">`,
    `        <div class="panel panel--chart">`,
    `          <div class="panel__head"><b>${ch.title}</b><div class="seg seg--sm" data-chart-tabs>${ch.series.map((x, i) => `<button aria-selected="${sel(i)}" data-series="${i}">${x}</button>`).join("")}</div></div>`,
    `          <svg class="chart" viewBox="0 0 640 220" preserveAspectRatio="none" data-chart role="img" aria-label="${attr(ch.label)}">`,
    `            <defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${acc}" stop-opacity=".16"/><stop offset="1" style="stop-color:${acc}" stop-opacity="0"/></linearGradient></defs>`,
    `            <g class="chart__grid"><line x1="0" y1="44" x2="640" y2="44"/><line x1="0" y1="99" x2="640" y2="99"/><line x1="0" y1="154" x2="640" y2="154"/></g>`,
    `            <path class="chart__area" fill="url(#gArea)"/><path class="chart__line"/><g class="chart__dots"></g>`,
    `          </svg>`,
    `          <div class="chart__x">${(ch.days || c.L.weekdays).map((d, i) => { const sh = ch.days ? null : c.L.weekdaysShort?.[i]; return sh && sh !== d ? `<span><span class="wd">${d}</span><span class="wd wd--s" aria-hidden="true">${sh}</span></span>` : span(d); }).join("")}</div>`,
    `        </div>`,
    `        <div class="panel">`,
    `          <div class="panel__head"><b>${s.recent.title}</b></div>`,
    `          <ul class="rows">`,
    ...s.recent.items.map((x) => `            <li><span>${x.text}</span>${status(x.status)}</li>`),
    `          </ul>`,
    `        </div>`,
    `      </div>`,
    `      <div class="widgets">`,
    ...s.widgets.map(w),
    `      </div>`,
    `    </div>`,
  ]);
}

/** The terminal teaser: an embedded tour, the verbs line, a note and links. */
function terminal(s, c) {
  return section(s, [
    ...head(s.head),
    `    <div data-terminal="teaser" data-tour="${attr(s.tour)}"></div>`,
    `    <p class="tx-verbs" data-verbs>${s.verbs.map((x) => `<b>${x}</b>`).join(`<i>${c.L.arrow.next}</i>`)}</p>`,
    ...note(s.note),
    ...actions(s.actions, { inline: true, reveal: false, defaults: { size: "lg" } }),
  ]);
}

/** Developers: code tabs and a developer-portal preview. */
function developers(s, c) {
  const p = s.portal;
  return section(s, [
    ...head(s.head),
    `    <div class="dev reveal">`,
    `      <div class="code" data-code>`,
    `        <div class="code__tabs" role="tablist">`,
    ...s.langs.map((x, i) => `          <button role="tab" aria-selected="${sel(i)}" data-lang="${attr(x.key)}">${x.label}</button>`),
    `          <button class="code__copy" data-copy aria-label="${attr(c.t("copyCode"))}">${ico("copy", true)}<span>${c.t("copy")}</span></button>`,
    `        </div>`,
    `        <pre dir="ltr"><code data-code-body></code></pre>`,
    `      </div>`,
    `      <div class="portal">`,
    `        <aside class="portal__side" dir="${c.L.dir}">`,
    `          <b>${p.title}</b>`,
    `          <nav class="portal__nav" data-portal-nav aria-label="${attr(p.navLabel)}">${p.views.map((x) => (x.key === p.active ? `<button class="on" data-pv-view="${attr(x.key)}" aria-current="page">${x.label}</button>` : `<button data-pv-view="${attr(x.key)}">${x.label}</button>`)).join("")}</nav>`,
    `        </aside>`,
    `        <div class="portal__main" data-pv-pane="${attr(p.active)}">`,
    `          <h4>${p.endpoint.title}</h4>`,
    `          <p class="ep" dir="ltr"><span>${p.endpoint.method}</span>${p.endpoint.path}</p>`,
    `          <div class="portal__meta">${p.meta.map(span).join("")}</div>`,
    `          <div class="portal__bar"><div class="seg seg--sm" role="tablist" data-portal-tabs>${p.tabs.map((x, i) => `<button role="tab" aria-selected="${sel(i)}" data-pv="${attr(x.key)}">${x.label}</button>`).join("")}</div>`,
    `          ${button({ label: p.try, icon: "play", iconSize: "sm", size: "sm", attrs: { "data-try": true } })}</div>`,
    `          <pre dir="ltr" class="portal__resp" data-try-out><code></code></pre>`,
    `        </div>`,
    `      </div>`,
    `    </div>`,
    ...actions(s.actions),
  ]);
}

/** The interactive API console (driven by the showcase script). */
function playground(s) {
  const opt = (o) => `<option value="${attr(o.value)}"${o.selected ? " selected" : ""}>${o.label}</option>`;
  const tabs = (list, key) => list.map((x, i) => `<button role="tab" aria-selected="${sel(i)}" data-${key}="${attr(x.key)}">${x.label}${x.count ? ` <b ${x.count}></b>` : ""}</button>`).join("");
  return section(s, [
    ...head(s.head),
    `    <div class="pg reveal" data-pg>`,
    `      <aside class="pg__side">`,
    `        <label class="pg__search">${ico("spark", true)}<input type="search" placeholder="${attr(s.search.placeholder)}" data-pg-search aria-label="${attr(s.search.label)}"></label>`,
    `        <nav class="pg__list" data-pg-list aria-label="${attr(s.listLabel)}"></nav>`,
    `        <select class="pg__pick" data-pg-pick aria-label="${attr(s.pickLabel)}"></select>`,
    `      </aside>`,
    `      <div class="pg__main">`,
    `        <div class="pg__top">`,
    `          <div class="pg__title"><h3 data-pg-title></h3><p data-pg-desc></p></div>`,
    `          <div class="pg__env">`,
    `            <label>${s.env.label}<select data-pg-env>${s.env.options.map(opt).join("")}</select></label>`,
    `            <label>${s.connector.label}<select data-pg-conn>${s.connector.options.map(opt).join("")}</select></label>`,
    `          </div>`,
    `        </div>`,
    `        <div class="pg__url" dir="ltr"><span class="m" data-pg-method>POST</span><code><span class="pg__base" data-pg-base></span><span data-pg-path></span></code>${button({ label: s.send, icon: "play", iconSize: "sm", size: "sm", attrs: { "data-pg-send": true } })}</div>`,
    `        <div class="pg__cols">`,
    `          <div class="pg__req">`,
    `            <div class="seg seg--sm" role="tablist" data-pg-rtabs>${tabs(s.request.tabs, "rt")}</div>`,
    ...s.request.tabs.map((x, i) => (x.key === "body"
      ? `            <div class="pg__pane" data-rp="body" hidden><div class="pg__bodybar"><span data-pg-valid></span><button class="link" data-pg-format>${s.request.format}</button><button class="link" data-pg-resetbody>${s.request.reset}</button></div><textarea dir="ltr" spellcheck="false" data-pg-body aria-label="${attr(s.request.bodyLabel)}"></textarea></div>`
      : `            <div class="pg__pane" data-rp="${attr(x.key)}"${i === 0 ? "" : " hidden"}></div>`)),
    `            <label class="pg__scn">${s.request.scenario}<select data-pg-scn></select></label>`,
    `          </div>`,
    `          <div class="pg__res">`,
    `            <ol class="pg__pipe" data-pg-pipe aria-label="${attr(s.response.pipeLabel)}"></ol>`,
    `            <div class="pg__status" data-pg-status><span class="pg__hint">${s.response.hint}</span></div>`,
    `            <div class="seg seg--sm" role="tablist" data-pg-otabs>${tabs(s.response.tabs, "ot")}</div>`,
    `            <div class="pg__out" data-op="body"><pre dir="ltr"><code data-pg-out></code></pre></div>`,
    `            <div class="pg__out" data-op="headers" hidden><pre dir="ltr"><code data-pg-hdr></code></pre></div>`,
    `            <div class="pg__out" data-op="events" hidden><ol class="pg__events" data-pg-events></ol></div>`,
    `            <div class="pg__out" data-op="code" hidden><div class="pg__langs" data-pg-langs>${s.response.langs.map((x, i) => `<button aria-pressed="${sel(i)}" data-cl="${attr(x.key)}">${x.label}</button>`).join("")}<button class="pg__copy" data-pg-copy>${ico("copy", true)}${s.response.copy}</button></div><pre dir="ltr"><code data-pg-code></code></pre></div>`,
    `          </div>`,
    `        </div>`,
    `        <div class="pg__hist"><b>${s.history.title}</b><ol data-pg-hist><li class="pg__hint">${s.history.empty}</li></ol></div>`,
    `      </div>`,
    `    </div>`,
    ...actions(s.actions, { defaults: { iconSize: "sm" } }),
  ]);
}

/** Architecture layers; each shows its note when selected. */
function architecture(s) {
  return section(s, [
    ...head(s.head),
    `    <div class="arch reveal" data-arch>`,
    ...s.layers.map((x) => `      <div class="arch__layer${x.highlight ? " arch__layer--gold" : ""}" tabindex="0" data-note="${attr(x.note)}"><b>${x.title}</b><div>${x.items.map(span).join("")}</div></div>`),
    `      <p class="arch__note" aria-live="polite">${s.hint}</p>`,
    `    </div>`,
  ]);
}

/** Ecosystem: the logo in the middle of a ring of participants. */
function ecosystem(s, c) {
  const icon = c.tokens.logo.icon;
  return section(s, [
    ...head(s.head, { start: true }),
    `    <div class="eco reveal" data-eco>`,
    `      <svg viewBox="0 0 440 440" class="eco__svg" aria-hidden="true"><g class="eco__lines"></g></svg>`,
    `      <div class="eco__center"><img width="${icon.width}" height="${icon.height}" src="${attr(icon.src)}" alt="${attr(c.site.name)}"></div>`,
    `      <ul class="eco__nodes">`,
    ...rows(s.nodes).map((row) => `        ${row.map(li).join("")}`),
    `      </ul>`,
    `    </div>`,
  ], { wrap: "wrap split" });
}

/** Connector marketplace: category filter, grid (client), adapter diagram and the provider registry. */
function marketplace(s) {
  const a = s.adapter, r = s.registry;
  let n = 0;
  return section(s, [
    ...head(s.head),
    `    <div class="chips chips--filter reveal" data-mk-filter role="toolbar" aria-label="${attr(s.filterLabel)}">`,
    ...rows(s.filters).map((row) => `      ${row.map((x) => `<button aria-pressed="${sel(n++)}" data-f="${attr(x.key)}">${x.label}</button>`).join("")}`),
    `    </div>`,
    `    <div class="grid grid--mk" data-mk></div>`,
    ``,
    `    <div class="adapter reveal">`,
    `      <div class="adapter__copy">`,
    `        <h3>${a.title}</h3>`,
    `        <p>${a.text}</p>`,
    `        <div class="seg" data-adapter-tabs>${a.providers.map((x, i) => `<button aria-selected="${sel(i)}" data-p="${i}">${x}</button>`).join("")}</div>`,
    `      </div>`,
    `      <div class="adapter__viz" data-adapter>`,
    `        <div class="ad-box ad-box--core">${a.core.label}<small dir="ltr">${a.core.code}</small></div>`,
    `        <div class="ad-pipe"><i></i></div>`,
    `        <div class="ad-box">${a.middle}</div>`,
    `        <div class="ad-pipe"><i></i></div>`,
    `        <div class="ad-box ad-box--prov" data-adapter-prov>${a.provider.label}<small dir="ltr">${a.provider.code}</small></div>`,
    `      </div>`,
    `    </div>`,
    ``,
    `    <div class="registry reveal">`,
    `      <div class="registry__head"><h3>${r.title}</h3><p>${r.text}</p></div>`,
    `      <div class="table-wrap"><table class="table">`,
    `        <thead><tr>${r.columns.map((x) => `<th>${x}</th>`).join("")}</tr></thead>`,
    `        <tbody>`,
    ...r.rows.map((row) => `          <tr>${row.map((x, i) => `<td data-l="${attr(r.columns[i])}">${typeof x === "string" ? x : status(x)}</td>`).join("")}</tr>`),
    `        </tbody>`,
    `      </table></div>`,
    `    </div>`,
  ]);
}

/** Governance: the chain of checks, the controls and an add-on view. */
function governance(s) {
  return section(s, [
    ...head(s.head),
    `    <ol class="gov reveal" data-gov>`,
    `      ${s.chain.map((x) => `<li><b>${x}</b></li>`).join("")}`,
    `    </ol>`,
    `    <div class="chips chips--center reveal">${s.controls.map(span).join("")}</div>`,
  ], { after: addon(s.addon) });
}

/** Comparison table: option, strength, limitation; the project's own row is highlighted. */
function compare(s) {
  const [c0, c1, c2] = s.columns;
  const cell = (label, x, icon) => `<td data-l="${attr(label)}"><span class="cmp__c"><svg class="ico ${icon === "check" ? "ico--ok" : "ico--x"}"><use href="#i-${icon}"/></svg>${x}</span></td>`;
  return section(s, [
    ...head(s.head),
    `    <div class="table-wrap reveal"><table class="cmp cmp--3">`,
    `      <thead><tr>${s.columns.map((x) => `<th>${x}</th>`).join("")}</tr></thead>`,
    `      <tbody>`,
    ...s.rows.map((r) => `        <tr${r.us ? ' class="us"' : ""}><th data-l="${attr(c0)}">${r.option}</th>${cell(c1, r.pro, "check")}${r.us ? `<td data-l="${attr(c2)}">${r.con}</td>` : cell(c2, r.con, "x")}</tr>`),
    `      </tbody>`,
    `    </table></div>`,
  ]);
}

/** A black call-to-action band. */
function band(s) {
  return [
    ...(s.comment ? [`<!-- ============ ${s.comment} ============ -->`] : []),
    `<section class="band"${s.id ? ` id="${attr(s.id)}"` : ""}>`,
    `  <div class="wrap band__in reveal">`,
    `    <h2>${s.title}</h2>`,
    `    <div class="actions">${s.actions.map((a) => button(a)).join("")}</div>`,
    `  </div>`,
    `</section>`,
  ];
}

/** Brand-guide teaser with the token swatches. */
function brand(s, c) {
  const roles = ["accent", "ink", "rail", "bg"];   // the swatches paint the roles, never copies of their values
  return section(s, [
    `    <div class="brand-teaser reveal">`,
    `      <div><p class="eyebrow"><span class="dot"></span>${s.eyebrow}</p>`,
    `        <h2>${s.title}</h2>`,
    `        <p>${s.text}</p></div>`,
    `      <div class="brand-teaser__sw" aria-hidden="true">${roles.map((x) => `<i style="--c:var(${roleVar(x)})"></i>`).join("")}</div>`,
    `      ${button(s.action, { size: "lg" })}`,
    `    </div>`,
  ]);
}

/** Onward links as cards. */
function explore(s) {
  return section(s, [
    ...head(s.head),
    `    <div class="explore reveal">`,
    ...s.items.map((x) => `      <a class="explore__c" href="${attr(x.href)}"><span class="explore__k">${x.kicker}</span><b>${x.title}</b><p>${x.text}</p><i>${x.cta}</i></a>`),
    `    </div>`,
  ]);
}

const skeletons = (n) => `<div class="lblog__sk"></div>`.repeat(n);

/** Latest posts (filled by the content client). */
function blog(s) {
  return section(s, [
    ...head(s.head),
    `    <div class="lblog" data-lblog aria-live="polite">${skeletons(3)}</div>`,
    ...actions(s.actions, { defaults: { iconSize: "sm" } }),
  ]);
}

/** Podcasts: the cover and the latest episodes (filled by the content client). */
function podcasts(s, c) {
  const cover = c.tokens.images.podcastCover;
  return section(s, [
    ...head(s.head),
    `    <div class="lpod reveal">`,
    `      <img class="lpod__cover" src="${attr(cover.src)}" width="${cover.width}" height="${cover.height}" alt="${attr(s.coverAlt)}" loading="lazy">`,
    `      <div class="lpod__list" data-lpod aria-live="polite">${skeletons(2)}</div>`,
    `    </div>`,
    ...actions(s.actions),
  ]);
}

/** Glossary: today's term (client) and the category chips with term counts. */
function glossary(s, c) {
  const chips = s.categories.map((x) => `<a class="chip2" href="${attr(s.href)}#${attr(x.key)}">${x.name} <small>${c.d(x.count)}</small></a>`).join("");
  return section(s, [
    ...head(s.head),
    `    <div class="lgloss reveal">`,
    `      <div class="lgloss__today" data-lgloss aria-live="polite">${skeletons(1)}</div>`,
    `      <nav class="chips2 lgloss__cats" aria-label="${attr(s.categoriesLabel)}"><!--glossary-cats-->${chips}<!--/glossary-cats--></nav>`,
    `    </div>`,
    ...actions(s.actions),
  ]);
}

/** Consent line with links to the privacy (and terms) modals. */
export function consent(c, both = false) {
  const l = (key) => `<button type="button" class="link" data-modal="${key}">${c.t(key)}</button>`;
  return c.t(both ? "consentBoth" : "consent", { privacy: l("privacy"), terms: l("terms") });
}

/** Events: the list (client), a subscribe form and a link. */
function events(s, c) {
  const f = s.subscribe;
  return section(s, [
    ...head(s.head),
    `    <div class="levents" data-levents aria-live="polite"></div>`,
    `    <section class="csub reveal" aria-labelledby="${attr(f.id)}"><div class="csub__copy"><h2 id="${attr(f.id)}">${f.title}</h2><p>${f.text}</p></div>`,
    `      <form class="cform" data-cform="${attr(f.form)}" novalidate>`,
    `        <label><span>${c.t("fields.name")}</span><input name="name" required maxlength="120" autocomplete="name"></label>`,
    `        <label><span>${c.t("fields.email")}</span><input name="email" type="email" required maxlength="200" autocomplete="email" dir="ltr"></label>`,
    `        <input name="website" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true">`,
    `        <label class="cform__ok"><input type="checkbox" name="consent" required><span>${consent(c)}</span></label>`,
    `        <button class="btn btn--primary" type="submit">${f.submit}</button>`,
    `      </form></section>`,
    ...actions(s.actions, { inline: true }),
  ]);
}

/** Frequently asked questions (the first one open). Also feeds the FAQPage JSON-LD. */
function faq(s) {
  return section(s, [
    `    <header class="sec-head reveal"><p class="eyebrow">${s.head.eyebrow}</p><h2>${s.head.title}</h2></header>`,
    `    <div class="faq">`,
    ...s.items.map((x, i) => `      <details class="reveal"${i === 0 ? " open" : ""}><summary>${x.q}</summary><p>${x.a}</p></details>`),
    `    </div>`,
  ], { wrap: "wrap wrap--narrow" });
}

/** The closing accent cover. */
function final(s) {
  return [
    ...(s.comment ? [`<!-- ============ ${s.comment} ============ -->`] : []),
    `<section class="final" id="${attr(s.id || "start")}">`,
    `  `,
    `  <div class="wrap final__in reveal">`,
    `    <p class="eyebrow">${s.eyebrow}</p>`,
    `    <h2>${s.title}</h2>`,
    `    <p>${s.text}</p>`,
    ...actions(s.actions, { reveal: false, inline: true, defaults: { size: "lg" } }),
    ...(s.micro ? [`    <p class="micro">${s.micro}</p>`] : []),
    `  </div>`,
    `</section>`,
  ];
}

export const SECTIONS = {
  hero, audience, cards, approach, roles, domains, stepper, packs, lifecycle, simulation, usecases, apps, mount,
  calendar, stage: stageSection, agentic, dashboard, terminal, developers, playground, architecture, ecosystem,
  marketplace, governance, compare, band, brand, explore, blog, podcasts, glossary, events, faq, final,
};

export { link, flat };
