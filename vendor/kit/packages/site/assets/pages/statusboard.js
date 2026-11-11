{{banner}}
/* The status board (page type "statusboard"): three sources, each optional, none required for the page to render.
   1. d.sources.components: service components and incidents ({ components: [{ name, group, status }] }, statuses
      operational | maintenance | degraded_performance | partial_outage | major_outage), e.g. a status API the
      site's Worker proxies;
   2. d.sources.monitor: the kit monitor's daily journeys (the Worker's /api/status: { last: { journeys, started_at } });
   3. d.sources.build: the checks of the last build ({ built, checks: [{ name, what, ok, detail, error }], recent }). */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const n = (v) => KitFormat.formatNumber(v, "{{locale.code}}", { maxDecimals: 3, numerals: "{{locale.digits}}" });
  const day = (iso) => KitFormat.digits(KitFormat.formatInstant(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`), { locale: "{{locale.dateIntl}}", calendar: "{{locale.calendar}}", dateStyle: "long", timeZone: "{{tz}}" }), "{{locale.digits}}");
  const when = (iso) => KitFormat.digits(KitFormat.formatInstant(new Date(iso), { locale: "{{locale.dateIntl}}", calendar: "{{locale.calendar}}", dateStyle: "medium", timeStyle: "short", timeZone: "{{tz}}" }), "{{locale.digits}}");
  const get = (url) => (url ? fetch(url, { cache: "no-store", headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null));   // an unreachable endpoint shows as unknown on the board
  const SRC = { components: "{{d.sources.components|dq}}", monitor: "{{d.sources.monitor|dq}}", build: "{{d.sources.build|dq}}" };
  const LABEL = { operational: "{{s.operational|dq}}", maintenance: "{{s.maintenance|dq}}", degraded_performance: "{{s.degraded|dq}}", partial_outage: "{{s.partial|dq}}", major_outage: "{{s.major|dq}}" };
  const row = (ok, name, what, right, err) => `<div class="st-j ${ok ? "ok" : "bad"}"><span class="st-dot"></span><div><b>${esc(name)}</b><small>${esc(what)}</small>${err ? `<code>${esc(err)}</code>` : ""}</div><span class="st-ms">${esc(right || "")}</span></div>`;
  const note = (text) => `<p class="muted sb-note">${esc(text)}</p>`;

  Promise.all([get(SRC.components), get(SRC.monitor), get(SRC.build)]).then(([comp, mon, build]) => {
    const list = comp && Array.isArray(comp.components) ? comp.components : [];
    $("[data-st-components]").innerHTML = list.length ? list.map((c) => row(c.status === "operational", c.name, c.group || "", LABEL[c.status] || c.status)).join("") : note("{{s.noComponents|dq}}");
    const last = mon && mon.last;
    $("[data-st-monitor]").innerHTML = last && Array.isArray(last.journeys) && last.journeys.length
      ? last.journeys.map((j) => row(j.ok, j.name, j.detail || j.note || "", j.ms != null ? `${n(j.ms)} ms` : "", j.error)).join("") : note("{{s.noRuns|dq}}");
    const checks = build && Array.isArray(build.checks) ? build.checks : [];
    const okN = checks.filter((c) => c.ok).length;
    $("[data-st-checks]").innerHTML = checks.length ? checks.map((c) => row(c.ok, c.name, c.what, c.detail, c.error)).join("") : note("{{s.noChecks|dq}}");
    const down = list.filter((c) => c.status !== "operational").length;
    $("[data-st-head]").innerHTML = down ? `<span style="color:var(--warn)">${n(down)} {{s.affected|tl}}</span>`
      : checks.length && okN === checks.length ? (list.length ? '<span class="t-ok">{{s.allNormal|sq}}</span>' : '<span class="t-ok">{{s.checksPass|sq}}</span>') : checks.length ? '<span style="color:var(--err)">{{s.someFailed|sq}}</span>' : "{{s.title|dq}}";
    $("[data-st-sum]").innerHTML = [
      ["{{s.components|dq}}", list.length ? `${n(list.length - down)} {{s.of|tl}} ${n(list.length)} {{s.operationalLower|tl}}` : "{{s.notAvailable|dq}}"],
      ["{{s.lastRun|dq}}", last ? when(last.started_at) : "{{s.noRunYet|dq}}"],
      ["{{s.lastBuild|dq}}", build?.built ? day(build.built) : "{{s.unknown|dq}}"],
      ["{{s.buildChecks|dq}}", checks.length ? `${n(okN)} {{s.of|tl}} ${n(checks.length)}` : "{{s.unknown|dq}}"],
    ].map(([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join("");
    $("[data-st-runs]").innerHTML = (build?.recent || []).map((r) => `<li class="ok"><span class="st-dot"></span>${esc(day(r.built))}<span>${esc(r.commit || "")} ${n(okN)} {{s.of|tl}} ${n(checks.length)} {{s.checksLower|tl}}</span></li>`).join("");
  });
})();
