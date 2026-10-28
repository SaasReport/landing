// The five operations areas: finops, bizops, platformops, saasops, infraops. Every section says whether it is available (read from a source
// now), empty (a source exists and holds nothing) or not connected (no source: nothing is shown, nothing is estimated).
import { snapshot } from "../config.js";
import { json, isoNow } from "../http.js";
import { buildOverview } from "./overview.js";
import { readiness } from "./provisioning.js";

const m = (key, label, value) => ({ key, label, value });
const sec = (id, title, state, summary, metrics = [], extra = {}) => ({ id, title, state, summary, metrics, ...extra });
const none = (id, title, reason) => sec(id, title, "not_connected", `Not connected. ${reason}`, [], { reason });
const sum = (ms) => ms.map((x) => `${x.label}: ${x.value}`).join("; ");
const counts = (xs, key) => Object.entries(xs.reduce((o, x) => ({ ...o, [x[key]]: (o[x[key]] || 0) + 1 }), {})).map(([k, v]) => m(k, k, v));
const reg = (n) => snapshot.registries[n].items;
const area = (a, title, sections) => json({ area: a, title, generated_at: isoNow(), sections });

export const getFinops = () => area("finops", "FinOps", [
  none("revenue", "Revenue and plans", "No billing or Stripe source is connected to the admin, and the product has no paying tenant recorded here."),
  none("cloud-cost", "Cloud cost", "No Cloudflare usage or billing source is connected; the admin holds no API credential for it."),
  none("budgets", "Budgets and forecasts", "Nothing to budget against: no cost or revenue source."),
]);

export async function getBizops(ctx) {
  const o = await buildOverview(ctx);
  const commitments = counts(reg("commitments"), "status"), legal = reg("legal");
  const blocked = legal.filter((d) => d.blockers.length).length;
  const funnel = o.leads.available ? Object.entries(o.leads.by_status).map(([k, v]) => m(k, k, v)) : [];
  return area("bizops", "BizOps", [
    o.leads.available ? sec("leads", "Lead funnel", o.leads.total ? "available" : "empty", o.leads.total ? sum(funnel) : "No lead has been recorded.", funnel, { source: "getOverview" }) : none("leads", "Lead funnel", "The leads table is not available to the admin yet."),
    sec("commitments", "Commitments", "available", sum(commitments), commitments, { source: "registry commitments" }),
    sec("legal", "Legal documents", "available", `${legal.length} documents, ${blocked} blocked from publication.`, [m("documents", "documents", legal.length), m("blocked", "blocked", blocked)], { source: "registry legal", reason: "The text of each document is not vendored, so facts and cited commitments are not checked here." }),
    none("customers", "Customers and tenants", "No tenant or customer record is connected to the admin."),
  ]);
}

export async function getPlatformops(ctx) {
  const o = await buildOverview(ctx);
  const up = o.workers.filter((w) => w.reachable).length;
  const d = o.deliveries;
  return area("platformops", "PlatformOps", [
    sec("workers", "Worker builds", "available", `${up} of ${o.workers.length} Workers answered the build request.`, [m("reachable", "reachable", up), m("total", "Workers", o.workers.length), m("main_head", "main's head known", o.main_head.available)], { source: "getOverview" }),
    d.available === false ? none("deliveries", "Form deliveries", "The delivery ledger is not available to the admin.")
      : sec("deliveries", "Form deliveries, last day", d.submissions ? "available" : "empty", d.submissions ? `${d.submissions} submissions, ${d.owner_failed} owner notifications failed, ${d.owner_pending_stale} pending too long.` : "No submission in the window.", [m("submissions", "submissions", d.submissions), m("owner_failed", "owner failed", d.owner_failed), m("receipt_failed", "receipt failed", d.receipt_failed)], { source: "comms_form_deliveries" }),
    none("monitor", "Monitor status", "No monitor Worker is deployed in this repository yet; its status is read when it is."),
  ]);
}

export function getSaasops() {
  const rows = [["report-types", "Report types"], ["stakeholders", "Stakeholders"], ["metrics", "Metrics"], ["findings", "Findings rules"]];
  const ms = rows.map(([n, l]) => m(n, l, reg(n).length));
  return area("saasops", "SaaSOps", [
    sec("catalogue", "The product catalogue", "available", sum(ms), ms, { source: "core registries" }),
    none("tenants", "Tenants and usage", "The product records no tenant or usage here: the Stripe app and the report pipeline are not connected to the admin."),
    none("reports", "Reports generated", "No report run is recorded where the admin can read it."),
  ]);
}

export function getInfraops(ctx) {
  const r = readiness(ctx.env);
  const planned = snapshot.planned, ok = planned.filter((p) => p.registry_valid).length;
  return area("infraops", "InfraOps", [
    sec("bindings", "Configuration and bindings", "available", r.ready ? "Everything required is present." : `Missing: ${r.missing.join(", ")}.`, [m("missing", "missing", r.missing.length)], { source: "getProvisioning" }),
    sec("naming", "Planned resources", "available", `${ok} of ${planned.length} planned names are in the naming registry.`, [m("valid", "in the registry", ok), m("total", "planned", planned.length)], { source: "snapshot", reason: ok < planned.length ? "The admin component and host wait for the naming change in the core repository." : undefined }),
    snapshot.release.available === false ? none("release", "Release records", "The repository holds no release.json yet.") : sec("release", "Release records", "available", "release.json is present.", [], { source: "release.json" }),
    none("backups", "Backups and restore drills", "No backup configuration or drill record is connected."),
  ]);
}
