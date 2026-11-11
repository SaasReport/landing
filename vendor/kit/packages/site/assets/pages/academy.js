{{banner}}
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const when = (iso) => KitFormat.digits(KitFormat.formatInstant(new Date(iso), { locale: "{{locale.dateIntl}}", calendar: "{{locale.calendar}}", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "{{tz}}" }), "{{locale.digits}}");
  const FORMAT = { online: "{{s.text.1|dq}}", in_person: "{{s.text.2|dq}}", hybrid: "{{s.text.3|dq}}" };
  const kindOf = (e) => { const t = `${e.title} ${e.slug}`; return /{{s.text.4}}/i.test(t) ? "webinar" : /{{s.text.5}}/i.test(t) ? "seminar" : "workshop"; };

  // tabs, with #workshop / #webinar / #seminar deep links
  const root = $("[data-tabs]"), tabs = $$('[role="tab"]', root), panels = $$(".tabs__panel", root);
  const sel = (i, push) => {
    tabs.forEach((t, j) => t.setAttribute("aria-selected", j === i)); panels.forEach((p, j) => p.classList.toggle("is-active", j === i));
    if (push && history.replaceState) history.replaceState(null, "", i ? `#${tabs[i].dataset.tab}` : location.pathname);
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => sel(i, true));
    t.addEventListener("keydown", (e) => { const d = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0; if (!d) return; e.preventDefault(); const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); n.click(); });
  });
  const fromHash = () => { const i = tabs.findIndex((t) => t.dataset.tab === location.hash.slice(1)); if (i > 0) sel(i); };
  fromHash(); addEventListener("hashchange", fromHash);

  const render = (events) => {
    const now = Date.now();
    const up = events.filter((e) => e.status !== "cancelled" && new Date(e.ends_at || e.starts_at).getTime() > now).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    // the kinds are the page's own tabs (a project may list other kinds than workshop / webinar / seminar)
    const kinds = [...document.querySelectorAll("[data-ev]")].map((el) => el.dataset.ev);
    for (const kind of kinds) {
      const list = up.filter((e) => (kinds.includes(e.kind) ? e.kind : kindOf(e)) === kind);
      if (!$(`[data-count="${kind}"]`) || !$(`[data-empty="${kind}"]`)) continue;
      $(`[data-count="${kind}"]`).textContent = list.length ? KitFormat.formatNumber(list.length, "{{locale.code}}", { numerals: "{{locale.digits}}" }) : "";
      $(`[data-empty="${kind}"]`).hidden = list.length > 0;
      $(`[data-ev="${kind}"]`).innerHTML = list.map((e) => `<a class="acad__card" href="/events/${esc(e.slug)}"><span class="pill run">${esc(FORMAT[e.format] || "")}</span><h3>${esc(e.title)}</h3><p>${esc(e.summary)}</p><small>${esc(when(e.starts_at))}${e.location && e.format !== "online" ? `{{s.text.6|tl}} ${esc(e.location)}` : ""}</small><b>{{s.text.7|tl}}</b></a>`).join("");
    }
  };
  fetch("/api/events").then((r) => r.json()).then((d) => render(d.events || [])).catch(() => render([]));
})();
