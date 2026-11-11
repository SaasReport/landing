/* @saasreport/workbench: the browser runtime's interface (see core.js for the pure parts). Reads the definition the page
   embeds (<script type="application/json" id="wb-data">), shows the command line, the panes and the dialogs, and keeps
   the layout and the watchlist in localStorage (every access in try/catch; the page works without it). All text is set
   with textContent: no HTML built from data, no eval, no inline handlers (CSP script-src 'self'). A pane that fails
   shows its own error and never stops another. */
const WB = KitWorkbench;
function boot() {
  const root = document.querySelector("[data-workbench]"); if (!root) return;
  const dataEl = document.getElementById("wb-data"); if (!dataEl) return;
  let D; try { D = JSON.parse(dataEl.textContent); } catch { return; /* no data island on this page: the workbench does not start */ }
  const def = D.def, S = D.strings, L = def.locale;
  const validator = createValidator([D.schemas.envelope]);
  const NS = def.id;
  const nf = new Intl.NumberFormat(L.intl, { maximumFractionDigits: 4 });
  const num = (v, dec) => (typeof v === "number" ? new Intl.NumberFormat(L.intl, { minimumFractionDigits: dec ?? 0, maximumFractionDigits: dec ?? 4 }).format(v) : String(v));
  // a date such as 2026-10-07 in Persian digits inside right-to-left text is read in the wrong order unless it is isolated left to right
  const LRI = String.fromCharCode(0x2066), PDI = String.fromCharCode(0x2069);
  const dg = (s) => WB.toDigits(s, L.digits).replace(/[0-9\u06f0-\u06f9\u0660-\u0669]{4}-[0-9\u06f0-\u06f9\u0660-\u0669]{2}-[0-9\u06f0-\u06f9\u0660-\u0669]{2}/g, (m) => LRI + m + PDI);
  const t = (k, vars = {}) => { let s = k.split(".").reduce((o, p) => (o == null ? o : o[p]), S); if (s == null) s = k; return String(s).replace(/\{(\w+)\}/g, (m, n) => (n in vars ? vars[n] : m)); };
  const kidsOf = (list) => list.flat().filter((c) => c != null && c !== false);
  const put = (n, ...kids) => n.replaceChildren(...kidsOf(kids));   // replaceChildren(null) would write the word "null"
  const $ = (s, el = root) => el.querySelector(s), $$ = (s, el = root) => [...el.querySelectorAll(s)];
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (v == null || v === false) continue; if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v); }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const store = {
    get(area, k) { try { return JSON.parse(window[area].getItem(`${NS}.${k}`)); } catch { return null; /* storage unavailable or the value not JSON: nothing stored (null) */ } },
    set(area, k, v) { try { window[area].setItem(`${NS}.${k}`, JSON.stringify(v)); return true; } catch { return false; /* storage unavailable or full: false says it was not stored */ } },
    del(area, k) { try { window[area].removeItem(`${NS}.${k}`); } catch { /* storage unavailable: nothing was stored to remove */ } },
  };
  const paneOf = (id) => def.panes.find((p) => p.id === id);
  const srcOf = (id) => def.sources.find((s) => s.id === id);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const status = $("[data-wb-status]");
  const announce = (m) => { if (status) status.textContent = m; };

  // ---- state ----
  let layout = store.get("localStorage", "layout.v1");
  if (!WB.layoutValid(layout, def.panes.map((p) => p.id))) layout = WB.layoutFrom(def, def.defaultLayout);
  let watch = store.get("localStorage", "watch.v1"); if (!WB.watchValid(watch)) watch = { v: 1, items: [] };
  const byo = [];    // the visitor's own sources of this page view: { id, envelope, refetch? }
  const keys = new Map();   // endpoint keys: memory only
  const saveLayout = () => store.set("localStorage", "layout.v1", layout);
  const saveWatch = () => store.set("localStorage", "watch.v1", watch);
  const instances = new Map();   // tab key → pane instance

  // ---- envelopes: one per load, from the pane's active source ----
  const todayParts = () => { const l = WB.localStamp(Date.now()); const [gy, gm, gd] = l.gregorian.slice(0, 10).split("-").map(Number); const j = WB.gregorianToJalali(gy, gm, gd); return { jy: j.jy, jm: j.jm, jd: j.jd, iso: l.gregorian.slice(0, 10) }; };
  const resolveDefaults = (pane, args) => {
    const td = todayParts(), out = { ...args };
    for (const [k, v] of Object.entries((pane.params || {}).defaults || {})) if (out[k] === undefined) out[k] = v === "$jy" ? td.jy : v === "$jm" ? td.jm : v === "$jd" ? td.jd : v === "$today" ? td.iso : v;
    return out;
  };
  const pointer = (obj, p) => { let v = obj; for (const k of String(p || "").split("/").slice(1)) v = v == null ? v : v[k.replace(/~1/g, "/").replace(/~0/g, "~")]; return v; };
  const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
  const envFor = (src, o) => WB.makeEnvelope(src, { lang: L.code, tz: L.tz, ...o });
  const scriptsLoaded = new Map();
  const loadScript = (href) => scriptsLoaded.get(href) || (scriptsLoaded.set(href, new Promise((res, rej) => { const s = document.createElement("script"); s.setAttribute("data-cfasync", "false"); s.src = href; s.onload = res; s.onerror = () => rej(fail("script", { href })); document.head.append(s); })), scriptsLoaded.get(href));
  const engines = new Map();
  async function engineOf(src) {
    if (engines.has(src.id)) return engines.get(src.id);
    const a = src.adapter; for (const h of a.scripts) await loadScript(h);
    const f = window[a.factory]; if (typeof f !== "function") throw fail("engine");
    const key = a.storageKey || `${NS}.sandbox.v1`;
    const e = f({ storage: { load() { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; /* storage unavailable or the value not JSON: nothing stored (null) */ } }, save(v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable or full: the state lives in memory only */ } } } });
    engines.set(src.id, e); return e;
  }
  async function loadEnvelope(pane, srcId, args, force) {
    if (srcId === "byo") { const b = byo.find((x) => x.id === args.id) || byo[byo.length - 1]; if (!b) throw fail("nobyo"); if (force && b.refetch) await refetchEntry(b); return b.envelope; }
    const src = srcOf(srcId); if (!src) throw fail("nosource");
    if (!src.enabled || src.adapter.type === "disabled") throw fail("disabled", { reason: src.disabledReason });
    const a = src.adapter, now = Date.now();
    if (a.type === "seeded-series") return envFor(src, { now, asOf: `${def.asOf}T00:00:00.000Z`, basis: "seed", seed: a.seed, data: WB.seededSeries(a, def.asOf) });
    if (a.type === "local") return envFor(src, { now, basis: "fetch-time", data: {} });
    if (a.type === "lab-engine") { await engineOf(src); return envFor(src, { now, basis: "fetch-time", data: {} }); }
    if (a.type === "http-json") {
      const q = new URLSearchParams(); const merged = resolveDefaults(pane, args);
      for (const [k, v] of Object.entries(a.query || {})) { const val = typeof v === "string" && v.startsWith("$") ? merged[v.slice(1)] : v; if (val !== undefined && val !== "") q.set(k, String(val)); }
      const url = a.url + (q.toString() ? (a.url.includes("?") ? "&" : "?") + q : "");
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), def.byo.timeoutMs);
      let res, text;
      try { res = await fetch(url, { credentials: a.url.startsWith("/") ? "same-origin" : "omit", signal: ctl.signal, headers: { accept: "application/json" } }); if (!res.ok) throw fail("http", { status: res.status }); text = await WB.readCapped(res, 3 * 1048576); }
      catch (e) { throw e.code ? e : e.name === "AbortError" ? fail("timeout") : fail("network"); } finally { clearTimeout(timer); }
      let json; try { json = JSON.parse(text); } catch { throw fail("parse"); }
      let rows = a.rows ? WB.rowsAt(json, a.rows) : WB.findRows(json);   // a null at the pointer is the declared empty state: [], not an error
      if (a.keyed && isObj(rows)) rows = Object.entries(rows).map(([key, v]) => (isObj(v) ? { key, ...v } : { key, value: v }));   // an object of objects becomes rows
      if (!Array.isArray(rows)) throw fail("rows");
      if (src.contract) { const bad = WB.checkRows(validator, rows, src.contract, 3); if (bad.length) throw fail("contract", { detail: bad.join(" | ") }); }
      const stamp = a.stamp ? pointer(json, a.stamp) : null, st = stamp && Date.parse(stamp);
      const hdr = res.headers.get("last-modified") || res.headers.get("date"), hd = hdr && Date.parse(hdr);
      return envFor(src, { now, asOf: Number.isFinite(st) ? new Date(st).toISOString() : Number.isFinite(hd) ? new Date(hd).toISOString() : undefined, basis: Number.isFinite(st) ? "source" : "fetch-time", data: { rows, root: json } });
    }
    throw fail("adapter");
  }

  // ---- badges and the source line ----
  const badgeEl = (src) => { const b = WB.badgeOf(src); return el("span", { class: "wb-badge", "data-badge": b }, el("b", { dir: "ltr", text: WB.BADGE_LATIN[b] }), el("span", { text: t(`badge.${b}`) })); };
  
  const metaEl = (env, srcName) => el("dl", { class: "wb-meta" },
    el("div", {}, el("dt", { text: t("source") }), el("dd", { text: srcName })),
    el("div", {}, el("dt", { text: t("asOf") }), el("dd", {}, el("time", { datetime: env.asOf, text: dg(env.asOfLocal.jalali) }), " ", el("span", {}, dg(env.asOfLocal.gregorian.slice(0, 10)), " ", el("bdi", { dir: "ltr", text: env.asOfLocal.tz })))),
    el("div", {}, el("dt", { text: t("licence") }), el("dd", { text: `${env.licence.line} (${t(`redistribution.${env.licence.redistribution}`)})` })),
    el("div", {}, el("dt", { text: t("freshness") }), el("dd", {}, el("span", { class: "wb-chip", "data-fresh": env.freshness.status, text: t(`fresh.${env.freshness.status}`) }), env.units && env.units.currency && env.units.currency !== "none" ? el("span", { class: "wb-chip", text: env.units.currency }) : null)));
  const nameOf = (s) => (typeof s.name === "string" ? s.name : s.name[L.code] || Object.values(s.name)[0]);

  // ---- pane instances ----
  const errText = (e) => {
    const k = e && e.code ? `err.${e.code}` : "err.unknown";
    let m = t(k, { status: e && e.status ? dg(e.status) : "" }); if (m === k) m = t("err.unknown");
    return m;
  };
  function mountPane(tab, panel) {
    if (instances.has(tab.k)) return;
    const pane = paneOf(tab.pane); const inst = { tab, pane, panel, args: { ...tab.args }, srcId: pane.source, seq: 0 };
    instances.set(tab.k, inst);
    const head = el("header", { class: "wb-pane__head" }), body = el("div", { class: "wb-pane__body", "aria-busy": "true" });
    inst.head = head; inst.body = body;
    panel.replaceChildren(head, body);
    inst.refresh = () => refresh(inst);
    refresh(inst);
  }
  async function refresh(inst) {
    const { pane, body, head } = inst, my = ++inst.seq;
    body.setAttribute("aria-busy", "true");
    const active = inst.srcId === "byo" ? { id: "byo", name: t("byo.title"), kind: "customer-dataset" } : srcOf(inst.srcId);
    put(head, el("h2", { class: "wb-pane__title", text: pane.title }), badgeEl(active),
      pane.alternates && pane.alternates.length ? sourcePicker(inst) : null,
      el("span", { class: "wb-pane__tools" }, el("button", { type: "button", class: "wb-btn wb-btn--quiet", "data-act": "refresh", text: t("refresh"), onclick: () => { inst.force = true; refresh(inst); } })));
    put(body, el("p", { class: "wb-load", text: t("loading") }));
    let env;
    try {
      env = await loadEnvelope(pane, inst.srcId, resolveDefaults(pane, inst.args), inst.force); inst.force = false;
      const expect = inst.srcId === "byo" ? env.source.id : inst.srcId;
      const bad = WB.acceptEnvelope(validator, env, expect); if (bad.length) throw fail("envelope", { detail: bad.join(" | ") });
    } catch (e) {
      if (my !== inst.seq) return;
      showError(inst, e, active); return;
    }
    if (my !== inst.seq) return;
    inst.env = env;
    try {
      if (inst.srcId === "byo") put(head, el("h2", { class: "wb-pane__title", text: pane.title }), badgeEl(env.source), el("span", { class: "wb-pane__tools" }, el("button", { type: "button", class: "wb-btn wb-btn--quiet", text: t("refresh"), onclick: () => refresh(inst) })));
      const src = inst.srcId === "byo" ? env.source : srcOf(inst.srcId);
      const view = el("div", { class: "wb-view" });
      view.append(metaEl(env, nameOf(src)));
      const content = el("div", { class: "wb-content" }); view.append(content);
      put(body, view);
      RENDER[pane.kind](inst, env, content, view);
      body.removeAttribute("aria-busy");
      announce(t("loaded", { pane: pane.title }));
    } catch (e) { if (my === inst.seq) showError(inst, e, active); }
  }
  function showError(inst, e, src) {
    const { body } = inst; body.removeAttribute("aria-busy");
    if (e && e.code === "nobyo") { put(body, byoEmpty(inst)); return; }
    if (e && e.code === "locked") { put(body, unlockForm(inst, e.entry)); return; }
    const disabled = e && e.code === "disabled";
    const box = el("div", { class: "wb-err", role: disabled ? "status" : "alert", "data-err": e && e.code || "unknown" },
      el("strong", { text: disabled ? t("disabled") : t("failed") }),
      el("p", { text: disabled ? (e.reason || "") : errText(e) }),
      e && e.detail ? el("p", { class: "wb-err__detail", dir: "ltr", text: e.detail }) : null,
      src && src.id !== "byo" ? el("p", { class: "wb-err__src", text: `${t("source")}: ${nameOf(src)}` }) : null,
      disabled ? null : el("button", { type: "button", class: "wb-btn", text: t("retry"), onclick: () => refresh(inst) }));
    put(body, box); announce(t("failedPane", { pane: inst.pane.title }));
  }
  function sourcePicker(inst) {
    const ids = [inst.pane.source, ...inst.pane.alternates];
    const sel = el("select", { class: "wb-select", "aria-label": t("switchSource") }, ids.map((id) => { const s = srcOf(id); return el("option", { value: id, selected: id === inst.srcId, text: `${nameOf(s)}${s.enabled ? "" : ` (${t("disabledShort")})`}` }); }));
    sel.addEventListener("change", () => { inst.srcId = sel.value; refresh(inst); });
    return sel;
  }

  // ---- pane kinds ----
  const RENDER = {};
  const linkOk = (h) => typeof h === "string" && ((h.startsWith("/") && !h.startsWith("//")) || h.startsWith("https://"));
  const get = (r, k) => (k in r ? r[k] : String(k).split(".").reduce((o, p) => (o == null ? o : o[p]), r));
  const cellText = (v, c) => (v == null ? "" : typeof v === "boolean" ? t(v ? "yes" : "no") : typeof v === "number" ? num(v) : typeof v === "string" ? dg(v) : Array.isArray(v) ? v.map((x) => (isObj(x) ? Object.values(x).join(" ") : x)).join("، ") : isObj(v) ? JSON.stringify(v) : String(v));
  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  function inferColumns(rows) { const keys = []; for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k); return keys.slice(0, 10).map((key) => ({ key, label: key })); }
  RENDER.table = (inst, env, box) => {
    const rows = env.data.rows || [], cols = (inst.pane.columns && inst.pane.columns.length ? inst.pane.columns : inferColumns(rows));
    if (inst.srcId === "byo") box.before(byoToolbar(inst));
    if (!rows.length) { box.append(el("p", { class: "wb-empty", text: inst.pane.empty || t("noRows") })); return; }
    let q = "", sortKey = null, dir = 1, shown = 100;
    const input = el("input", { type: "search", class: "wb-input", "aria-label": t("filter"), placeholder: t("filter") });
    const info = el("p", { class: "wb-note", "aria-live": "polite" }), tbl = el("table", { class: "wb-table" }), wrap = el("div", { class: "wb-scroll", tabindex: "0", role: "region", "aria-label": inst.pane.title });
    const draw = () => {
      let list = rows.filter((r) => !q || cols.some((c) => WB.fold(cellText(get(r, c.key), c)).includes(q)));
      if (sortKey) list = [...list].sort((a, b) => { const x = get(a, sortKey), y = get(b, sortKey); return (typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), L.intl)) * dir; });
      const th = el("tr", {}, cols.map((c) => el("th", { scope: "col", "aria-sort": sortKey === c.key ? (dir > 0 ? "ascending" : "descending") : "none" }, el("button", { type: "button", class: "wb-sort", text: c.label || c.key, onclick: () => { if (sortKey === c.key) dir = -dir; else { sortKey = c.key; dir = 1; } draw(); } }))));
      const trs = list.slice(0, shown).map((r) => el("tr", {}, cols.map((c) => { const v = get(r, c.key); const href = c.type === "link" && c.href ? get(r, c.href) : null; return el("td", { "data-num": typeof v === "number" ? "1" : null }, href && linkOk(href) ? el("a", { href, text: cellText(v, c) || href, rel: "noopener" }) : cellText(v, c)); })));
      put(tbl, el("thead", {}, th), el("tbody", {}, trs));
      info.textContent = list.length > shown ? t("moreRows", { shown: dg(shown), total: dg(list.length) }) : t("rowCount", { n: dg(list.length) });
    };
    input.addEventListener("input", () => { q = WB.fold(input.value); shown = 100; draw(); });
    wrap.append(tbl); box.append(input, wrap, info); draw();
    if (rows.length > shown) box.append(el("button", { type: "button", class: "wb-btn wb-btn--quiet", text: t("showMore"), onclick: () => { shown += 200; draw(); } }));
  };

  RENDER.series = (inst, env, box) => {
    const d = env.data, args = inst.args; let id = args.series && d.series.some((s) => s.id === args.series) ? args.series : d.series[0].id, range = Number(args.days) || 90, toman = false;
    const out = el("div", {}); const chips = el("div", { class: "wb-chips", role: "group", "aria-label": t("series.pick") });
    const draw = () => {
      const s = d.series.find((x) => x.id === id), win = WB.sliceByDays(d.dates, s.values, range), whole = win.dates.length < 2, vals = whole ? s.values : win.values, dates = whole ? d.dates : win.dates, f = toman ? 0.1 : 1, dec = toman ? Math.max(0, s.decimals - 1) : s.decimals;
      const lo = Math.min(...vals), hi = Math.max(...vals), W = 640, H = 200, P = 8, x = (i) => P + (i * (W - 2 * P)) / Math.max(1, vals.length - 1), y = (v) => H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P);
      const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
      const NS_SVG = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS_SVG, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "wb-chart"); svg.setAttribute("role", "img");
      const last = vals[vals.length - 1] * f, first = vals[0] * f;
      svg.setAttribute("aria-label", t("series.aria", { name: s.label, from: dg(dates[0]), to: dg(dates[dates.length - 1]), first: num(first, dec), last: num(last, dec) }));
      const area = document.createElementNS(NS_SVG, "path"); area.setAttribute("d", `${line}L${x(vals.length - 1).toFixed(1)} ${H - P}L${P} ${H - P}Z`); area.setAttribute("class", "wb-chart__area");
      const ln = document.createElementNS(NS_SVG, "path"); ln.setAttribute("d", line); ln.setAttribute("class", "wb-chart__line");
      const dot = document.createElementNS(NS_SVG, "circle"); dot.setAttribute("cx", x(vals.length - 1)); dot.setAttribute("cy", y(vals[vals.length - 1])); dot.setAttribute("r", "4"); dot.setAttribute("class", "wb-chart__dot");
      svg.append(area, ln, dot);
      const pct = ((vals[vals.length - 1] - vals[0]) / vals[0]) * 100;
      const unit = toman ? "IRT" : s.unit || "";
      const stats = el("dl", { class: "wb-stats" },
        el("div", {}, el("dt", { text: t("series.last") }), el("dd", { text: `${num(last, dec)} ${unit}`.trim() })),
        el("div", {}, el("dt", { text: t("series.change") }), el("dd", { class: pct >= 0 ? "wb-up" : "wb-down", text: `${pct >= 0 ? "+" : ""}${num(pct, 1)}٪`, dir: "ltr" })),
        el("div", {}, el("dt", { text: t("series.min") }), el("dd", { text: num(lo * f, dec) })),
        el("div", {}, el("dt", { text: t("series.max") }), el("dd", { text: num(hi * f, dec) })));
      const axis = el("div", { class: "wb-axis" }, el("span", { text: dg(WB.jalaliFor(...dates[0].split("-").map(Number))) }), el("span", { text: dg(WB.jalaliFor(...dates[dates.length - 1].split("-").map(Number))) }));
      const ref = `${env.source.id}:${s.id}`, inList = watch.items.some((i) => i.ref === ref);
      const wbtn = el("button", { type: "button", class: "wb-btn wb-btn--quiet", "aria-pressed": String(inList), text: inList ? t("watch.remove") : t("watch.add"), onclick: () => toggleWatch(ref, wbtn) });
      const toolbar = el("div", { class: "wb-bar2" }, wbtn,
        env.units && env.units.currency === "IRR" ? el("button", { type: "button", class: "wb-btn wb-btn--quiet", "aria-pressed": String(toman), text: toman ? t("series.showRial") : t("series.showToman"), onclick: () => { toman = !toman; draw(); } }) : null,
        ...WB.rangesFor(d.dates).map((n) => el("button", { type: "button", class: "wb-chip wb-chip--btn", "aria-pressed": String(range === n), text: t("series.days", { n: dg(n) }), onclick: () => { range = n; draw(); } })));
      put(out, el("p", { class: "wb-series__name", text: s.label }), svg, axis, stats, toolbar,
        el("p", { class: "wb-note", text: toman ? t("series.tomanNote") : "" }));
      chips.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id)));
    };
    for (const s of d.series) chips.append(el("button", { type: "button", class: "wb-chip wb-chip--btn", "data-id": s.id, text: s.label, onclick: () => { id = s.id; inst.args.series = id; draw(); } }));
    box.append(chips, out); draw();
  };

  RENDER.calendar = (inst, env, box) => {
    const p = inst.pane.params || {}, f = p.fields || {}, rows = env.data.rows, a = resolveDefaults(inst.pane, inst.args), y = Number(a.year), m = Number(a.month);
    const wd = S.weekdays, grid = el("div", { class: "wb-cal", role: "grid", "aria-label": inst.pane.title }), detail = el("p", { class: "wb-cal__detail", "aria-live": "polite" });
    grid.append(...wd.map((w) => el("div", { class: "wb-cal__wd", role: "columnheader", text: w })));
    if (!rows.length) { box.append(el("p", { class: "wb-empty", text: inst.pane.empty || t("noRows") })); return; }
    const off = WB.weekdayIndex(rows[0][f.date || "iso"]), td = todayParts().iso;
    for (let i = 0; i < off; i++) grid.append(el("div", { class: "wb-cal__pad", role: "gridcell", "aria-hidden": "true" }));
    for (const r of rows) {
      const iso = r[f.date || "iso"], jd = Number(String(r[f.jalali || "jalali"]).split("/")[2]);
      const kind = r[f.holiday || "holiday"] ? "holiday" : r[f.weekend || "weekend"] ? "weekend" : "work";
      const label = (p.detail || []).map((k) => r[k]).filter(Boolean).join(" · ");
      const b = el("button", { type: "button", class: "wb-cal__day", "data-kind": kind, "aria-current": iso === td ? "date" : null, "aria-label": `${label} — ${t(`cal.${kind}`)}`, onclick: () => { detail.textContent = `${label} — ${t(`cal.${kind}`)}${(r[f.events || "events"] || []).length ? ` — ${cellText(r[f.events || "events"])}` : ""}`; } }, el("span", { text: dg(String(jd)) }));
      grid.append(el("div", { role: "gridcell" }, b));
    }
    const step = (d) => { let ny = y, nm = m + d; if (nm < 1) { nm = 12; ny--; } if (nm > 12) { nm = 1; ny++; } inst.args = { ...inst.args, year: ny, month: nm }; refresh(inst); };
    const title = (env.data.root && env.data.root.data && env.data.root.data.title) || `${dg(y)}/${dg(m)}`;
    box.append(el("div", { class: "wb-bar2" }, el("button", { type: "button", class: "wb-btn wb-btn--quiet", text: t("cal.prev"), onclick: () => step(-1) }), el("strong", { class: "wb-cal__title", text: title }), el("button", { type: "button", class: "wb-btn wb-btn--quiet", text: t("cal.next"), onclick: () => step(1) })),
      grid, detail, el("ul", { class: "wb-legend" }, ["holiday", "weekend", "work"].map((k) => el("li", {}, el("span", { class: "wb-cal__key", "data-kind": k }), t(`cal.${k}`)))));
  };

  RENDER.calculator = (inst, env, box) => {
    const calcs = inst.pane.calcs; let cur = calcs.find((c) => c.id === inst.args.calc) || calcs[0];
    const tabs = el("div", { class: "wb-chips", role: "group", "aria-label": t("calc.pick") }), form = el("div", { class: "wb-form" }), outBox = el("dl", { class: "wb-stats", "aria-live": "polite" });
    const draw = () => {
      tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === cur.id)));
      const vals = {}; put(form, ...cur.inputs.map((i) => { const inp = el("input", { class: "wb-input", id: `${inst.tab.k}-${i.id}`, type: "text", inputmode: i.type === "number" ? "decimal" : "text", dir: "ltr", value: i.default ?? "", autocomplete: "off" }); vals[i.id] = inp; inp.addEventListener("input", calc); return el("label", { class: "wb-field", for: inp.id }, el("span", { text: i.label }), inp); }));
      cur._vals = vals; calc();
    };
    const calc = () => {
      const inp = Object.fromEntries(Object.entries(cur._vals).map(([k, v]) => [k, v.value])), r = WB.calculate(cur.op, inp);
      if (!r) { put(outBox, el("div", {}, el("dt", { text: t("calc.result") }), el("dd", { class: "wb-down", text: t("calc.invalid") }))); return; }
      put(outBox, ...(cur.outputs || []).map((o) => { let v = r[o.id]; if (o.id === "weekday") v = S.weekdays[v]; else if (o.id === "gregorian") v = dg(v); else if (o.id === "jalali") v = dg(v); else if (typeof v === "number") v = num(v, 2); return el("div", {}, el("dt", { text: o.label }), el("dd", { text: `${v}${o.unit ? " " + o.unit : ""}` })); }));
    };
    for (const c of calcs) tabs.append(el("button", { type: "button", class: "wb-chip wb-chip--btn", "data-id": c.id, text: c.label, onclick: () => { cur = c; inst.args.calc = c.id; draw(); } }));
    box.append(tabs, form, outBox); draw();
  };

  RENDER.sandbox = (inst, env, box) => {
    const ops = inst.pane.ops, scen = (inst.pane.params || {}).scenarios || []; let cur = ops.find((o) => o.id === inst.args.op) || ops[0];
    const sel = el("select", { class: "wb-select", "aria-label": t("sandbox.op") }, ops.map((o) => el("option", { value: o.id, selected: o.id === cur.id, text: `${o.method} ${o.path} — ${o.title}` })));
    const sc = el("select", { class: "wb-select", "aria-label": t("sandbox.scenario") }, [el("option", { value: "none", text: t("sandbox.none") }), ...scen.map((s) => el("option", { value: s, text: s }))]);
    const ta = el("textarea", { class: "wb-input wb-code", rows: "5", dir: "ltr", spellcheck: "false", "aria-label": t("sandbox.params") }), out = el("pre", { class: "wb-pre", dir: "ltr", tabindex: "0", "aria-live": "polite" }), st = el("p", { class: "wb-note" });
    const fill = async () => { out.textContent = ""; st.textContent = ""; let state = {}; try { state = (await engineOf(srcOf(inst.srcId))).state || {}; } catch { /* the pane shows the error when sending */ } ta.value = JSON.stringify(WB.fillState(cur.params || {}, state), null, 2); };
    sel.addEventListener("change", () => { cur = ops.find((o) => o.id === sel.value); inst.args.op = cur.id; fill(); });
    const send = el("button", { type: "button", class: "wb-btn", text: t("sandbox.send"), onclick: async () => {
      let params; try { params = JSON.parse(ta.value || "{}"); } catch { st.textContent = t("sandbox.badJson"); return; }
      try { const e = await engineOf(srcOf(inst.srcId)); const h = cur.idempotent ? { "Idempotency-Key": `wb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` } : {}; const r = e.handle(cur.id, params, h, sc.value); st.textContent = t("sandbox.status", { status: dg(r.status) }); st.dataset.ok = String(r.status < 400); out.textContent = JSON.stringify(r.body, null, 2); }
      catch (e) { st.textContent = errText(e); }
    } });
    box.append(el("div", { class: "wb-form" }, sel, el("label", { class: "wb-field" }, el("span", { text: t("sandbox.scenario") }), sc), ta, send), st, out); fill();
  };

  RENDER.sources = (inst, env, box) => {
    const list = el("ul", { class: "wb-srcs" });
    for (const s of def.sources) {
      const kv = (k, v) => el("div", {}, el("dt", { text: k }), el("dd", { text: v }));
      const fx = s.fixture !== undefined && s.contract ? WB.checkRows(validator, Array.isArray(s.fixture) ? s.fixture : [s.fixture], s.contract, 1) : null;
      list.append(el("li", { class: "wb-src", "data-enabled": String(s.enabled) }, el("div", { class: "wb-src__top" }, el("strong", { text: nameOf(s) }), badgeEl(s), el("span", { class: "wb-chip", "data-on": String(s.enabled), text: s.enabled ? t("enabled") : t("disabledShort") })),
        el("dl", { class: "wb-meta" }, kv(t("licence"), `${s.licence.line} (${t(`redistribution.${s.licence.redistribution}`)})`), kv(t("freshness"), t(`fresh.${s.freshness.status}`)), kv(t("reach"), `${t(`reachState.${s.reach.fromBrowser}`)} — ${dg(s.reach.testedOn)}`),
          s.disabledReason ? kv(t("disabledWhy"), s.disabledReason) : null, s.compliance && s.compliance.sanctionsNote ? kv(t("sanctions"), s.compliance.sanctionsNote) : null,
          fx ? kv(t("contract"), fx.length ? t("contractBad") : t("contractOk")) : null)));
    }
    if (byo.length) for (const b of byo) list.append(el("li", { class: "wb-src" }, el("div", { class: "wb-src__top" }, el("strong", { text: nameOf(b.envelope.source) }), badgeEl(b.envelope.source)), el("p", { class: "wb-note", text: b.envelope.licence.line })));
    box.append(list);
  };

  RENDER.help = (inst, env, box) => { box.append(helpContent()); };

  RENDER.watchlist = (inst, env, box) => {
    const list = el("ul", { class: "wb-watch" });
    const draw = async () => {
      put(list, ); if (!watch.items.length) { list.append(el("li", { class: "wb-empty", text: inst.pane.empty || t("watch.empty") })); return; }
      for (const it of watch.items) {
        const [sid, ser] = it.ref.split(":"), s = srcOf(sid), row = el("li", { class: "wb-watch__row" });
        const rm = el("button", { type: "button", class: "wb-btn wb-btn--quiet", text: t("watch.remove"), "aria-label": `${t("watch.remove")}: ${ser}`, onclick: () => { watch = WB.watchRemove(watch, it.ref); saveWatch(); announce(t("watch.removed")); draw(); } });
        if (!s || !s.enabled || s.adapter.type !== "seeded-series") { row.append(el("span", { text: it.ref }), el("span", { class: "wb-chip", text: t("watch.unavailable") }), rm); list.append(row); continue; }
        try { const e = await loadEnvelope(null, sid, {}), x = e.data.series.find((q) => q.id === ser), v = x.values, last = v[v.length - 1], pct = ((last - v[v.length - 2]) / v[v.length - 2]) * 100;
          row.append(el("span", { class: "wb-watch__name", text: x.label }), badgeEl(s), el("span", { class: "wb-watch__v", text: num(last, x.decimals) }), el("span", { class: pct >= 0 ? "wb-up" : "wb-down", dir: "ltr", text: `${pct >= 0 ? "+" : ""}${num(pct, 2)}٪` }), el("button", { type: "button", class: "wb-btn wb-btn--quiet", text: t("watch.open"), onclick: () => runPane(sid, { series: ser }) }), rm); }
        catch (e) { row.append(el("span", { text: it.ref }), el("span", { class: "wb-chip", text: errText(e) }), rm); }
        list.append(row);
      }
    };
    box.append(list); draw();
  };
  function toggleWatch(ref, btn) {
    if (watch.items.some((i) => i.ref === ref)) { watch = WB.watchRemove(watch, ref); announce(t("watch.removed")); btn.textContent = t("watch.add"); btn.setAttribute("aria-pressed", "false"); }
    else { const r = WB.watchAdd(watch, ref, def.watchlist.max); watch = r.watch; announce(t(r.status === "full" ? "watch.full" : "watch.added")); if (r.status === "added") { btn.textContent = t("watch.remove"); btn.setAttribute("aria-pressed", "true"); } }
    saveWatch();
    for (const i of instances.values()) if (i.pane.kind === "watchlist" && i.body.isConnected) i.refresh();
  }
  // the series pane the watchlist opens: the first pane of kind series that lists this source
  function runPane(sid, args) { const p = def.panes.find((x) => x.kind === "series" && (x.source === sid || (x.alternates || []).includes(sid))); if (p) open(p.id, args); }

  // ---- BYO ----
  const dlg = $("[data-wb-byo]");
  function byoToolbar(inst) {
    const sel = el("select", { class: "wb-select", "aria-label": t("byo.pick") }, byo.map((b) => el("option", { value: b.id, selected: b.id === (inst.args.id || byo[byo.length - 1].id), text: nameOf(b.envelope.source) })));
    sel.addEventListener("change", () => { inst.args.id = sel.value; refresh(inst); });
    return el("div", { class: "wb-bar2" }, sel, el("button", { type: "button", class: "wb-btn", text: t("byo.add"), onclick: openByo }), el("button", { type: "button", class: "wb-btn wb-btn--quiet", text: t("byo.forget"), onclick: () => { const id = sel.value; const i = byo.findIndex((b) => b.id === id); if (i >= 0) byo.splice(i, 1); store.del("localStorage", WB.keptKey(id)); store.del("sessionStorage", `key.${id}`); keys.delete(id); inst.args.id = undefined; refresh(inst); } }));
  }
  function byoEmpty(inst) { return el("div", { class: "wb-empty" }, el("p", { text: t("byo.empty") }), el("button", { type: "button", class: "wb-btn", text: t("byo.add"), onclick: openByo })); }
  async function refetchEntry(entry) {
    let key = keys.get(entry.id);
    if (!key && sessionStorage.getItem(`${NS}.key.${entry.id}`)) throw fail("locked", { entry });
    const r = await WB.fetchEndpoint(entry.refetch.url, { key, keyHeader: entry.refetch.header, timeoutMs: def.byo.timeoutMs, maxBytes: def.byo.maxResponseBytes });
    const rows = WB.findRows(r.json); if (!rows) throw fail("rows");
    const bad = WB.checkRows(validator, rows, entry.schema, 3); if (bad.length) throw fail("schema", { detail: bad.join(" | ") });
    if (rows.length > def.byo.maxRows) throw fail("rows");
    const src = { ...entry.envelope.source, name: entry.envelope.source.name };
    entry.envelope = envFor({ ...entry.envelope, id: entry.id, name: src.name, kind: src.kind, homepage: src.homepage }, { asOf: undefined, basis: "fetch-time", data: { rows, bytes: r.bytes } });
  }
  function unlockForm(inst, entry) {
    const pass = el("input", { type: "password", class: "wb-input", autocomplete: "off", "aria-label": t("byo.pass") }), msg = el("p", { class: "wb-err__detail", role: "alert" });
    const f = el("form", { class: "wb-form" }, el("p", { text: t("byo.locked") }), pass, el("button", { type: "submit", class: "wb-btn", text: t("byo.unlock") }), msg);
    f.addEventListener("submit", async (e) => { e.preventDefault(); try { keys.set(entry.id, await WB.openSecret(sessionStorage.getItem(`${NS}.key.${entry.id}`), pass.value)); inst.force = true; refresh(inst); } catch { msg.textContent = t("byo.wrongPass"); } });
    return f;
  }
  let byoN = 0;
  const byoSource = (name, kind, homepage) => ({ id: `byo.${++byoN}`, name: { [L.code]: name }, kind, ...(homepage ? { homepage } : {}), licence: { line: t("byo.licence"), redistribution: "not-applicable" }, freshness: { slaSeconds: 0, status: kind === "customer-dataset" ? "stale" : "live" }, reach: { fromBrowser: kind === "customer-dataset" ? "not-applicable" : "ok", testedOn: todayParts().iso }, provenance: { adapter: kind === "customer-dataset" ? "browser-file" : "browser-fetch", adapterVersion: "1" } });
  function ingest(src, rows, { asOf, basis, schema, bytes }) {
    const max = def.byo.maxRows; if (rows.length > max) throw fail("rows");
    const sch = schema || WB.inferSchema(rows), bad = WB.checkRows(validator, rows, sch, 3);
    if (bad.length) throw fail("schema", { detail: bad.join(" | ") });
    const env = envFor(src, { asOf, basis, data: { rows, bytes } });
    const probs = WB.acceptEnvelope(validator, env, src.id); if (probs.length) throw fail("envelope", { detail: probs.join(" | ") });
    const entry = { id: src.id, envelope: env, schema: sch }; byo.push(entry); return entry;
  }
  function showByoPane(id) {
    const p = def.panes.find((x) => x.source === "byo"); if (!p) return;
    const prev = [...instances.values()].find((i) => i.pane.id === p.id);
    if (prev) { prev.args.id = id; prev.tab.args.id = id; }
    open(p.id, { id });
    if (prev) refresh(prev);
  }
  function openByo() {
    if (!def.byo.enabled || !dlg) return;
    $("[data-byo-err]", dlg).textContent = ""; const last = store.get("localStorage", "byo.lastendpoint"); const uf = $("[data-byo-endpoint]", dlg); if (last && !uf.url.value) { uf.url.value = last.url; if (last.header) uf.header.value = last.header; } dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", "");
    $("[data-byo-url]", dlg).focus();
  }
  function closeByo() { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }
  if (dlg) {
    const err = $("[data-byo-err]", dlg), parseSchema = (txt) => { if (!txt.trim()) return null; try { const s = JSON.parse(txt); if (typeof s !== "object" || s === null) throw 0; return s; } catch { throw fail("schemajson"); } };
    const showErr = (e) => { err.textContent = e && e.code ? `${errText(e)}${e.detail ? ` (${e.detail})` : ""}` : t("err.unknown"); err.focus && err.focus(); };
    $("[data-byo-endpoint]", dlg).addEventListener("submit", async (ev) => {
      ev.preventDefault(); err.textContent = ""; const f = ev.target, url = f.url.value.trim(), btn = $("button[type=submit]", f);
      btn.disabled = true; btn.setAttribute("aria-busy", "true");
      try {
        const bad = WB.checkEndpoint(url); if (bad) throw fail(bad);
        const key = f.key.value || undefined, header = f.header.value.trim() || undefined, schema = parseSchema(f.schema.value);
        const r = await WB.fetchEndpoint(url, { key, keyHeader: header, timeoutMs: def.byo.timeoutMs, maxBytes: def.byo.maxResponseBytes });
        const rows = WB.findRows(r.json); if (!rows) throw fail("rows");
        const host = new URL(url).hostname, src = byoSource(host, "customer-endpoint", new URL(url).origin);
        const ms = r.date ? Date.parse(r.date) : NaN;
        const entry = ingest(src, rows, { asOf: Number.isFinite(ms) ? new Date(ms).toISOString() : undefined, basis: Number.isFinite(ms) ? "source" : "fetch-time", schema, bytes: r.bytes });
        entry.refetch = { url, header };
        if (key) { keys.set(entry.id, key); if (f.keep.checked && f.pass.value) { try { sessionStorage.setItem(`${NS}.key.${entry.id}`, await WB.sealSecret(key, f.pass.value)); } catch { /* session storage unavailable: the key is not kept, as when the box is unticked */ } } }
        if (f.save.checked) store.set("localStorage", "byo.lastendpoint", { url, header: header || null });
        f.key.value = ""; f.pass.value = ""; closeByo(); showByoPane(entry.id); announce(t("byo.added", { name: host }));
      } catch (e) { showErr(e); } finally { btn.disabled = false; btn.removeAttribute("aria-busy"); }
    });
    $("[data-byo-file]", dlg).addEventListener("submit", async (ev) => {
      ev.preventDefault(); err.textContent = ""; const f = ev.target, file = f.file.files[0];
      try {
        if (!file) throw fail("nofile"); if (file.size > def.byo.maxDatasetBytes) throw fail("size");
        const text = await file.text(), schema = parseSchema(f.schema.value); let rows;
        if (/\.json$/i.test(file.name) || /^\s*[[{]/.test(text)) { let j; try { j = JSON.parse(text); } catch { throw fail("parse"); } rows = WB.findRows(j); if (!rows) throw fail("rows"); }
        else rows = WB.parseCsv(text, { maxRows: def.byo.maxRows }).rows;
        const src = byoSource(file.name.slice(0, 60), "customer-dataset");
        const entry = ingest(src, rows, { asOf: file.lastModified ? new Date(file.lastModified).toISOString() : undefined, basis: "source", schema, bytes: file.size });
        if (f.save.checked && text.length <= 262144) store.set("localStorage", WB.keptKey(entry.id), WB.keptDataset(entry));   // the canonical envelope itself: asOf, basis and rows survive a reload
        f.reset(); closeByo(); showByoPane(entry.id); announce(t("byo.added", { name: file.name }));
      } catch (e) { showErr(e); }
    });
    $("[data-byo-infer]", dlg).addEventListener("click", async () => {
      err.textContent = ""; const f = $("[data-byo-endpoint]", dlg);
      try { const u = f.url.value.trim(); const bad = WB.checkEndpoint(u); if (bad) throw fail(bad); const r = await WB.fetchEndpoint(u, { key: f.key.value || undefined, keyHeader: f.header.value.trim() || undefined, timeoutMs: def.byo.timeoutMs, maxBytes: def.byo.maxResponseBytes }); const rows = WB.findRows(r.json); if (!rows) throw fail("rows"); f.schema.value = JSON.stringify(WB.inferSchema(rows), null, 2); } catch (e) { showErr(e); }
    });
    $$("[data-byo-close]", dlg).forEach((b) => b.addEventListener("click", closeByo));
    // datasets the visitor chose to keep in this browser come back (never a key)
    try {
      const records = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i); if (!k || !k.startsWith(`${NS}.`)) continue;
        let value; try { value = JSON.parse(localStorage.getItem(k)); } catch { continue; /* not JSON: dropped, never loaded */ }
        records.push({ key: k.slice(NS.length + 1), value });
      }
      const r = WB.restoreAll(validator, records.filter((x) => x.key.startsWith("byo.") && x.key !== "byo.lastendpoint"), { maxRows: def.byo.maxRows });
      byo.push(...r.entries); byoN = Math.max(byoN, r.next);   // a record that is not a valid kept dataset (v2, a SourceEnvelope naming its key, rows matching its schema) is dropped, never loaded
    } catch { /* storage unavailable: there are no saved datasets */ }
  }
  // ---- help ----
  function helpContent() {
    const wrap = el("div", { class: "wb-help" });
    wrap.append(el("h3", { text: t("help.commands") }), el("div", { class: "wb-scroll", tabindex: "0", role: "region", "aria-label": t("help.commands") }, el("table", { class: "wb-table" }, el("thead", {}, el("tr", {}, ["help.verb", "help.aliases", "help.what", "help.example"].map((k) => el("th", { scope: "col", text: t(k) })))),
      el("tbody", {}, def.commands.map((c) => el("tr", {}, el("td", {}, el("code", { dir: "ltr", text: c.verb })), el("td", { text: c.aliases.join("، ") }), el("td", { text: c.summary }), el("td", {}, c.example ? el("code", { dir: "ltr", text: c.example }) : "")))))));
    wrap.append(el("h3", { text: t("help.keys") }), el("dl", { class: "wb-keys" }, ...KEYS.flatMap((k) => [el("dt", {}, ...k.keys.map((x) => el("kbd", { text: x }))), el("dd", { text: t(`keys.${k.id}`) })])));
    return wrap;
  }
  const helpDlg = $("[data-wb-help]");
  function openHelp() { if (!helpDlg) return; $("[data-help-body]", helpDlg).replaceChildren(helpContent()); helpDlg.showModal ? helpDlg.showModal() : helpDlg.setAttribute("open", ""); }
  if (helpDlg) $$("[data-help-close]", helpDlg).forEach((b) => b.addEventListener("click", () => (helpDlg.close ? helpDlg.close() : helpDlg.removeAttribute("open"))));

  // ---- layout rendering ----
  const grid = $("[data-wb-grid]");
  function render() {
    for (const k of [...instances.keys()]) if (!layout.groups.some((g) => g.tabs.some((x) => x.k === k))) instances.delete(k);
    grid.dataset.groups = String(layout.groups.length);
    grid.replaceChildren(...layout.groups.map((g, gi) => {
      const tabs = el("div", { class: "wb-tabs", role: "tablist", "aria-label": t("tabs") });
      const sec = el("section", { class: "wb-group", "data-focus": String(gi === layout.focus), "aria-label": `${t("group")} ${dg(gi + 1)}` }, tabs);
      g.tabs.forEach((tab, ti) => {
        const pane = paneOf(tab.pane), sel = ti === g.active;
        const tb = el("button", { type: "button", role: "tab", class: "wb-tab", id: `tab-${tab.k}`, "aria-controls": `panel-${tab.k}`, "aria-selected": String(sel), tabindex: sel ? "0" : "-1", text: pane.title, onclick: () => { layout.focus = gi; g.active = ti; saveLayout(); render(); }, onkeydown: (e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const d = (e.key === "ArrowRight") === (L.dir === "ltr") ? 1 : -1; layout.focus = gi; g.active = (ti + d + g.tabs.length) % g.tabs.length; saveLayout(); render(); $(`#tab-${g.tabs[g.active].k}`).focus(); e.preventDefault(); } } });
        const x = el("button", { type: "button", class: "wb-tab__x", "aria-label": `${t("close")}: ${pane.title}`, text: "×", onclick: () => { layout = WB.layoutClose(layout, tab.k); saveLayout(); render(); } });
        tabs.append(el("span", { class: "wb-tabwrap", "data-active": String(sel) }, tb, x));
      });
      queueMicrotask(() => { const a = tabs.querySelector('[aria-selected="true"]'); if (a && a.scrollIntoView) a.scrollIntoView({ inline: "nearest", block: "nearest" }); });
      const active = g.tabs[g.active], panel = el("div", { class: "wb-pane", role: "tabpanel", id: `panel-${active.k}`, "aria-labelledby": `tab-${active.k}`, "data-pane": active.pane, tabindex: "-1" });
      sec.append(panel);
      const live = instances.get(active.k);
      if (live) { panel.replaceChildren(live.head, live.body); live.panel = panel; } else queueMicrotask(() => mountPane(active, panel));
      return sec;
    }));
  }
  function open(paneId, args = {}) {
    const r = WB.layoutOpen(layout, paneId, args); layout = r.state; saveLayout(); render();
    const p = $(`#panel-${r.k}`); if (p) { p.focus({ preventScroll: false }); if (!reduce) p.scrollIntoView({ block: "nearest" }); }
  }

  // ---- command line ----
  const form = $("[data-wb-cmd]"), input = $("[data-wb-input]"), list = $("[data-wb-sug]");
  let sugs = [], idx = -1;
  const sugText = (c) => el("span", {}, el("code", { dir: "ltr", text: c.command.verb }), " ", el("span", { text: c.command.summary }), c.via && WB.fold(c.via) !== WB.fold(c.command.verb) ? el("small", { text: ` — ${c.via}` }) : null);
  function showSugs() {
    sugs = WB.suggest(def.commands, input.value, 7); idx = -1;
    put(list, ...sugs.map((s, i) => el("li", { role: "option", id: `wb-sug-${i}`, "aria-selected": "false", onmousedown: (e) => { e.preventDefault(); pick(i); } }, sugText(s))));
    list.hidden = !sugs.length || document.activeElement !== input; input.setAttribute("aria-expanded", String(!list.hidden));
    if (!list.hidden) announce(t("sugCount", { n: dg(sugs.length) }));
  }
  function mark(i) { idx = i; $$("li", list).forEach((li, j) => li.setAttribute("aria-selected", String(j === i))); if (i >= 0) input.setAttribute("aria-activedescendant", `wb-sug-${i}`); else input.removeAttribute("aria-activedescendant"); }
  function pick(i) { const c = sugs[i].command, tokens = WB.tokenize(input.value), hit = WB.matchExact(def.commands, tokens); input.value = `${c.verb} ${hit && hit.command === c ? hit.rest.join(" ") : ""}`.trimEnd() + " "; list.hidden = true; input.setAttribute("aria-expanded", "false"); input.focus(); }
  input.addEventListener("input", showSugs); input.addEventListener("focus", showSugs); input.addEventListener("blur", () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { if (list.hidden) showSugs(); mark(Math.min(sugs.length - 1, idx + 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { mark(Math.max(-1, idx - 1)); e.preventDefault(); }
    else if (e.key === "Tab" && idx >= 0 && !list.hidden) { pick(idx); e.preventDefault(); }
    else if (e.key === "Escape") { if (!list.hidden) list.hidden = true; else input.blur(); }
  });
  const msgBox = $("[data-wb-cmderr]");
  function run(line) {
    const r = WB.parseLine(def.commands, line, S.cmd);
    msgBox.textContent = "";
    if (!r.command) { msgBox.textContent = r.errors[0] ? r.errors[0].message : ""; msgBox.hidden = !msgBox.textContent; if (r.suggestions.length) { sugs = r.suggestions; put(list, ...sugs.map((s, i) => el("li", { role: "option", id: `wb-sug-${i}`, onmousedown: (e) => { e.preventDefault(); pick(i); } }, sugText(s)))); list.hidden = false; input.setAttribute("aria-expanded", "true"); } return; }
    if (r.errors.length) { msgBox.textContent = `${r.command.verb}: ${r.errors.map((x) => x.message).join("؛ ")}`; msgBox.hidden = false; return; }
    msgBox.hidden = true; list.hidden = true;
    open(r.command.opens, WB.paneArgs(r.command, r.args)); announce(t("opened", { pane: paneOf(r.command.opens).title })); input.value = "";
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); if (idx >= 0 && !list.hidden) { pick(idx); return; } run(input.value); });

  // ---- keys ----
  const KEYS = [{ id: "focus", keys: ["/"] }, { id: "help", keys: ["?"] }, { id: "prev", keys: ["["] }, { id: "next", keys: ["]"] }, { id: "close", keys: ["x"] }, { id: "split", keys: ["s"] }, { id: "group", keys: ["g"] }, { id: "refresh", keys: ["r"] }, { id: "byo", keys: ["b"] }, { id: "reset", keys: ["0"] }, { id: "esc", keys: ["Esc"] }];
  document.addEventListener("keydown", (e) => {
    const tg = e.target, typing = tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopImmediatePropagation(); input.focus(); input.select(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
    const k = e.key, act = layout.groups[layout.focus].tabs[layout.groups[layout.focus].active];
    if (k === "/") { e.preventDefault(); input.focus(); }
    else if (k === "?") { e.preventDefault(); openHelp(); }
    else if (k === "[") { layout = WB.layoutCycle(layout, -1); saveLayout(); render(); }
    else if (k === "]") { layout = WB.layoutCycle(layout, 1); saveLayout(); render(); }
    else if (k === "x") { layout = WB.layoutClose(layout, act.k); saveLayout(); render(); }
    else if (k === "s") { layout = WB.layoutSplit(layout); saveLayout(); render(); }
    else if (k === "g") { layout = WB.layoutFocus(layout, 1); saveLayout(); render(); }
    else if (k === "r") { const i = instances.get(act.k); if (i) i.refresh(); }
    else if (k === "b") openByo();
    else if (k === "0") { layout = WB.layoutFrom(def, def.defaultLayout); saveLayout(); render(); announce(t("layoutReset")); }
  });
  const tool = (sel, fn) => { const b = $(sel); if (b) b.addEventListener("click", fn); };
  tool("[data-wb-help-btn]", openHelp); tool("[data-wb-byo-btn]", openByo);
  tool("[data-wb-split]", () => { layout = WB.layoutSplit(layout); saveLayout(); render(); });
  tool("[data-wb-reset]", () => { layout = WB.layoutFrom(def, def.defaultLayout); saveLayout(); render(); announce(t("layoutReset")); });
  const lsel = $("[data-wb-layouts]");
  if (lsel) lsel.addEventListener("change", () => { layout = WB.layoutFrom(def, lsel.value); saveLayout(); render(); });

  root.dataset.ready = "true"; render();
  window.KitWorkbenchApp = { open, run, get layout() { return layout; } };
}
if (typeof document !== "undefined") { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot(); }
