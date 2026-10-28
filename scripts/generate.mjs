// The content builder: derives the landing page, the widget scenarios and the brand files from the core registries
// (vendor/core), the page's own copy (content/copy.json), the sample data (data/sample) and the engine adapter.
// Nothing here names a stakeholder, metric, report, role, cadence, commitment or figure: they are read from the registries.
//   node scripts/generate.mjs            write the generated files
//   node scripts/generate.mjs --check    exit 1 when a generated file differs from what the sources give
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import engine from "../vendor/core/adapters/widgets-engine.mjs";
import { FORMS } from "../src/forms.js";
import { reportClasses } from "../vendor/core/src/index.js";

const root = new URL("../", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const R = Object.fromEntries(["stakeholders", "metrics", "report-types", "cadences", "roles", "findings", "commitments", "company", "legal"].map((n) => [n, read(`vendor/core/registry/${n}.json`)]));
const copy = read("content/copy.json");
const tokens = read("tokens.json");
const sdkTarget = read("kit.sdk.json").targets[0];
const contract = read(sdkTarget.contract);
const asOf = copy.meta.asOf;
if (read("widgets.spec.json").build.asOf !== asOf) throw new Error(`widgets.spec.json build.asOf must equal content/copy.json meta.asOf (${asOf}): one date, two files`);
const E = (call, args) => engine[call](args, { asOf });

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fill = (t, o) => t.replace(/\{(\w+)\}/g, (m, k) => (k in o ? o[k] : m));
const list = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const kebab = (id) => id.replace(/_/g, "-");
const left = (t) => { const m = t.match(/\{\w+\}/); if (m) throw new Error(`placeholder ${m[0]} was not filled in: ${t}`); return t; };
const ref = (source, ptr) => ({ $ref: `${source}#/${ptr}` });
const eng = (call, args, pick) => ({ $engine: { source: "engine", call, args, ...(pick ? { pick } : {}) } });

// ---------------------------------------------------------------- facts derived from the registries
const reportNames = (pred) => R["report-types"].report_types.filter((r) => pred(reportClasses({ roles: R.roles, metrics: R.metrics }, r))).map((r) => r.name);
const sectorReports = {
  subscription: reportNames((c) => c.includes("revenue")),
  merchant: reportNames((c) => !c.includes("revenue") && !c.includes("platform")),
  platform: reportNames((c) => c.includes("platform")),
};
const drafts = R.legal.documents.filter((d) => d.status === "draft");
const company = R.company.company;
const unsetCompany = Object.entries(company).filter(([, v]) => v === null).map(([k]) => k.replace(/_/g, " "));
const gaps = [...new Set(R.stakeholders.stakeholders.flatMap((s) => s.not_in_stripe))].filter((x) => !x.includes("(")).slice(0, 8);
const objects = Object.keys(R.roles.input_class).map((k) => `${k.replace(/_/g, " ")}s`);
const email = R.company.contacts.support_email;
const year = asOf.slice(0, 4);
const counts = { stakeholders: R.stakeholders.stakeholders.length, metrics: R.metrics.metrics.length, reports: R["report-types"].report_types.length };

// ---------------------------------------------------------------- widgets: scenarios derived from the registries
const WIDGET = (id, title, archetype, honesty, extra = {}) => {
  const n = copy.widgets.notes[id];
  return {
    archetype, id, title, honesty,
    usage: { surfaces: [{ path: "/", placement: "section", how: n.how }, { path: "/examples/", placement: "page", how: n.how }] },
    application: { surface: n.application, href: "/" },
    architecture: { components: n.components, flow: n.flow, diagram: "docs/diagrams/landing-widgets.mmd" },
    utility: { learns: n.learns, does: n.does },
    ...extra,
  };
};
const sh = R.stakeholders.stakeholders;
const P = copy.people;
const T = { report: P.who.reportLine, notInStripe: P.who.notInStripeLine, finding: P.who.findingLine };
const tone = { act: "err", watch: "warn", info: "info" };

const whoAsks = (() => {
  const actors = [], steps = [];
  sh.forEach((s, i) => {
    const a = kebab(s.id);
    const d = E("stakeholder", { id: s.id, templates: T });
    actors.push({ id: a, label: ref("stakeholders", `stakeholders/${i}/name`), kind: "person", role: eng("stakeholder", { id: s.id, templates: T }, "questions"), sees: d.metrics.map((_, k) => eng("stakeholder", { id: s.id, templates: T }, `metrics.${k}`)) });
    d.reports.forEach((_, k) => steps.push({ id: `${a}-report-${k}`, actor: a, action: eng("stakeholder", { id: s.id, templates: T }, `reports.${k}`) }));
    if (d.findings.length) d.findings.forEach((_, k) => steps.push({ id: `${a}-finding-${k}`, actor: a, action: eng("stakeholder", { id: s.id, templates: T }, `findings.${k}`) }));
    else steps.push({ id: `${a}-finding-none`, actor: a, action: ref("copy", "people/who/noFindingLine") });
    steps.push({ id: `${a}-gap`, actor: a, action: eng("stakeholder", { id: s.id, templates: T }, "notInStripe") });
  });
  return { id: "who-asks", useCase: "people", audiences: ["subscription", "merchant", "platform"], title: ref("copy", "people/who/title"), summary: ref("copy", "people/who/summary"), honesty: "engine", actors, steps, widgets: [WIDGET("who-asks", ref("copy", "people/who/title"), "roles", "engine")] };
})();

const reportOrder = (() => {
  const rt = R["report-types"].report_types.find((r) => r.id === P.order.report);
  if (!rt || rt.stakeholders.length < 3) throw new Error(`copy.people.order.report ${P.order.report} needs a report type with at least three readers`);
  const actors = rt.stakeholders.map((id) => ({ id: kebab(id), label: ref("stakeholders", `stakeholders/${sh.findIndex((s) => s.id === id)}/name`), kind: "person" }));
  const screens = rt.stakeholders.map((id) => {
    const r = E("report", { type: rt.id, stakeholder: id });
    return { id: kebab(id), actor: kebab(id), title: eng("report", { type: rt.id, stakeholder: id }, "title"), lines: r.lines.map((_, k) => ({ label: eng("report", { type: rt.id, stakeholder: id }, `lines.${k}.label`), value: eng("report", { type: rt.id, stakeholder: id }, `lines.${k}.value`) })) };
  });
  return { id: "report-order", useCase: "reports", audiences: ["subscription", "merchant", "platform"], title: ref("copy", "people/order/title"), summary: ref("copy", "people/order/summary"), honesty: "engine", actors, steps: [{ id: "open", actor: actors[0].id, action: ref("copy", "people/order/summary") }], screens, widgets: [WIDGET("report-order", ref("copy", "people/order/summary"), "screens", "engine")] };
})();

const findings = (() => {
  const fs = E("findings", {});
  const steps = fs.map((f, k) => ({ id: `finding-${k}`, actor: "saasreport", action: eng("findings", {}, `${k}.headline`), outcome: eng("findings", {}, `${k}.recommendation`), status: tone[f.severity], icon: f.severity.charAt(0).toUpperCase(), rules: f.evidence.map((_, j) => eng("findings", {}, `${k}.evidence.${j}`)) }));
  return { id: "findings", useCase: "reports", audiences: ["subscription", "merchant", "platform"], title: ref("copy", "people/findings/title"), summary: ref("copy", "people/findings/summary"), honesty: "engine", actors: [{ id: "saasreport", label: ref("copy", "people/findings/systemName"), kind: "system" }], steps, widgets: [WIDGET("findings", ref("copy", "people/findings/summary"), "feed", "engine")] };
})();

const cost = (() => {
  const i = copy.roi.inputs, o = copy.roi.outputs;
  const input = (id) => ({ id, label: ref("copy", `roi/inputs/${id}/label`), type: "number", default: i[id].default, min: i[id].min, max: i[id].max, step: i[id].step, ...(i[id].unit ? { unit: ref("copy", `roi/inputs/${id}/unit`) } : {}) });
  const hours = "people * reports * minutes / 60";
  return {
    id: "cost", useCase: "cost", audiences: ["subscription", "merchant", "platform"], title: ref("copy", "roi/title"), summary: ref("copy", "roi/summary"), honesty: "sample",
    actors: [{ id: "you", label: ref("copy", "roi/you"), kind: "person" }],
    inputs: ["people", "reports", "minutes", "rate"].map(input),
    steps: [{ id: "enter", actor: "you", action: ref("copy", "roi/step") }],
    outcomes: [
      { id: "hours", label: ref("copy", "roi/outputs/hours/label"), expr: hours, unit: ref("copy", "roi/outputs/hours/unit"), decimals: 1 },
      { id: "month", label: ref("copy", "roi/outputs/month/label"), expr: `${hours} * rate`, unit: ref("copy", "roi/outputs/month/unit"), decimals: 0 },
      { id: "year", label: ref("copy", "roi/outputs/year/label"), expr: `${hours} * rate * 12`, unit: ref("copy", "roi/outputs/year/unit"), decimals: 0 },
    ],
    widgets: [WIDGET("cost", ref("copy", "roi/summary"), "calculator", "sample")],
  };
})();

const rolesAccess = (() => {
  const A = copy.trust.access, n = E("roleGroups", {}).count;
  const actors = [], steps = [];
  for (let i = 0; i < n; i++) {
    const a = `group-${i + 1}`, args = { index: i, more: A.more };
    const g = E("roleGroup", args);
    actors.push({ id: a, label: eng("roleGroup", args, "label"), role: eng("roleGroup", args, "members"), kind: "person", sees: g.allowed.length ? g.allowed.map((_, k) => eng("roleGroup", args, `allowed.${k}`)) : [ref("copy", "trust/access/noneLabel")] });
    steps.push({ id: `${a}-opens`, actor: a, action: ref("copy", "trust/access/step") });
  }
  return { id: "roles-access", useCase: "trust", audiences: ["subscription", "merchant", "platform"], title: ref("copy", "trust/access/title"), summary: ref("copy", "trust/access/summary"), honesty: "engine", actors, steps, widgets: [WIDGET("roles-access", ref("copy", "trust/access/summary"), "roles", "engine")] };
})();

const journey = (() => {
  const J = copy.delivery.journey;
  return {
    id: "journey", useCase: "delivery", audiences: ["subscription", "merchant", "platform"], title: ref("copy", "delivery/journey/title"), summary: ref("copy", "delivery/journey/summary"), honesty: "sample",
    actors: [{ id: "saasreport", label: ref("copy", "people/findings/systemName"), kind: "system" }],
    steps: J.steps.map((s, k) => ({ id: s.id, actor: "saasreport", action: ref("copy", `delivery/journey/steps/${k}/title`), outcome: ref("copy", `delivery/journey/steps/${k}/text`), status: "pending", chip: ref("copy", "delivery/journey/plannedLabel") })),
    widgets: [WIDGET("journey", ref("copy", "delivery/journey/summary"), "pipeline", "sample")],
  };
})();

const schedule = (() => {
  const S = copy.delivery.schedule;
  return {
    id: "schedule", useCase: "delivery", audiences: ["subscription", "merchant", "platform"], title: ref("copy", "delivery/schedule/title"), summary: ref("copy", "delivery/schedule/summary"), honesty: "engine",
    actors: [{ id: "schedule", label: ref("copy", "delivery/schedule/systemName"), kind: "system" }],
    steps: R.cadences.cadences.map((c) => ({ id: `cadence-${c.id}`, actor: "schedule", action: eng("cadence", { id: c.id, line: S.line }, "line"), at: eng("cadence", { id: c.id, line: S.line }, "date") })),
    widgets: [WIDGET("schedule", ref("copy", "delivery/schedule/summary"), "timeline", "engine")],
  };
})();

const numberGuard = (() => {
  const G = copy.trust.guard;
  const stages = G.stages;
  const cases = G.cases.map((c, k) => {
    const a = { draft: c.draft };
    return { id: c.id, label: ref("copy", `trust/guard/cases/${k}/label`), detail: eng("guard", a, "text"), decision: c.kind === "accepted" ? "allow" : "deny", reason: eng("guard", a, "reason"), ...(c.stopsAt ? { stops: c.stopsAt } : { outcome: ref("copy", `trust/guard/stages/${stages.length - 1}/detail`) }) };
  });
  for (const c of G.cases) if (E("guard", { draft: c.draft }).ok !== (c.kind === "accepted")) throw new Error(`guard case ${c.id}: the engine's verdict is not "${c.kind}"`);
  return {
    id: "number-guard", useCase: "trust", audiences: ["subscription", "merchant", "platform"], title: ref("copy", "trust/guard/title"), summary: ref("copy", "trust/guard/summary"), honesty: "engine",
    actors: stages.map((s, k) => ({ id: s.id, label: ref("copy", `trust/guard/stages/${k}/actor`), kind: k === 1 ? "agent" : "system" })),
    steps: stages.map((s, k) => ({ id: s.id, actor: s.id, action: ref("copy", `trust/guard/stages/${k}/action`), detail: ref("copy", `trust/guard/stages/${k}/detail`) })),
    cases, widgets: [WIDGET("number-guard", ref("copy", "trust/guard/summary"), "runs", "engine")],
  };
})();

const scenarios = { $comment: "Generated by scripts/generate.mjs from the core registries, content/copy.json and the sample data. Never edit by hand.", scenarios: [whoAsks, reportOrder, findings, cost, rolesAccess, journey, schedule, numberGuard] };

// ---------------------------------------------------------------- the landing (kit landing sections, content shape of @saasreport/site)
const C = copy;
const sectionIds = new Set(["people", "how", "cost", "sectors", "trust", "developers", "faq"]);
const modalOpen = (label, style) => ({ label, modal: "early", ...(style ? { style } : {}) });
const fs = E("findings", {});
const nrr = fs.find((f) => /retention/i.test(f.headline)) ?? fs[0];
const cadenceName = (id) => R.cadences.cadences.find((c) => c.id === id).name.toLowerCase();
const pairing = sh.filter((s) => R["report-types"].report_types.some((r) => r.stakeholders.includes(s.id))).slice(0, 2).map((s) => {
  const r = R["report-types"].report_types.find((x) => x.stakeholders.includes(s.id));
  return `${s.name}: ${r.name}, ${r.cadences.map(cadenceName).join(", ")}`;
}).join(". ");
const heroCounts = [counts.stakeholders, counts.reports, counts.metrics];
// The developers section: where the contract, the reference page, a live call and the client are. Every address is derived from the
// contract (its server, its paths and the examples of its parameters) and from the reference page of site.config.js.
const API = copy.developers;
const apiBase = contract.servers[0].url;
const liveCall = (() => {
  const callable = [];
  for (const [path, item] of Object.entries(contract.paths)) {
    if (!item.get) continue;
    const params = (item.get.parameters ?? []).map((p) => (p.$ref ? ref0(p.$ref) : p));
    if (params.some((p) => p.required && p.example === undefined)) continue;
    const withExample = params.filter((p) => p.in === "path" && p.example !== undefined);
    callable.push({ withExample: withExample.length, url: `${apiBase}${path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params.find((p) => p.name === k).example))}` });
  }
  // the first call that takes an example of the contract (it shows more than a health answer), else the first that takes nothing
  const pick = callable.find((c) => c.withExample) ?? callable[0];
  if (!pick) throw new Error("the contract has no GET operation that can be called without input");
  return pick.url;
})();
function ref0(pointer) { return pointer.replace(/^#\//, "").split("/").reduce((o, k) => o[k], contract); }
const REFERENCE_PATH = API.referencePath;
const apiLinks = { reference: REFERENCE_PATH, contract: `${REFERENCE_PATH}${sdkTarget.contract.split("/").pop()}`, live: liveCall, client: `/${sdkTarget.out}/index.mjs` };
const widgetsSection = (id, ids, head) => ({ type: "widgets", id, ...(head ? { head } : {}), widgets: ids });
const band = (id, c) => ({ type: "band", id, title: c.title, actions: [modalOpen(c.action, "light")] });

const sections = [
  {
    type: "hero", id: "top", eyebrow: C.hero.eyebrow, title: C.hero.title, lead: C.hero.lead,
    strip: { label: C.hero.chipsLabel, items: C.hero.chips },
    actions: [modalOpen(C.hero.primary, "primary"), { label: C.hero.secondary, href: "#report", style: "ghost" }],
    note: C.hero.note,
    mock: { bar: C.hero.mock.bar, kicker: C.hero.mock.kicker, product: C.hero.mock.product, badge: C.hero.mock.badge, steps: C.hero.mock.steps, stepStatus: C.hero.mock.stepStatus,
      stats: C.hero.mock.stats.map((label, i) => ({ count: heroCounts[i], label })) },
  },
  { type: "audience", label: C.audience.label, title: C.audience.title, items: sh.map((s) => s.name) },
  { type: "cards", id: "problem", style: "numbered", grid: "3", head: { eyebrow: C.problem.eyebrow, title: C.problem.title }, items: C.problem.items },
  {
    type: "stepper", id: "how", surface: "paper", label: C.how.stepsLabel, exampleLabel: C.how.exampleLabel, outputsLabel: C.how.outputsLabel,
    head: { eyebrow: C.how.eyebrow, title: C.how.title },
    steps: C.how.steps.map((s) => ({ ...s, example: fill(s.example, { objects: list(objects), pairing, finding: nrr.headline }) })),
  },
  widgetsSection("people", ["who-asks"], { eyebrow: P.eyebrow, title: P.title }),
  band("cta-people", P.cta),
  widgetsSection("report", ["report-order"], { eyebrow: P.order.eyebrow, title: P.order.title }),
  widgetsSection("findings", ["findings"], { eyebrow: P.findings.eyebrow, title: P.findings.title }),
  {
    type: "compare", id: "compare", head: { eyebrow: C.compare.eyebrow, title: C.compare.title }, columns: C.compare.columns,
    rows: C.compare.rows.map((r) => ({ option: r.option, pro: r.dashboard, con: r.report, us: true })),
  },
  widgetsSection("cost", ["cost"], { eyebrow: C.roi.eyebrow, title: C.roi.title }),
  band("cta-cost", C.roi.cta),
  {
    type: "cards", id: "sectors", style: "icon", grid: "3", head: { eyebrow: C.sectors.eyebrow, title: C.sectors.title },
    items: C.sectors.items.map((s) => ({ icon: s.icon, title: s.title, text: fill(s.text, { reports: list(sectorReports[s.id]) }) })),
  },
  widgetsSection("delivery", ["journey", "schedule"], { eyebrow: C.delivery.eyebrow, title: C.delivery.title }),
  { type: "cards", id: "trust", style: "numbered", grid: "3", head: { eyebrow: C.trust.eyebrow, title: C.trust.title }, items: R.commitments.commitments.map((c) => ({ title: C.trust.statusWords[c.status], text: c.statement })) },
  widgetsSection("trust-widgets", ["roles-access", "number-guard"]),
  { type: "cards", id: "developers", style: "numbered", grid: "2", head: { eyebrow: API.eyebrow, title: API.title }, items: API.items },
  { type: "band", id: "cta-developers", title: API.band.title, actions: Object.entries(API.band.actions).map(([key, label], i) => ({ label, href: apiLinks[key], style: i ? "ghost" : "primary" })) },
  { type: "faq", id: "faq", head: { eyebrow: C.faq.eyebrow, title: C.faq.title }, items: C.faq.items.map((q) => ({ q: q.q, a: fill(q.a, { classes: list(objects), gaps: list(gaps), company: `${list(unsetCompany)} ${unsetCompany.length > 1 ? "are" : "is"} not set` }) })) },
  { type: "final", id: "start", eyebrow: C.final.eyebrow, title: C.final.title, text: C.final.text, actions: [modalOpen(C.final.action)], micro: C.final.small },
];
for (const s of sections) JSON.stringify(s).replace(/\{\w+\}/g, (m) => { throw new Error(`placeholder ${m} was not filled in section ${s.id ?? s.type}`); });

const legalNote = fill(C.trust.legal.text, { count: String(drafts.length), titles: list(drafts.map((d) => d.title.toLowerCase())), missing: list(unsetCompany) });
const F = C.form;
const landing = {
  meta: { title: C.meta.title, description: C.meta.description, ogImageAlt: C.meta.title },
  nav: {
    links: C.nav.links.map((l) => { if (!sectionIds.has(l.section)) throw new Error(`nav section ${l.section} is not a section of the page`); return { label: l.label, href: `#${l.section}` }; }),
    cta: [modalOpen(C.nav.cta)],
    drawer: { links: C.nav.links.map((l) => ({ label: l.label, href: `#${l.section}` })), action: modalOpen(C.nav.drawerAction) },
  },
  sections,
  footer: {
    logoAlt: name0(), contact: modalOpen(C.footer.contact),
    columns: [{ title: C.footer.columns.page, links: C.nav.links.map((l) => ({ label: l.label, href: `#${l.section}` })) }, { title: C.footer.columns.status, links: C.footer.statusLinks.map((label) => ({ label, modal: "privacy" })) }],
    legal: [fill(C.footer.text, { year, holder: R.company.company.copyright_holder }), legalNote],
  },
  modals: [
    {
      id: "early", titleId: "m-early-t", form: "early-access", eyebrow: F.eyebrow, title: F.title, lead: F.lead, submit: F.submit, fine: F.fine,
      fields: FORMS["early-access"].fields.map((f) => ({ name: f.key, label: f.label, ...(f.required ? { required: true } : {}), ...(f.options ? { control: "chips", options: f.options, full: true } : f.max >= 1000 ? { control: "textarea", rows: 3, maxlength: f.max, full: true } : {}) })),
    },
    { id: "privacy", titleId: "m-privacy-t", eyebrow: C.privacy.eyebrow, title: C.privacy.title, doc: C.privacy.paragraphs.map((p) => ({ p })) },
  ],
};
function name0() { return R.company.company.trading_name; }
const chrome = { footer: landing.footer.legal[0], cta: modalOpen(C.nav.cta) };

// ---------------------------------------------------------------- brand files (written from the tokens and the trading name)
const name = R.company.company.trading_name;
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 198 45" width="198" height="45" role="img" aria-label="${esc(name)}"><rect x="2" y="8" width="29" height="29" rx="8" fill="${tokens.color.accent}"/><path d="M10 25l5-5 4 4 7-8" fill="none" stroke="${tokens.color.accentTint}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="40" y="29" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="${tokens.color.ink}">${esc(name)}</text></svg>\n`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45" width="45" height="45" role="img" aria-label="${esc(name)}"><rect x="2" y="2" width="41" height="41" rx="11" fill="${tokens.color.accent}"/><path d="M12 28l7-7 5 5 9-11" fill="none" stroke="${tokens.color.accentTint}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`;

const out = {
  "content/generated/landing.en.json": landing,
  "content/generated/chrome.en.json": chrome,
  "content/generated/scenarios.json": scenarios,
  "public/brand/logo.svg": logo,
  "public/brand/icon.svg": icon,
};
let stale = 0;
for (const [file, value] of Object.entries(out)) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  const path = new URL(file, root);
  if (process.argv.includes("--check")) { if (!existsSync(path) || readFileSync(path, "utf8") !== text) { console.error(`stale: ${file}`); stale++; } continue; }
  mkdirSync(dirname(path.pathname), { recursive: true });
  writeFileSync(path, text);
}
if (process.argv.includes("--check")) { if (stale) process.exit(1); console.log(`ok: ${Object.keys(out).length} generated files are fresh`); } else console.log(`wrote ${Object.keys(out).length} files`);
