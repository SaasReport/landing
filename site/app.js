// The page's widgets. They read the registries and sample data embedded in the page and call the real engine;
// no stakeholder, report, role or metric is named here. Integer arithmetic only for anything shown as a figure.
import { computeMetrics, evaluateFindings, planReport, allowedReportTypes, formatValue, changeBp, formatBp } from "./engine/index.js";

const D = JSON.parse(document.getElementById("data").textContent);
const { reg, sample } = D;
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else n.setAttribute(k, v); } for (const c of kids.flat()) n.append(c); return n; };
const metricById = new Map(reg.metrics.metrics.map((m) => [m.id, m]));
const reportsFor = (sid) => reg.reportTypes.report_types.filter((r) => r.stakeholders.includes(sid));
const state = { stakeholder: reg.stakeholders.stakeholders[0].id, reportType: null, currency: null };

// Currencies present in the sample, discovered from the engine's own output.
const allIds = reg.metrics.metrics.map((m) => m.id);
const current = computeMetrics(sample.periods.later, allIds), prior = computeMetrics(sample.periods.earlier, allIds);
const currencies = [...new Set(Object.values(current).flatMap((byCur) => Object.keys(byCur)))].sort();
state.currency = currencies[0];

function show(metricId, value) {
  if (value === null || value === undefined) return el("span", { class: "na" }, "undefined");
  return document.createTextNode(formatValue({ currencies: reg.currencies, unit: metricById.get(metricId).unit, currency: state.currency, value }));
}
const width = (v, max) => (max <= 0 ? 0 : Math.max(2, Math.round((100 * Math.abs(v)) / max))); // display only

function renderWho() {
  const s = reg.stakeholders.stakeholders.find((x) => x.id === state.stakeholder);
  const panel = $("#who-panel"); panel.replaceChildren(
    el("h3", {}, s.name),
    el("p", {}, "Questions this person asks"), el("ul", {}, s.decision_questions.map((q) => el("li", {}, q))),
    el("p", {}, "What leads their report"), el("ul", {}, s.priority_metrics.map((m) => el("li", {}, metricById.get(m).name))),
    el("p", {}, "Not in Stripe, so not in their report"), el("ul", {}, s.not_in_stripe.map((n) => el("li", {}, n))));
  const sel = $("#report-type"); const offered = reportsFor(s.id);
  sel.replaceChildren(...offered.map((r) => el("option", { value: r.id }, `${r.name} (${r.cadences.join(", ")})`)));
  if (!offered.some((r) => r.id === state.reportType)) state.reportType = offered[0].id;
  sel.value = state.reportType;
  for (const b of document.querySelectorAll(".who")) b.setAttribute("aria-selected", String(b.dataset.stakeholder === state.stakeholder));
}

function renderReport() {
  const plan = planReport(reg.reportTypes, reg.stakeholders, state.reportType, state.stakeholder);
  const out = $("#report");
  const sections = plan.sections.map((sec) => {
    const rows = sec.metrics.map((id) => ({ id, c: current[id]?.[state.currency] ?? null, p: prior[id]?.[state.currency] ?? null }));
    const maxOf = (unit) => Math.max(0, ...rows.filter((r) => metricById.get(r.id).unit === unit).flatMap((r) => [r.c, r.p]).filter((v) => v !== null).map(Math.abs)); // bars compare like with like
    const barred = (id) => metricById.get(id).unit !== "ratio_bp";
    return el("div", { class: "sect" }, el("h3", {}, sec.title), el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Figure"), el("th", { class: "n" }, "Sample month"), el("th", { class: "n" }, "Month before"), el("th", { class: "n" }, "Relative change"))),
      el("tbody", {}, rows.map((r) => {
        const ch = changeBp(r.c, r.p);
        return el("tr", {}, el("td", {}, metricById.get(r.id).name, barred(r.id) && r.c !== null ? el("span", { class: "bar", style: `width:${width(r.c, maxOf(metricById.get(r.id).unit))}%` }) : "", barred(r.id) && r.p !== null ? el("span", { class: "bar prev", style: `width:${width(r.p, maxOf(metricById.get(r.id).unit))}%` }) : ""),
          el("td", { class: "n" }, show(r.id, r.c)), el("td", { class: "n" }, show(r.id, r.p)), el("td", { class: "n" }, ch === null ? el("span", { class: "na" }, "n/a") : `${ch > 0 ? "+" : ch < 0 ? "-" : ""}${formatBp(Math.abs(ch))}`));
      }))));
  });
  const findings = evaluateFindings({ findings: reg.findings, currencies: reg.currencies, metrics: reg.metrics, current, prior, stakeholder: state.stakeholder }).filter((f) => f.currency === state.currency);
  const list = findings.length
    ? el("ul", { class: "findings" }, findings.map((f) => el("li", { class: `finding ${f.severity}` }, el("span", { class: `sev ${f.severity}` }, f.severity), el("p", {}, f.headline),
        el("p", { class: "why" }, "Figures behind it: ", f.evidence.map((e) => `${e.name} ${e.text.current}${e.text.prior ? ` (before: ${e.text.prior})` : ""}`).join("; ")),
        f.recommendation ? el("p", {}, "Next step: ", f.recommendation.text) : "")))
    : el("p", { class: "note" }, "No published rule fired for this stakeholder in this sample month. The report says so rather than inventing a finding.");
  out.replaceChildren(el("p", {}, el("span", { class: "sample-tag" }, "SAMPLE DATA"), " ", sample.note), ...sections, el("div", { class: "sect" }, el("h3", {}, "Findings"), list));
}

function renderAccess() {
  const ids = [...document.querySelectorAll(".role input:checked")].map((i) => i.value);
  const allowed = ids.length ? allowedReportTypes({ roles: reg.roles, metrics: reg.metrics, reportTypes: reg.reportTypes }, ids) : [];
  const names = new Map(reg.reportTypes.report_types.map((r) => [r.id, r.name]));
  const out = $("#access-out");
  out.replaceChildren(allowed.length ? el("ul", {}, allowed.map((a) => el("li", {}, names.get(a)))) : el("p", {}, ids.length ? out.dataset.none : "Choose one or more roles."));
}

// ROI: integers only. Inputs are the visitor's own; nothing here is a benchmark.
function renderRoi() {
  const n = (id) => Math.max(0, Math.trunc(Number($(`#roi-${id}`).value) || 0));
  const hours = n("people") * n("perMonth") * n("hours"), cost = hours * n("rate"), share = n("share");
  $("#roi-share-out").textContent = String(share);
  const fmt = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  $("#r-hours").textContent = fmt(hours); $("#r-cost").textContent = fmt(cost); $("#r-year").textContent = fmt(cost * 12);
  $("#r-freed").textContent = fmt(Math.round((hours * share) / 100));
}

$("#currency").replaceChildren(...currencies.map((c) => el("option", { value: c }, c.toUpperCase())));
for (const b of document.querySelectorAll(".who")) b.addEventListener("click", () => { state.stakeholder = b.dataset.stakeholder; renderWho(); renderReport(); });
$("#report-type").addEventListener("change", (e) => { state.reportType = e.target.value; renderReport(); });
$("#currency").addEventListener("change", (e) => { state.currency = e.target.value; renderReport(); });
for (const i of document.querySelectorAll(".role input")) i.addEventListener("change", renderAccess);
for (const i of document.querySelectorAll(".roi input")) i.addEventListener("input", renderRoi);
renderWho(); renderReport(); renderAccess(); renderRoi();
document.documentElement.dataset.ready = "1";
