{{banner}}
(() => {
  "use strict";
  const ICONS = {
    success: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    info: '<path d="M12 11v6M12 7.5v.01"/>',
    warning: '<path d="M12 7v6M12 16.5v.01"/>',
    error: '<path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/>',
    brand: '<circle cx="12" cy="12" r="3.2"/>',
  };
  const TITLES = { success: "{{s.text.1|dq}}", info: "{{s.text.2|dq}}", warning: "{{s.text.3|dq}}", error: "{{s.text.4|dq}}", brand: "{{name|dq}}" };
  const MAX = {{d.max}};
  let host, seq = 0; const live = new Map(); const queue = []; const history = [];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensureHost() {
    if (host) return host;
    host = document.createElement("section");
    host.className = "ntf"; host.setAttribute("aria-label", "{{s.text.5|dq}}");
    document.body.appendChild(host);
    return host;
  }
  function show(opts = {}) {
    const n = { id: ++seq, type: ICONS[opts.type] ? opts.type : "info", title: opts.title, message: opts.message || "", actions: opts.actions || [], timeout: opts.sticky ? 0 : opts.timeout ?? (opts.type === "error" ? {{d.errorTimeout}} : {{d.timeout}}), at: new Date() };
    history.unshift(n); history.length = Math.min(history.length, 50);
    if (live.size >= MAX) queue.push(n); else render(n);
    document.dispatchEvent(new CustomEvent("{{ns.key}}:notify", { detail: n }));
    return n.id;
  }
  function render(n) {
    const el = document.createElement("div");
    el.className = `ntf__item ntf--${n.type}`;
    el.setAttribute("role", n.type === "error" ? "alert" : "status");
    el.innerHTML = `<span class="ntf__node" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[n.type]}</svg></span><div class="ntf__body"><b></b><p></p><div class="ntf__acts"></div></div><button class="ntf__x" aria-label="{{s.text.6|tl}}"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>${n.timeout ? '<i class="ntf__rail"><i></i></i>' : ""}`;
    el.querySelector("b").textContent = n.title || TITLES[n.type];
    const p = el.querySelector("p"); if (n.message) p.textContent = n.message; else p.remove();
    const acts = el.querySelector(".ntf__acts");
    if (!n.actions.length) acts.remove();
    n.actions.slice(0, 2).forEach((a, i) => { const b = document.createElement("button"); b.className = i ? "ntf__btn ntf__btn--ghost" : "ntf__btn"; b.textContent = a.label; b.addEventListener("click", () => { try { a.onClick && a.onClick(); } finally { dismiss(n.id); } }); acts.appendChild(b); });
    el.querySelector(".ntf__x").addEventListener("click", () => dismiss(n.id));
    ensureHost().prepend(el);
    const rec = { n, el, left: n.timeout, started: performance.now(), timer: 0 };
    live.set(n.id, rec);
    requestAnimationFrame(() => el.classList.add("is-in"));
    if (n.timeout) { run(rec); const pause = () => stop(rec), resume = () => run(rec); el.addEventListener("mouseenter", pause); el.addEventListener("mouseleave", resume); el.addEventListener("focusin", pause); el.addEventListener("focusout", resume); }
    swipe(el, n.id);
  }
  function run(rec) {
    clearTimeout(rec.timer); rec.started = performance.now();
    const bar = rec.el.querySelector(".ntf__rail i");
    if (bar && !reduce) { bar.style.transition = "none"; bar.style.transform = `scaleX(${rec.left / rec.n.timeout})`; void bar.offsetWidth; bar.style.transition = `transform ${rec.left}ms linear`; bar.style.transform = "scaleX(0)"; }
    rec.timer = setTimeout(() => dismiss(rec.n.id), rec.left);
  }
  function stop(rec) {
    clearTimeout(rec.timer); rec.left = Math.max(400, rec.left - (performance.now() - rec.started));
    const bar = rec.el.querySelector(".ntf__rail i"); if (bar) { bar.style.transition = "none"; bar.style.transform = `scaleX(${rec.left / rec.n.timeout})`; }
  }
  function dismiss(id) {
    const rec = live.get(id); if (!rec) return;
    clearTimeout(rec.timer); live.delete(id);
    rec.el.classList.remove("is-in"); rec.el.classList.add("is-out");
    setTimeout(() => { rec.el.remove(); const next = queue.shift(); if (next) render(next); }, reduce ? 0 : {{d.exitMs}});
  }
  function swipe(el, id) {
    let x0 = null;
    el.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") x0 = e.clientX; });
    el.addEventListener("pointermove", (e) => { if (x0 != null) el.style.transform = `translateX(${e.clientX - x0}px)`; });
    const end = (e) => { if (x0 == null) return; const dx = e.clientX - x0; x0 = null; el.style.transform = ""; if (Math.abs(dx) > 80) dismiss(id); };
    el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  }
  const api = { show, dismiss, clear: () => [...live.keys()].forEach(dismiss), history,
    success: (title, message, o) => show({ ...o, type: "success", title, message }), info: (title, message, o) => show({ ...o, type: "info", title, message }),
    warning: (title, message, o) => show({ ...o, type: "warning", title, message }), error: (title, message, o) => show({ ...o, type: "error", title, message }),
    brand: (title, message, o) => show({ ...o, type: "brand", title, message }) };
  window.{{ns.global}}Notify = api;
})();
