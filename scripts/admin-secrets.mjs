// The deploy path's step that sets the admin Worker's Access secrets from Cloudflare itself, so no value is ever typed, stored or printed:
// the team domain (the Access organisation's auth domain), the application's AUD tag and the email allowlist (the emails of the
// application's policies). Runs only in the admin deploy workflow, with the job's CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
// Names come from workers/admin/admin.config.json; the Access application is the Worker's own name. Every failure names what is missing,
// never a value, and a value goes to `wrangler secret put` on its standard input, never an argument.
//   node scripts/admin-secrets.mjs            set the three secrets
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("workers/admin/admin.config.json", root), "utf8"));
const snapshot = JSON.parse(readFileSync(new URL("workers/admin/generated/snapshot.json", root), "utf8"));
const API = "https://api.cloudflare.com/client/v4";

/** The three values from the Cloudflare API: { teamDomain, aud, emails }. `get(path)` answers the `result` of a GET. */
export async function readAccess(get, account, appName) {
  const org = await get(`/accounts/${account}/access/organizations`);
  const teamDomain = org?.auth_domain;
  if (!teamDomain) throw new Error("the Access organisation has no auth domain");
  const apps = await get(`/accounts/${account}/access/apps?name=${encodeURIComponent(appName)}`);
  const app = (Array.isArray(apps) ? apps : []).find((a) => a.name === appName);
  if (!app) throw new Error(`no Access application named ${appName}`);
  if (!app.aud) throw new Error(`the Access application ${appName} has no AUD tag`);
  let policies = Array.isArray(app.policies) ? app.policies : [];
  if (!policies.some((p) => Array.isArray(p.include))) policies = (await get(`/accounts/${account}/access/apps/${app.id}/policies`)) || [];
  const rules = policies.filter((p) => !p.decision || p.decision === "allow").flatMap((p) => p.include || []);
  if (rules.some((r) => !r.email)) throw new Error(`the Access application ${appName} allows more than named emails: the admin is owner-only, so the policy must list emails and nothing else`);
  const emails = [...new Set(rules.map((r) => String(r.email.email).trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new Error(`the Access application ${appName} has no email policy`);
  return { teamDomain, aud: app.aud, emails };
}

export async function main({ env = process.env, fetchFn = fetch, run = spawnSync, log = console.log } = {}) {
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!env[name]) throw new Error(`${name} is not set in this job`);
  const get = async (path) => {
    const res = await fetchFn(`${API}${path}`, { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, accept: "application/json" } });
    let body = null;
    try { body = await res.json(); } catch { /* an answer that is not JSON is reported below as the status it came with */ }
    if (!res.ok || !body?.success) throw new Error(`Cloudflare API ${path.split("?")[0].replace(/[0-9a-f]{32}/g, ":id")} answered ${res.status}`);
    return body.result;
  };
  const a = await readAccess(get, env.CLOUDFLARE_ACCOUNT_ID, `${snapshot.project}-${config.component}-production`);
  const values = { [config.secrets.teamDomain]: a.teamDomain, [config.secrets.aud]: a.aud, [config.secrets.allowlist]: a.emails.join(",") };
  for (const [name, value] of Object.entries(values)) {
    const r = run("npx", ["wrangler", "secret", "put", name, "-c", "workers/admin/wrangler.toml"], { input: value, encoding: "utf8", env, stdio: ["pipe", "ignore", "pipe"] });
    if (r.status !== 0) throw new Error(`wrangler secret put ${name} failed`);
    log(`set ${name}`);
  }
}

const direct = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* no resolvable entry path: not run directly */ return false; } })();
if (direct) main().catch((e) => { console.error(`admin-secrets: ${e.message}`); process.exit(1); });
