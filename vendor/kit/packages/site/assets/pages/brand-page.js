{{banner}}
(() => {
  "use strict";
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const note = (title, type = "success") => (window.{{ns.global}}Notify ? window.{{ns.global}}Notify.show({ type, title, timeout: 3200 }) : null);
  $$("[data-tabs]").forEach((root) => {
    const tabs = $$('[role="tab"]', root), panels = $$(".tabs__panel", root);
    const sel = (i) => { tabs.forEach((t, j) => t.setAttribute("aria-selected", j === i)); panels.forEach((p, j) => p.classList.toggle("is-active", j === i)); };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => sel(i));
      t.addEventListener("keydown", (e) => { const d = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0; if (!d) return; e.preventDefault(); const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); n.click(); });
    });
  });
  $$("[data-hex]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.hex); note(`{{s.text.1|tl}} ${b.dataset.hex} {{s.text.2|tl}}`); } catch { note(b.dataset.hex, "info"); }
  }));
  const DEMO = {
    success: { title: "{{s.text.3|dq}}", message: "{{s.text.4|dq}}" },
    info: { title: "{{s.text.5|dq}}", message: "{{s.text.6|dq}}" },
    warning: { title: "{{s.text.7|dq}}", message: "{{s.text.8|dq}}", actions: [{ label: "{{s.text.9|dq}}", onClick: () => { location.href = "/calendar/"; } }] },
    error: { title: "{{s.text.10|dq}}", message: "{{s.text.11|dq}}", actions: [{ label: "{{s.text.12|dq}}", onClick: () => window.{{ns.global}}Notify.success("{{s.text.13|dq}}", "{{s.text.14|dq}}") }, { label: "{{s.text.15|dq}}" }] },
    brand: { title: "{{s.text.16|dq}}", message: "{{s.text.17|dq}}", actions: [{ label: "{{s.text.18|dq}}", onClick: () => { location.href = "/#playground"; } }] },
  };
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-ntf-demo]"); if (b && window.{{ns.global}}Notify) window.{{ns.global}}Notify.show({ type: b.dataset.ntfDemo, ...DEMO[b.dataset.ntfDemo] }); });
})();
