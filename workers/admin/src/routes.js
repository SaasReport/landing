// The routes: one row per operation of contracts/admin.openapi.json, written out with the contract's own path templates so
// `kit check contracts` can hold the two in step both ways. test/admin/contract.test.mjs also proves the operation ids agree.
import { getSession, getContract, listAudit } from "./handlers/misc.js";
import { getOverview } from "./handlers/overview.js";
import { listLeads, exportLeads, getLead, updateLead } from "./handlers/leads.js";
import { listDeliveries, getDelivery, retryDelivery, listOwnerAlertFailures } from "./handlers/deliveries.js";
import { listInbound, getAutoreplyStats } from "./handlers/inbound.js";
import { listSuppressions, addSuppression, removeSuppression } from "./handlers/suppressions.js";
import { listRegistries, getRegistry } from "./handlers/registries.js";
import { getProvisioning } from "./handlers/provisioning.js";
import { listRoles, listUsers, listInvitations, createInvitation, revokeInvitation } from "./handlers/users.js";
import { getFinops, getBizops, getPlatformops, getSaasops, getInfraops } from "./handlers/areas.js";

/** [method, path template, operationId, handler]. getBuild is answered before authentication by withBuild (the kit's /api/build). */
export const ROUTES = [
  ["GET", "/api/session", "getSession", getSession],
  ["GET", "/api/overview", "getOverview", getOverview],
  ["GET", "/api/leads", "listLeads", listLeads],
  ["GET", "/api/leads/export", "exportLeads", exportLeads],
  ["GET", "/api/leads/{id}", "getLead", getLead],
  ["PATCH", "/api/leads/{id}", "updateLead", updateLead],
  ["GET", "/api/deliveries", "listDeliveries", listDeliveries],
  ["GET", "/api/deliveries/{reference}", "getDelivery", getDelivery],
  ["POST", "/api/deliveries/{reference}/retry", "retryDelivery", retryDelivery],
  ["GET", "/api/inbound", "listInbound", listInbound],
  ["GET", "/api/autoreply/stats", "getAutoreplyStats", getAutoreplyStats],
  ["GET", "/api/alerts", "listOwnerAlertFailures", listOwnerAlertFailures],
  ["GET", "/api/suppressions", "listSuppressions", listSuppressions],
  ["POST", "/api/suppressions", "addSuppression", addSuppression],
  ["DELETE", "/api/suppressions/{recipient_hash}/{reason}", "removeSuppression", removeSuppression],
  ["GET", "/api/registries", "listRegistries", listRegistries],
  ["GET", "/api/registries/{name}", "getRegistry", getRegistry],
  ["GET", "/api/provisioning", "getProvisioning", getProvisioning],
  ["GET", "/api/audit", "listAudit", listAudit],
  ["GET", "/api/areas/finops", "getFinOps", getFinops],
  ["GET", "/api/areas/bizops", "getBizOps", getBizops],
  ["GET", "/api/areas/platformops", "getPlatformOps", getPlatformops],
  ["GET", "/api/areas/saasops", "getSaaSOps", getSaasops],
  ["GET", "/api/areas/infraops", "getInfraOps", getInfraops],
  ["GET", "/api/roles", "listRoles", listRoles],
  ["GET", "/api/users", "listUsers", listUsers],
  ["GET", "/api/invitations", "listInvitations", listInvitations],
  ["POST", "/api/invitations", "createInvitation", createInvitation],
  ["POST", "/api/invitations/{id}/revoke", "revokeInvitation", revokeInvitation],
  ["GET", "/api/openapi.json", "getContract", getContract],
  ["GET", "/api/build", "getBuild", null],
];

const compiled = ROUTES.map(([method, template, operationId, handler]) => {
  const names = [];
  const re = new RegExp(`^${template.replace(/[.]/g, "\\.").replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return "([^/]+)"; })}$`);
  return { method, template, operationId, handler, re, names };
});

/** → { route, params } for a request line, { allow: [methods] } when the path exists under other methods, or null. A literal path wins over a parameter. */
export function match(method, pathname) {
  const hits = compiled.filter((r) => r.re.test(pathname)).sort((a, b) => a.names.length - b.names.length);
  if (!hits.length) return null;
  const hit = hits.find((r) => r.method === method && r.names.length === hits[0].names.length) || hits.find((r) => r.method === method);
  if (!hit) return { allow: [...new Set(hits.map((r) => r.method))] };
  const params = {};
  const m = hit.re.exec(pathname);
  hit.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch { /* a malformed escape stays as written and fails the handler's own pattern check */ params[n] = m[i + 1]; } });
  return { route: hit, params };
}
