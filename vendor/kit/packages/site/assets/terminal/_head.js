{{banner}}
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const faN = (n, d = 0) => KitFormat.formatNumber(n, "{{locale.code}}", { decimals: d, numerals: "{{locale.digits}}" });
  const fa = (v) => KitFormat.digits(v, "{{locale.digits}}");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const stamp = (withMs = true) => {
    const d = new Date();
    const t = d.toLocaleTimeString("en-GB", { hour12: false, timeZone: "{{tz}}" });
    return withMs ? `${t}.${String(d.getMilliseconds()).padStart(3, "0")}` : t;
  };
  const toast = (m) => (window.{{ns.global}}Notify ? window.{{ns.global}}Notify.show({ type: "success", title: m, timeout: 3200 }) : null);
  const RESTART = Symbol("restart");
  const STOP = Symbol("stop");

  /* ------------------------------------------------------------ players (demonstration only) */
  const PLAYERS = {
{{#each d.playerRows}}    {{#each .}}{{.key}}: { fa: "{{.name|dq}}", c: "{{.color|roleRef}}" }{{#unless @last}}, {{/unless}}{{/each}},
{{/each}}  };
  // Logo files in site{{d.logoDir}} (sources and licences: SOURCES.md there). Missing slugs show a lettered badge.
  const LOGO_FILES = {{d.logos|jsmap}};
  // the text colour derived for a player badge fill: var(--c-chart-2) → var(--c-on-chart-2) (a role the content names), else on-ink
  const onOf = (c) => String(c).replace(/^var\(--c-([\w-]+)\)$/, "var(--c-on-$1)").replace(/^(?!var\()[\s\S]*$/, "{{color.onInk}}");
  const logo = (slug, cls = "") => {
    const p = PLAYERS[slug];
    if (!p) return `<span class="lg lg--txt ${cls}" style="--c:{{color.ink}};--on-c:{{color.onInk}}" aria-hidden="true">${esc(String(slug).slice(0, 1))}</span>`;
    const f = LOGO_FILES[slug];
    return f
      ? `<span class="lg ${cls}"><img src="{{d.logoDir}}${f}" width="40" height="40" alt="" loading="lazy" decoding="async" data-slug="${slug}"></span>`
      : `<span class="lg lg--txt ${cls}" style="--c:${p.c};--on-c:${onOf(p.c)}" aria-hidden="true">${esc(p.fa.replace(/{{s._head.1}} /, "").slice(0, 1))}</span>`;
  };
  const nameOf = (slug) => PLAYERS[slug]?.fa || slug;
  const fixLogos = (root) => $$("img[data-slug]", root).forEach((img) => img.addEventListener("error", () => {
    const s = img.dataset.slug; const box = img.parentElement;
    box.className = `lg lg--txt ${box.className.replace(/\blg\b/, "")}`; box.style.setProperty("--c", PLAYERS[s]?.c || "{{color.ink}}");
    box.textContent = (PLAYERS[s]?.fa || s).replace(/{{s._head.1}} /, "").slice(0, 1);
  }, { once: true }));

  /* ------------------------------------------------------------ visibility-aware helpers */
  const seen = new WeakMap();
  const watch = (el) => {
    if (seen.has(el)) return;
    seen.set(el, false);
    new IntersectionObserver((es) => es.forEach((e) => seen.set(el, e.isIntersecting)), { threshold: 0.05 }).observe(el);
  };
  const onScreen = (el) => el.isConnected && seen.get(el) && !document.hidden;
  const every = (el, ms, fn) => {
    watch(el);
    const t = setInterval(() => { if (!el.isConnected) return clearInterval(t); if (onScreen(el)) fn(); }, ms);
    return t;
  };

  /* ------------------------------------------------------------ ghost cursor + stage */
  const ARROW = '<svg viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.7L4 20z" style="fill:{{color.surface}};stroke:{{color.ink}}" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  function makeStage(root) {
    root.setAttribute("data-ghost-root", "");
    watch(root);
    const g = document.createElement("div");
    g.className = "ghost"; g.innerHTML = ARROW; g.setAttribute("aria-hidden", "true");
    root.appendChild(g);
    let hold = 0, stopped = false, touched = false, kicked = false;
    const wakers = [];
    const flush = () => { if (onScreen(root)) wakers.splice(0).forEach((f) => f()); };
    setInterval(flush, 400);
    document.addEventListener("visibilitychange", flush);
    const human = (e) => { if (!e.isTrusted || e.target.closest?.(".txs__side,.txs__top,.pal,.txs__tour")) return; hold = Date.now() + 15000; touched = true; g.classList.remove("on"); };
    root.addEventListener("pointerdown", human, true);
    root.addEventListener("keydown", human, true);
    const S = {
      root,
      get touched() { return touched; }, clearTouched() { touched = false; },
      stop() { stopped = true; },
      kick() { kicked = true; wakers.splice(0).forEach((f) => f()); },
      async sleep(ms) {
        if (reduce) return;
        await wait(ms);
        for (;;) {
          if (stopped) throw STOP;
          if (kicked) { kicked = false; g.classList.remove("on"); throw RESTART; }
          if (!onScreen(root)) { g.classList.remove("on"); await new Promise((r) => wakers.push(r)); continue; }
          if (Date.now() < hold) { g.classList.remove("on"); while (Date.now() < hold) await wait(Math.min(1000, hold - Date.now())); throw RESTART; }
          return;
        }
      },
      async to(el, dx = 0.55, dy = 0.6) {
        if (reduce || !el || !el.isConnected) return;
        const r = root.getBoundingClientRect(), t = el.getBoundingClientRect();
        if (!t.width) return;
        g.classList.add("on");
        g.style.transform = `translate(${t.left - r.left + t.width * dx}px,${t.top - r.top + t.height * dy}px)`;
        await S.sleep(750);
      },
      async click(el) {
        if (reduce || !el) return;
        await S.to(el);
        g.classList.remove("tap"); void g.offsetWidth; g.classList.add("tap");
        el.classList.add("is-pressed"); await wait(170); el.classList.remove("is-pressed");
        await S.sleep(140);
      },
      hide() { g.classList.remove("on"); },
    };
    return S;
  }

  /* a view instance: DOM + actions; actions abort when the view is reset or replaced */
  function mount(def, el, extra = {}) {
    const V = { el, ep: 0, busy: false, ...extra };
    V.wait = async (ms) => { const e = V.ep; await wait(ms); if (e !== V.ep) throw RESTART; };
    V.act = (fn) => async (...a) => {
      if (V.busy) return; V.busy = true;
      try { await fn(...a); } catch (e) { if (e !== RESTART) console.error(e); } finally { V.busy = false; }
    };
    V.reset = () => { V.ep++; V.busy = false; el.innerHTML = ""; def.render(V); fixLogos(el); };
    V.reset();
    return V;
  }
  async function loop(S, V, def) {
    if (reduce) { try { await def.play(V, S); } catch { /* reduced motion: a demo that cannot play is skipped */ } return; }
    for (;;) {
      try { V.reset(); await S.sleep(500); await def.play(V, S); await S.sleep(2200); }
      catch (e) { if (e === STOP) return; if (e !== RESTART) { console.error(e); return; } }
    }
  }

  /* ------------------------------------------------------------ network graph (HTML nodes over SVG edges) */
  function graph(box, { w = 1000, h = 520, nodes, edges, tip }) {
    box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><g class="es"></g><g class="ps"></g></svg>`;
    const es = $(".es", box), ps = $(".ps", box), NS = "http://www.w3.org/2000/svg";
    const nodeEl = {}, edgeEl = {};
    for (const n of nodes) {
      const d = document.createElement("div");
      d.className = `nn ${n.cls || ""}`; d.dataset.id = n.id;
      d.style.left = `${(n.x / w) * 100}%`; d.style.top = `${(n.y / h) * 100}%`;
      // the hub (centre node) with the brand icon shows the icon alone, centred; its name is its accessible label
      const mark = /\bnn--hub\b/.test(n.cls || "") && n.icon;
      d.innerHTML = mark ? `${n.icon}<span class="nn__sr">${esc(n.label)}</span>` : `${n.logo ? logo(n.logo) : n.icon || ""}<span>${esc(n.label)}</span>`;
      if (mark) { d.classList.add("nn--mark"); d.title = n.label; }
      if (tip && n.tip) { d.tabIndex = 0; d.setAttribute("role", "button"); d.setAttribute("aria-label", n.label); }
      box.appendChild(d); nodeEl[n.id] = d;
    }
    const at = (id) => nodes.find((n) => n.id === id);
    for (const [a, b] of edges) {
      const A = at(a), B = at(b), mx = (A.x + B.x) / 2;
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", `M${A.x} ${A.y} C${mx} ${A.y} ${mx} ${B.y} ${B.x} ${B.y}`);
      p.setAttribute("class", "e"); es.appendChild(p); edgeEl[`${a}>${b}`] = p;
    }
    let tipEl = null;
    const showTip = (id) => {
      hideTip(); const n = at(id); if (!n?.tip) return;
      const t = n.tip(); tipEl = document.createElement("div"); tipEl.className = "ntip";
      tipEl.innerHTML = t; box.appendChild(tipEl);
      const x = (n.x / w) * box.clientWidth, y = (n.y / h) * box.clientHeight;
      tipEl.style.top = `${Math.max(0, y - tipEl.offsetHeight - 22)}px`;
      tipEl.style.left = `${Math.min(box.clientWidth - tipEl.offsetWidth, Math.max(0, x - tipEl.offsetWidth / 2))}px`;
      nodeEl[id].classList.add("hl");
    };
    const hideTip = () => { tipEl?.remove(); tipEl = null; $$(".nn.hl", box).forEach((n) => n.classList.remove("hl")); };
    if (tip) for (const n of nodes) if (n.tip) {
      const d = nodeEl[n.id];
      d.addEventListener("mouseenter", () => showTip(n.id)); d.addEventListener("focus", () => showTip(n.id));
      d.addEventListener("mouseleave", hideTip); d.addEventListener("blur", hideTip);
    }
    const flights = [];
    let raf = 0;
    const frame = (t) => {
      raf = 0;
      for (let i = flights.length - 1; i >= 0; i--) {
        const f = flights[i]; const k = Math.max(0, Math.min(1, (t - f.t0) / f.dur));
        const seg = f.path[Math.min(f.path.length - 1, Math.floor(k * f.path.length))];
        const local = k * f.path.length - Math.floor(k * f.path.length);
        const L = seg.getTotalLength(), pt = seg.getPointAtLength((f.rev ? 1 - (k >= 1 ? 1 : local) : (k >= 1 ? 1 : local)) * L);
        f.c.setAttribute("cx", pt.x); f.c.setAttribute("cy", pt.y);
        if (k >= 1) { f.c.remove(); flights.splice(i, 1); f.done?.(); }
      }
      if (flights.length) raf = requestAnimationFrame(frame);
    };
    const G = {
      box, nodeEl, edgeEl,
      fly(keys, { dur = 1400, rev = false } = {}) {
        if (reduce) return Promise.resolve();
        const path = keys.map((k) => edgeEl[k]).filter(Boolean);
        if (!path.length) return Promise.resolve();
        return new Promise((res) => {
          const c = document.createElementNS(NS, "circle"); c.setAttribute("r", 5); c.setAttribute("class", "pk"); ps.appendChild(c);
          flights.push({ c, path: rev ? [...path].reverse() : path, rev, t0: performance.now(), dur, done: res });
          if (!raf) raf = requestAnimationFrame(frame);
        });
      },
      edge(k, cls) { const e = edgeEl[k]; if (e) e.setAttribute("class", `e ${cls || ""}`); },
      showTip, hideTip,
    };
    return G;
  }

  /* ------------------------------------------------------------ shared snippets */
  const LIVE_EVENTS = [
{{#each s._head.events}}    {{#each .}}["{{.0}}", "{{.1}}", "{{.2|dq}}"]{{#unless @last}}, {{/unless}}{{/each}},
{{/each}}  ];
  const feedItem = (ev, cls, note) => `<li><span class="mono">${stamp(false)}</span><span class="ev ${cls}">${esc(ev)}</span><small>${esc(note)}</small></li>`;
  const pushFeed = (ul, html, max = 6) => { ul.insertAdjacentHTML("afterbegin", html); while (ul.children.length > max) ul.lastElementChild.remove(); };
  const setCls = (el, cls) => { el.classList.remove("ok", "now", "run", "err", "warn", "off", "on"); if (cls) el.classList.add(...cls.split(" ")); };

  /* ================================================================ VIEWS */
  const VIEWS = {};

