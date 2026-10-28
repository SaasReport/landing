// Builds dist/: index.html (every stakeholder, sector and commitment rendered from the registries and content), styles, the page script,
// the vendored engine, and the data the widgets read. Pure of the clock except the copyright year, which comes from SOURCE_DATE_EPOCH or now.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { readJson } from "./lib.mjs";
import { problems } from "./check.mjs";
import { sample } from "../site/sample.mjs";

const bad = problems();
if (bad.length) { for (const p of bad) console.error(`  - ${p}`); process.exit(1); }

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const R = (n) => readJson(`vendor/core/registry/${n}.json`);
const content = readJson("content/site.json"), tokens = readJson("site/tokens.json");
const reg = { stakeholders: R("stakeholders"), metrics: R("metrics"), reportTypes: R("report-types"), cadences: R("cadences"), roles: R("roles"), findings: R("findings"), currencies: R("currencies"), commitments: R("commitments"), company: R("company") };
const year = new Date(Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000)) * 1000).getUTCFullYear();
const holder = reg.company.company.copyright_holder;
const mail = `mailto:${content.contact.mailto}?subject=${encodeURIComponent(content.contact.subject)}`;
const metricName = new Map(reg.metrics.metrics.map((m) => [m.id, m.name]));
const reportsOf = (sid) => reg.reportTypes.report_types.filter((r) => r.stakeholders.includes(sid));

const css = `:root{${Object.entries(tokens.colors).map(([k, v]) => `--c-${k}:${v}`).join(";")}}\n` + readFileSync("site/styles.css", "utf8");
const stakeholderCards = reg.stakeholders.stakeholders.map((s, i) => `
  <button class="who" role="tab" type="button" data-stakeholder="${esc(s.id)}" data-shade="${i % 5}" aria-selected="false">${esc(s.name)}</button>`).join("");
const sectorCards = content.sectors.items.map((s) => `
  <article class="card"><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p><p class="chip">${esc(s.status)}</p></article>`).join("");
const points = (list) => list.map((p) => `<article class="card"><h3>${esc(p.title)}</h3><p>${esc(p.text)}</p></article>`).join("");
const steps = content.solution.steps.map((s, i) => `<li><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`).join("");
const commitments = reg.commitments.commitments.map((c) => `<li><span class="chip chip-${esc(c.status)}">${esc(c.status)}</span> ${esc(c.statement)}</li>`).join("");
const roleChips = reg.roles.roles.map((r) => `<label class="role"><input type="checkbox" value="${esc(r.id)}"> <span>${esc(r.name)}</span></label>`).join("");
const roi = content.roi;
const field = (id, label, min, value, max) => `<label class="field"><span>${esc(label)}</span><input id="roi-${id}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${value}"></label>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(content.title)}</title><meta name="description" content="${esc(content.description)}">
<link rel="icon" href="data:,"><link rel="stylesheet" href="styles.css"></head><body>
<p class="status" role="note">${esc(content.status)}</p>
<header class="top"><a class="brand" href="#top">SaasReport™</a><nav aria-label="Sections"><a href="#try">Try it</a><a href="#problem">Problem</a><a href="#who">Who</a><a href="#roi">ROI</a><a class="btn" href="${mail}">${esc(content.contact.label)}</a></nav></header>
<main id="top">
<section class="hero"><h1>${esc(content.hero.headline)}</h1><p class="lead">${esc(content.hero.sub)}</p>
<p class="actions"><a class="btn" href="${mail}">${esc(content.contact.label)}</a> <a class="btn ghost" href="#try">${esc(content.hero.secondary)}</a></p></section>

<section id="try" class="panel"><h2>${esc(content.tryit.title)}</h2><p class="note">${esc(content.tryit.note)}</p>
<div class="tabs" role="tablist" aria-label="Stakeholders">${stakeholderCards}</div>
<div id="who-panel" class="who-panel" aria-live="polite"></div>
<div class="controls"><label class="field"><span>${esc(content.tryit.currency)}</span><select id="currency"></select></label><label class="field"><span>Report</span><select id="report-type"></select></label></div>
<div id="report" class="report" aria-live="polite"></div></section>

<section id="problem"><h2>${esc(content.problem.title)}</h2><div class="grid">${points(content.problem.points)}</div></section>
<section id="solution" class="panel"><h2>${esc(content.solution.title)}</h2><ol class="steps">${steps}</ol></section>
<section id="who"><h2>${esc(content.sectors.title)}</h2><p class="note">${esc(content.sectors.note)}</p><div class="grid">${sectorCards}</div></section>

<section id="access" class="panel"><h2>${esc(content.access.title)}</h2><p class="note">${esc(content.access.text)}</p>
<fieldset class="roles"><legend class="sr">Stripe roles</legend>${roleChips}</fieldset>
<div id="access-out" class="access-out" aria-live="polite" data-none="${esc(content.access.none)}"></div></section>

<section id="roi"><h2>${esc(roi.title)}</h2><p class="note">${esc(roi.note)}</p>
<div class="roi"><div class="fields">${field("people", roi.fields.people, 1, 5, 1000)}${field("perMonth", roi.fields.perMonth, 1, 4, 100)}${field("hours", roi.fields.hours, 0, 3, 200)}${field("rate", roi.fields.rate, 0, 60, 10000)}
<label class="field"><span>${esc(roi.fields.share)}: <output id="roi-share-out">50</output>%</span><input id="roi-share" type="range" min="0" max="100" step="5" value="50"></label></div>
<dl class="results" aria-live="polite"><div><dt>${esc(roi.result.hours)}</dt><dd id="r-hours"></dd></div><div><dt>${esc(roi.result.cost)}</dt><dd id="r-cost"></dd></div><div><dt>${esc(roi.result.year)}</dt><dd id="r-year"></dd></div><div><dt>${esc(roi.result.freed)}</dt><dd id="r-freed"></dd></div></dl></div></section>

<section id="commitments" class="panel"><h2>${esc(content.commitments.title)}</h2><p class="note">${esc(content.commitments.note)}</p><ul class="commit">${commitments}</ul></section>
</main>
<footer><p>${esc(content.legal)}</p><p>© ${year} ${esc(holder)} ${esc(content.footer.rights)} <a href="mailto:${esc(content.contact.mailto)}">${esc(content.contact.mailto)}</a></p></footer>
<script type="application/json" id="data">${JSON.stringify({ reg, sample, labels: { reportType: "Report" } }).replace(/</g, "\\u003c")}</script>
<script type="module" src="app.js"></script></body></html>`;

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("vendor/core/src", "dist/engine", { recursive: true });
cpSync("site/app.js", "dist/app.js");
writeFileSync("dist/styles.css", css);
writeFileSync("dist/index.html", html);
console.log(`built dist/ (${html.length} bytes of html)`);
