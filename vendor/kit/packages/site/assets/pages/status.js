{{banner}}
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const faN = (n, d = 0) => KitFormat.formatNumber(n, "{{locale.code}}", { maxDecimals: d, numerals: "{{locale.digits}}" });
  const when = (iso) => KitFormat.digits(KitFormat.formatInstant(new Date(iso), { locale: "{{locale.dateIntl}}", calendar: "{{locale.calendar}}", dateStyle: "long", timeStyle: "short", timeZone: "{{tz}}" }), "{{locale.digits}}");
  const NAMES = { landing: ["{{s.text.1|dq}}", "{{s.text.2|dq}}"], glossary: ["{{s.text.3|dq}}", "{{s.text.4|dq}}"], podcasts: ["{{s.text.5|dq}}", "{{s.text.6|dq}}"],
    publishing: ["{{s.text.7|dq}}", "{{s.text.8|dq}}"], calendar: ["{{s.text.9|dq}}", "{{s.text.10|dq}}"], feeds: ["{{s.text.11|dq}}", "{{s.text.12|dq}}"], terminal: ["{{s.text.13|dq}}", "{{s.text.14|dq}}"] };
  const TRIG = { cron: "{{s.text.15|dq}}", manual: "{{s.text.16|dq}}" };
  const render = (d) => {
    const last = d.last;
    const head = $("[data-st-head]");
    if (!last) { head.textContent = "{{s.text.17|dq}}"; return; }
    head.innerHTML = last.ok ? '<span class="t-ok">{{s.text.18|sq}}</span>' : '<span style="color:var(--err)">{{s.text.19|sq}}</span>';
    const okN = last.journeys.filter((j) => j.ok).length;
    $("[data-st-sum]").innerHTML = `<div><small>{{s.text.20|tl}}</small><b>${esc(when(last.started_at))}</b></div><div><small>{{s.text.21|tl}}</small><b>${faN(okN)} {{s.text.22|tl}} ${faN(last.journeys.length)} {{s.text.23|tl}}</b></div><div><small>{{s.text.24|tl}}</small><b>${faN((new Date(last.finished_at) - new Date(last.started_at)) / 1000, 1)} {{s.text.25|tl}}</b></div><div><small>{{s.text.26|tl}}</small><b>${esc(TRIG[last.trigger] || last.trigger)}</b></div>`;
    $("[data-st-journeys]").innerHTML = last.journeys.map((j) => {
      const [fa, what] = NAMES[j.name] || [j.name, ""];
      return `<div class="st-j ${j.ok ? "ok" : "bad"}"><span class="st-dot"></span><div><b>${esc(fa)}</b><small>${esc(what)}</small>${j.error ? `<code>${esc(j.error)}</code>` : ""}</div><span class="st-ms">${faN(j.ms / 1000, 1)} {{s.text.27|tl}}${j.attempts > 1 ? "{{s.text.28|dq}}" : ""}</span></div>`;
    }).join("");
    $("[data-st-runs]").innerHTML = d.recent.map((r) => `<li class="${r.ok ? "ok" : "bad"}"><span class="st-dot"></span>${esc(when(r.started_at))}<span>${r.ok ? "{{s.text.29|dq}}" : "{{s.text.30|dq}}"}{{s.text.31|tl}} ${faN(r.journeys.filter((j) => j.ok).length)} {{s.text.22|tl}} ${faN(r.journeys.length)}</span></li>`).join("");
  };
  fetch("/api/status", { cache: "no-store" }).then((r) => r.json()).then(render).catch(() => { $("[data-st-head]").textContent = "{{s.text.32|dq}}"; });
})();
