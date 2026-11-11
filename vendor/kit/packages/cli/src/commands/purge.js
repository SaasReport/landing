/**
 * kit purge [--files <url,url,…>] [--dry-run]
 *   Purges the Cloudflare edge cache of the site's own zone, so a fresh deploy shows at once (the Workers static-assets
 *   layer stores HTML and the 404 page in the zone cache, and those entries outlive a deploy).
 *   Zone: the host of kit.config.js `site.url`, looked up by name (`GET /zones?name=`; a www. host falls back to its parent).
 *   Guard: the zone found must be that host or a parent of it, and every --files URL must be inside it, so a shared
 *   account can never purge another project's zone. Default: purge everything (small static sites); --files: only those
 *   URLs (paths resolve against site.url), sent 30 per request.
 *   Token: CLOUDFLARE_API_TOKEN (Zone.Cache Purge + Zone.Zone Read). It is never printed.
 *   Network errors, 429 and 5xx are retried (3 attempts); an API refusal exits 1.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "../args.js";

export const CF_API = "https://api.cloudflare.com/client/v4";
const ATTEMPTS = 3;
const FILES_PER_CALL = 30;

/** site.url of kit.config.js (or --config), as a URL. Only the config file is loaded: no content pack, no validation. */
async function siteUrl(dir, file = "kit.config.js") {
  const path = resolve(dir, file);
  if (!existsSync(path)) throw new CliError(`no ${file} in ${dir} (pass --cwd <dir> or --config <file>)`);
  let mod;
  try { mod = await import(pathToFileURL(path).href); }
  catch (e) { throw new CliError(`cannot load ${file}: ${e?.message || e}`); }
  const raw = mod.default ?? mod.config;
  const url = raw?.site?.url;
  if (!url) throw new CliError(`${file} has no site.url`);
  try { return new URL(String(url)); }
  catch { throw new CliError(`site.url is not a URL: ${url}`); }
}

/** The host and its parents down to two labels: www.a.com → [www.a.com, a.com]. */
export function zoneCandidates(host) {
  const labels = String(host).toLowerCase().replace(/\.$/, "").split(".");
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** True when `host` is the zone apex or one of its subdomains. */
export const inZone = (host, zone) => { const h = String(host).toLowerCase(); const z = String(zone).toLowerCase(); return h === z || h.endsWith(`.${z}`); };

/** Never let the token reach the terminal, even inside an echoed API message. */
const redact = (s, token) => (token ? String(s).split(token).join("***") : String(s));

async function api(io, token, method, path, body) {
  const url = `${CF_API}${path}`;
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res;
    try {
      res = await io.fetch(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (e) {
      last = `network error: ${e?.cause?.code || e?.message || e}`;
      if (attempt < ATTEMPTS) { io.err(`${method} ${path}: ${redact(last, token)}, retrying (${attempt}/${ATTEMPTS - 1})`); await sleep(500 * 2 ** (attempt - 1)); continue; }
      throw new CliError(`${method} ${path} failed after ${ATTEMPTS} attempts: ${redact(last, token)}`);
    }
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* a reply that is not JSON is reported by its status below */ }
    if ((res.status === 429 || res.status >= 500) && attempt < ATTEMPTS) {
      io.err(`${method} ${path}: HTTP ${res.status}, retrying (${attempt}/${ATTEMPTS - 1})`);
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok || !json?.success) {
      const errs = (json?.errors || []).map((e) => `${e.code ? `${e.code} ` : ""}${e.message}`).join("; ");
      throw new CliError(redact(`${method} ${path}: HTTP ${res.status}${errs ? ` — ${errs}` : ""}`, token));
    }
    return json;
  }
  throw new CliError(`${method} ${path}: ${redact(last, token)}`);
}

/** The zone serving `host`: the most specific candidate the account has. The guard re-checks the returned name. */
async function findZone(io, token, host) {
  for (const name of zoneCandidates(host)) {
    const r = await api(io, token, "GET", `/zones?name=${encodeURIComponent(name)}`);
    const zone = (r.result || []).find((z) => String(z.name).toLowerCase() === name);
    if (zone) {
      if (!inZone(host, zone.name)) throw new CliError(`refusing: zone ${zone.name} does not serve ${host}`);
      return zone;
    }
  }
  throw new CliError(`no Cloudflare zone for ${host} on this token's account (tried ${zoneCandidates(host).join(", ")})`);
}

/** --files a,b and/or positionals after it → absolute URLs, each inside the site's zone (checked again once the zone is known). */
function fileList(flags, positionals, base) {
  if (flags.files == null || flags.files === false) return null;
  const raw = [...(typeof flags.files === "string" ? flags.files.split(",") : []), ...positionals].map((s) => s.trim()).filter(Boolean);
  if (!raw.length) throw new CliError("--files needs at least one URL or path (comma-separated)");
  return raw.map((f) => {
    try { return new URL(f, base).href; } catch { throw new CliError(`not a URL or path: ${f}`); }
  });
}

export async function purge(io, { _: positionals, flags }) {
  const dry = Boolean(flags["dry-run"]);
  const site = await siteUrl(io.cwd, flags.config ? String(flags.config) : undefined);
  const host = site.hostname.toLowerCase();
  if (!zoneCandidates(host).length) throw new CliError(`site.url host "${host}" is not a domain on Cloudflare`);
  const files = fileList(flags, positionals, site);
  const outside = (zone) => (files || []).filter((f) => !inZone(new URL(f).hostname, zone));
  const token = io.env.CLOUDFLARE_API_TOKEN;
  const what = files ? `${files.length} URL${files.length === 1 ? "" : "s"}` : "everything";

  if (!token && !dry) throw new CliError("CLOUDFLARE_API_TOKEN is not set (a token with Zone.Cache Purge and Zone.Zone Read on this zone)");
  // Before any API call: --files must stay on the site's own host family.
  const early = outside(zoneCandidates(host).at(-1));
  if (early.length) throw new CliError(`refusing: not on ${host}: ${early.join(", ")}`);

  if (dry && !token) {
    io.out(`dry run: site ${site.origin}`);
    io.out(`  GET ${CF_API}/zones?name=${zoneCandidates(host).join(" | ")}   (needs CLOUDFLARE_API_TOKEN; not set, lookup skipped)`);
    io.out(`  POST ${CF_API}/zones/<zone id>/purge_cache ${files ? JSON.stringify({ files }) : '{"purge_everything":true}'}`);
    return 0;
  }

  const zone = await findZone(io, token, host);
  const bad = outside(zone.name);
  if (bad.length) throw new CliError(`refusing: outside zone ${zone.name}: ${bad.join(", ")}`);

  const bodies = files
    ? Array.from({ length: Math.ceil(files.length / FILES_PER_CALL) }, (_, i) => ({ files: files.slice(i * FILES_PER_CALL, (i + 1) * FILES_PER_CALL) }))
    : [{ purge_everything: true }];
  if (dry) {
    io.out(`dry run: zone ${zone.name} (${zone.id}) for ${site.origin}, would purge ${what}`);
    for (const b of bodies) io.out(`  POST ${CF_API}/zones/${zone.id}/purge_cache ${JSON.stringify(b)}`);
    return 0;
  }
  for (const b of bodies) await api(io, token, "POST", `/zones/${zone.id}/purge_cache`, b);
  io.out(`purged ${what} on zone ${zone.name}`);
  if (files) for (const f of files) io.out(`  ${f}`);
  return 0;
}
