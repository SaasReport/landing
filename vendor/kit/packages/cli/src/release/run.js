import { stageD1Migrations } from "../migration-transport.js";
import { credentialAuthority } from "./credential-authority.js";
import { d1BackupPlan, snapshotExistingD1 } from "./pre-migration-backup.js";
/**
 * The production run of a kit project (docs/RELEASE.md): what the ONE workflow (templates/ci/production.yml) does after `npm test`, as
 * reusable kit code, so a site adds only release.json and the template (never a copy of FB's provisioning scripts).
 *
 *   ship(root, deps)     guard (main only, main's HEAD, the environment's policy) → seal → bootstrap receipt or READY → create-or-find every
 *                        D1 and R2 → for each Worker in order: migrate every D1 it binds that is not migrated yet, deploy with its commit
 *                        (and purge when declared) → write the owner address to every target secret → every Worker serves this commit
 *   verify(root, deps)   every Worker's GET /api/build (kit.build.v1) against a commit, with no credential: { problems, drift, unreadable }
 *   drills(root, deps)   the drills asked for (all of them in bootstrap), recorded with kit resilience record-drill; bootstrap → READY
 *
 * Every outside effect is a dependency (cf, wrangler, gh, fetch, run, now, sleep, log), injected by the CLI and by the tests. Nothing here
 * runs on an agent's machine: the agent guard refuses production writes outside CI (rule agent-never-deploys).
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { readWranglerConfig, readWranglerRaw, d1Index, d1Id } from "../wrangler-config.js";
import { wireD1, wireVar, placeholders } from "./wire.js";
import { RESILIENCE_FILE } from "../resilience/check.js";
import { recordDrill } from "../resilience/drills.js";
import { loadRelease, releaseWorkers, releaseIdentity, registryProject, buildUrl, SHA_RE, databaseBindings, migrationsDirFor, readJsonIf, BOOTSTRAP_RECEIPT, PROVISIONED_FILE, PLACEHOLDER_D1_ID, OWNER_SECRET } from "./config.js";
import { sealProblems } from "./seal.js";
import { monitorConfig, requiredSecrets } from "../resilience/check.js";

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;
export const UNREACHABLE = "unreachable";

export class ReleaseError extends Error {}
const fail = (m) => { throw new ReleaseError(m); };
const writeJson = (root, file, doc) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), `${JSON.stringify(doc, null, 2)}\n`); };

/** A Cloudflare API client on fetch (read-only calls and the create-or-find of D1 and R2; no delete exists here). */
export function cfClient({ token, accountId, fetch: f = globalThis.fetch, api = "https://api.cloudflare.com/client/v4" }) {
  if (!token) fail("CLOUDFLARE_API_TOKEN is not set (the production environment's secret)");
  if (!/^[0-9a-f]{32}$/.test(accountId || "")) fail("CLOUDFLARE_ACCOUNT_ID is not set to an account id (the production environment's secret)");
  const call = async (method, path, body) => {
    const r = await f(`${api}/accounts/${accountId}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    let j = null; try { j = await r.json(); } catch { j = null; /* a non-JSON answer is reported with its status below */ }
    return { status: r.status, ok: r.ok && j?.success !== false, json: j };
  };
  const must = (r, what) => { if (!r.ok) fail(`${what}: Cloudflare answered ${r.status} ${JSON.stringify(r.json?.errors ?? null).slice(0, 300)}`); return r.json?.result; };
  return {
    async scriptExists(name) {
      const r = await call("GET", `/workers/scripts/${encodeURIComponent(name)}/settings`);
      if (r.status === 404) return false;
      must(r, `reading Worker ${name}`); return true;
    },
    /** { present: false } | { present: true, commit: sha | null }: the BUILD_COMMIT the Worker's version carries (a plain_text binding), read-only. */
    async scriptBuildCommit(name) {
      const r = await call("GET", `/workers/scripts/${encodeURIComponent(name)}/settings`);
      if (r.status === 404) return { present: false };
      const s = must(r, `reading Worker ${name}`);
      const b = (s?.bindings || []).find((x) => x?.type === "plain_text" && x?.name === "BUILD_COMMIT");
      return { present: true, commit: b && SHA_RE.test(String(b.text ?? "")) ? b.text : null };
    },
    /** Read ONLY name/type metadata. The API intentionally never returns secret text.
     * A missing script/secret is absent; a permission failure is NOT absence. */
    async scriptSecretExists(workerName, secretName) {
      const path = `/workers/scripts/${encodeURIComponent(workerName)}/secrets/${encodeURIComponent(secretName)}`;
      const r = await call("GET", path);
      if (r.status === 404) return false;
      const x = must(r, `reading secret binding ${workerName}/${secretName}`);
      if (x?.name !== secretName || x?.type !== "secret_text")
        fail(`script ${workerName}: secret binding ${secretName} is not a secret_text binding`);
      return true;
    },
    async subdomain() { return must(await call("GET", "/workers/subdomain"), "reading the workers.dev subdomain")?.subdomain ?? null; },
    async d1Find(name) { return (must(await call("GET", `/d1/database?name=${encodeURIComponent(name)}&per_page=100`), `finding D1 ${name}`) || []).find((d) => d.name === name) || null; },
    async d1Create(name) { return must(await call("POST", "/d1/database", { name }), `creating D1 ${name}`); },
    async r2Exists(name) { const r = await call("GET", `/r2/buckets/${encodeURIComponent(name)}`); if (r.status === 404) return false; must(r, `reading R2 ${name}`); return true; },
    async r2Create(name) { return must(await call("POST", "/r2/buckets", { name }), `creating R2 ${name}`); },
  };
}

/** GitHub reads the run needs (main's HEAD, the environment's branch policy), with the job's own token. */
export function ghClient({ token, repository, fetch: f = globalThis.fetch, api = "https://api.github.com" }) {
  const get = async (path) => {
    if (!token) fail("GH_TOKEN is not set (the job's github.token)");
    const r = await f(`${api}${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) fail(`GET ${path} answered ${r.status}${[403, 404].includes(r.status) && path.includes("/environments/") ? " (the environment does not exist, or the job token cannot read it: docs/RELEASE.md, permissions of the environment read)" : ""}`);
    return r.json();
  };
  return {
    mainHead: async () => (await get(`/repos/${repository}/commits/main`)).sha,
    environment: (name) => get(`/repos/${repository}/environments/${encodeURIComponent(name)}`),
    branchPolicies: async (name) => ((await get(`/repos/${repository}/environments/${encodeURIComponent(name)}/deployment-branch-policies?per_page=100`)).branch_policies || []),
  };
}

/**
 * The run is for main's HEAD, from main, in an environment that deploys from main only. Local mode: this repository's main and GITHUB_SHA.
 * Central mode: the deployer's main (GITHUB_REF), its environment, and the SOURCE commit KIT_RELEASE_SOURCE_SHA, which must be the HEAD of
 * the tested tree at root (`checkoutHead`). This code never reads the source repository through the GitHub API: that the commit is the
 * source's main HEAD is proven by the deployer, a `git ls-remote` over SSH with its read-only deploy key immediately before ship, and
 * `kit release deployer-check` holds the deployer's workflow to that step (docs/RELEASE.md).
 */
export async function guard({ env, gh, id, checkoutHead }) {
  if (!SHA_RE.test(id.commit || "")) fail(`${id.central ? "KIT_RELEASE_SOURCE_SHA" : "GITHUB_SHA"} is not a commit`);
  if (!id.central) {
    const head = await gh.mainHead();
    if (head !== id.commit) fail(`this run is for ${id.commit}, but main is ${head}: only main's HEAD is deployed (the run for it is queued or will be)`);
  }
  if (typeof checkoutHead !== "function") fail("the checkout's HEAD cannot be read: what is deployed must be the commit that was checked, so a run that cannot read its tree's HEAD is refused");
  { const at = await checkoutHead(); if (at !== id.commit) fail(`the checkout is at ${at}, not ${id.commit}: what is deployed must be the commit that was checked`); }
  const environment = id.environment;
  const e = await gh.environment(environment);
  const dbp = e.deployment_branch_policy;
  if (!dbp || dbp.custom_branch_policies !== true) fail(`environment ${environment}: deployments are not limited to named branches`);
  const names = (await gh.branchPolicies(environment)).map((p) => ((p.type ?? "branch") === "branch" ? p.name : `${p.type}:${p.name}`));
  if (names.length !== 1 || names[0] !== "main") fail(`environment ${environment}: deploys from ${names.join(", ") || "(no branch)"}, not exactly main`);
}

/**
 * The owner address from the environment: exactly info@<the project's domain> (the kit project registry, one source), routed by Cloudflare
 * Email Routing to the owners. Empty, malformed, several or any other address (a personal one) is refused before ANY production change.
 */
export function ownerAddress(env, domain) {
  if (!domain) fail("the project has no domain in the kit project registry: the owner address info@<domain> cannot be checked");
  const raw = String(env[OWNER_SECRET] ?? "").trim();
  if (!raw) fail(`${OWNER_SECRET} is empty: the production environment must hold the owner's address (config first: nothing deploys without someone to tell)`);
  if (/[,;\n\s]/.test(raw)) fail(`${OWNER_SECRET} must be one address, info@${domain}`);
  if (!EMAIL.test(raw)) fail(`${OWNER_SECRET} is not an email address`);
  if (raw.toLowerCase() !== `info@${domain}`.toLowerCase()) fail(`${OWNER_SECRET} is not info@${domain}: the one owner address is the project's info@ (routed to the owners), never a personal one`);
  return raw;
}

/**
 * Bootstrap (state "bootstrap"): applies only while NO declared Worker was deployed by a production run, proven read-only from the
 * account: each Worker is absent, or present with no BUILD_COMMIT in its version (its settings carry no such plain_text binding: a shell
 * deploy, the state of every site the 2026-10-13 analysis found). A Worker whose version carries a BUILD_COMMIT sha, or whose public
 * /api/build serves one, was deployed by a production run: READY. A Worker whose settings cannot be read proves nothing and refuses
 * bootstrap: unknown is not empty, and so is a present Worker whose public /api/build answers anything but a 404 or a readable commit (a
 * network error, a 5xx, a 200 with no commit: present-unknown, refused). A 404 on /api/build is never evidence of anything. The receipt is written before any production
 * change. In state "ready" nothing is read here: READY is strict forever.
 */
export async function bootstrap(root, { doc, workers, cf, env, now, fetch: f = globalThis.fetch, commit = env.GITHUB_SHA }) {
  if (doc.state !== "bootstrap") return { state: "ready" };
  const prior = readJsonIf(root, BOOTSTRAP_RECEIPT);
  if (prior?.deployed_commit) fail(`bootstrap is claimed but ${BOOTSTRAP_RECEIPT} records a deployment (${prior.deployed_commit}): production exists, set release.json state to ready`);
  const seen = {};
  const { served, unreadable, notFound } = await readServed(doc, workers, f);
  const serving = Object.fromEntries(Object.entries(served).filter(([, c]) => SHA_RE.test(String(c))));
  for (const w of workers) {
    let s;
    try { s = await cf.scriptBuildCommit(w.name); } catch (e) { seen[w.name] = "present-unknown"; continue; /* an unreadable Worker proves nothing: refused below */ }
    // a present Worker whose public endpoint answered something that is neither a 404 nor a readable commit (network error, 5xx, a 200 with
    // no commit) proves nothing either: unknown is not empty
    const unclear = unreadable.some((u) => u.startsWith(`${w.name}:`)) && !notFound.has(w.name);
    seen[w.name] = !s.present ? "absent" : s.commit || serving[w.name] ? "present-released" : unclear ? "present-unknown" : "present-unreleased";
  }
  const eligible = Object.values(seen).every((s) => s === "absent" || s === "present-unreleased");
  const receipt = { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/release-bootstrap.schema.json", checked_at: now().toISOString(), run: env.GITHUB_RUN_URL || `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, commit, workers: seen, eligible, deployed_commit: null, drills: [] };
  writeJson(root, BOOTSTRAP_RECEIPT, receipt);
  if (!eligible) fail(`bootstrap claimed while Workers exist that a production run deployed or that cannot be read (${Object.entries(seen).filter(([, s]) => s !== "absent" && s !== "present-unreleased").map(([n, s]) => `${n}: ${s}`).join(", ")}): production exists, so release.json state must be ready and the drills strict`);
  return { state: "bootstrap", receipt };
}

/**
 * Create or find every D1 and R2; wire each placeholder database_id PER BINDING (wire.js: the block of that binding, never a whole-file
 * replace) and record it (release/provisioned.json); then set every worker monitor's MONITOR_DB_ID and MONITOR_WATCHED_DB_IDS from the
 * wired bindings (resilience.json says which binding is the monitor's own and which configs it watches); then refuse any release config
 * that still holds a placeholder. The records pull request commits the wired files.
 */
export async function provision(root, { doc, workers, cf, log }) {
  const record = readJsonIf(root, PROVISIONED_FILE) || { d1: {}, r2: [] };
  const before = JSON.stringify(record);
  let wired = false;
  const bindings = databaseBindings(workers);
  const edit = (file, fn, what) => { const p = join(root, file); writeFileSync(p, fn(readFileSync(p, "utf8"))); log(what); wired = true; };
  for (const { name } of doc.databases) {
    const configs = bindings.get(name) || [];
    let found = await cf.d1Find(name);
    if (!found) { found = await cf.d1Create(name); log(`created D1 ${name} (${found.uuid})`); } else log(`found D1 ${name} (${found.uuid})`);
    record.d1[name] = found.uuid;
    for (const c of configs) {
      if (c.id === found.uuid) continue;
      if (c.id !== PLACEHOLDER_D1_ID) fail(`${c.wrangler} binds ${name} as ${c.id}, but the account's ${name} is ${found.uuid}: a config may not point a Worker at another database`);
      edit(c.wrangler, (text) => wireD1(text, c.binding, found.uuid, { env: c.env, file: c.wrangler }), `wired ${c.wrangler} [[d1_databases]] ${c.binding} → ${found.uuid}`);
    }
  }
  // the monitors' own ids, from the wired configs (one reader): never from a text replace
  const res = readJsonIf(root, RESILIENCE_FILE);
  for (const m of (res?.monitors || []).filter((x) => x.kind === "worker" && x.worker)) {
    const cfgs = new Map([m.worker.wrangler, ...m.watches.map((x) => x.wrangler)].map((f) => [f, readWranglerConfig(root, f)]));
    const index = d1Index([...cfgs.values()]);
    const own = cfgs.get(m.worker.wrangler).envs[m.worker.env || ""];
    const ownId = d1Id(own?.d1.find((d) => d.binding === m.database_binding), index);
    if (!ownId || ownId === PLACEHOLDER_D1_ID) fail(`monitor ${m.id}: its ${m.database_binding} has no provisioned id after wiring (declare its database in release.json databases)`);
    // every watched binding must resolve to a real id: one dropped silently would leave a database unwatched while the var looks complete
    const ids = [];
    for (const x of m.watches) {
      const facts = cfgs.get(x.wrangler).envs[x.env || ""];
      if (!facts) fail(`monitor ${m.id}: it watches ${x.wrangler}${x.env ? ` [env.${x.env}]` : ""}, which has no such section`);
      for (const d of facts.d1) {
        const id = d1Id(d, index);
        if (!id || id === PLACEHOLDER_D1_ID) fail(`monitor ${m.id}: the watched binding ${d.binding} of ${x.wrangler} has no resolved database id (${d.name || "no name"}): it would be left unwatched`);
        ids.push(id);
      }
    }
    const watched = [...new Set(ids)].sort();
    if (watched.includes(ownId)) fail(`monitor ${m.id}: its own database ${ownId} is among the databases it watches: a monitor writes to a database it does not watch`);
    for (const [k, want] of [["MONITOR_DB_ID", ownId], ["MONITOR_WATCHED_DB_IDS", watched.join(",")]]) {
      if (String(own.vars[k] ?? "") === want) continue;
      edit(m.worker.wrangler, (text) => wireVar(text, k, want, { env: m.worker.env || "", file: m.worker.wrangler }), `wired ${m.worker.wrangler} [vars] ${k} → ${want}`);
    }
  }
  // every config the run reads or deploys: the release Workers, the monitors' Workers and what they watch (a migrate config is one of the binding configs)
  const scanned = new Set([...workers.map((w) => w.wrangler), ...(res?.monitors || []).filter((x) => x.kind === "worker" && x.worker).flatMap((m) => [m.worker.wrangler, ...m.watches.map((x) => x.wrangler)]), ...[...bindings.values()].flat().map((c) => c.wrangler)]);
  for (const file of [...scanned].sort()) {
    const left = placeholders(readFileSync(join(root, file), "utf8"));
    if (left.length) fail(`${file} still holds the placeholder id after wiring (line ${left.map((x) => x.line).join(", ")}): every placeholder must be a release.json database bound by name, or a monitor var the kit derives`);
  }
  for (const { name } of doc.buckets || []) {
    if (!(await cf.r2Exists(name))) { await cf.r2Create(name); log(`created R2 ${name}`); } else log(`found R2 ${name}`);
    if (!record.r2.includes(name)) record.r2.push(name);
  }
  record.r2.sort();
  const changed = wired || JSON.stringify(record) !== before || !existsSync(join(root, PROVISIONED_FILE));
  writeJson(root, PROVISIONED_FILE, record);
  return { record, changed };
}

/**
 * Every secret the project declares, and where it goes: [{ name, wrangler, env }]. Monitor-required secrets are derived from the monitor's policy;
 * release.json `secrets` is the canonical inventory of additional Worker-specific destinations,
 * including credentials not required by monitors (e.g. a developer API-key pepper). The owner address names (OPS_NOTIFY_TO and every owner target) are written by the owner step, from
 * OPS_NOTIFY_TO, never from here.
 */
export async function secretPlan(root, doc) {
  const res = readJsonIf(root, RESILIENCE_FILE);
  const owner = new Set([OWNER_SECRET, ...(doc.owner.targets || []).map((t) => t.name)]);
  const out = new Map();
  const add = (name, wrangler, env = "") => { if (!out.has(`${name}\u0000${wrangler}\u0000${env}`)) out.set(`${name}\u0000${wrangler}\u0000${env}`, { name, wrangler, env }); };
  for (const m of (res?.monitors || []).filter((x) => x.kind === "worker" && x.worker)) {
    for (const n of requiredSecrets(res, m, await monitorConfig(root, m))) { if (owner.has(n)) continue; add(n, m.worker.wrangler, m.worker.env || ""); out.get(`${n}\u0000${m.worker.wrangler}\u0000${m.worker.env || ""}`).monitorDerived = true; }
  }
  for (const x of doc.secrets || []) {
    if (owner.has(x.name)) fail(`release.json secrets: ${x.name} is reserved for the one owner address, never a runtime secret`);
    add(x.name, x.wrangler, x.env || "");
  }
  for (const x of doc.optional_secrets || []) {
    if (owner.has(x.name) || (doc.generated_secrets || []).includes(x.name) ||
        (doc.secrets || []).some((y) => y.name === x.name))
      fail(`release.json optional_secrets ${x.name}: ambiguous runtime secret owner`);
    add(x.name, x.wrangler, x.env || "");
    const k = `${x.name}\u0000${x.wrangler}\u0000${x.env || ""}`;
    out.get(k).optional = true;
  }
  return [...out.values()].sort((a, b) => `${a.name}${a.wrangler}`.localeCompare(`${b.name}${b.wrangler}`));
}

/** A secret's value from the run's environment: the variable of its name, or the environment's secrets map (KIT_RELEASE_SECRETS, `toJSON(secrets)`). */
export function secretValue(env, name) {
  if (env[name]) return env[name];
  try { const v = JSON.parse(env.KIT_RELEASE_SECRETS || "{}")[name]; return typeof v === "string" ? v : ""; } catch { return ""; /* an unparseable secrets map holds no secret: the value reads as absent and ship refuses before any change */ }
}

/** Apply one database's migrations through a temporary config that binds exactly the account's database (idempotent: wrangler's ledger). */
export async function migrate(root, { name, configs, cf, wrangler, log, tmp }) {
  const dir = migrationsDirFor(name, configs);
  if (!dir) { log(`D1 ${name}: no migrations directory declared, nothing to apply`); return null; }
  const found = await cf.d1Find(name);
  if (!found) fail(`D1 ${name} does not exist (provisioning creates it first)`);
  const compat = configs.map((c) => readWranglerConfig(root, c.wrangler).envs[""]?.compat).find(Boolean);
  if (!compat) fail(`no binding config of ${name} declares a compatibility_date: the migration config copies the Worker's, never a literal`);
  // The numbered immutable source is never edited. Wrangler's remote SQL
  // splitter cannot safely transport old semicolons or apostrophes inside
  // -- comments. Stage byte-proven executable-equivalent SQL outside the
  // repository and preserve each basename for the D1 migration ledger.
  // Every release attempt is exclusive, even after an interrupted/retried ship.
  // Never overwrite existing transport evidence or immutable source SQL.
  const attemptDir = mkdtempSync(join(tmp, `${name}-migration-stage-`));
  const staged = stageD1Migrations(join(root, dir), join(attemptDir, "migrations"));
  writeFileSync(join(attemptDir, "transport-provenance.json"), JSON.stringify(staged, null, 2) + "\n", { flag: "wx" });
  // Every Worker sharing this physical D1 must agree on the existing
  // migrations ledger table. Losing a custom name would replay old SQL.
  const tables = new Set(configs.flatMap((c) =>
    (readWranglerRaw(join(root, c.wrangler)).d1_databases || [])
      .filter((d) => d.database_name === name && d.migrations_table)
      .map((d) => d.migrations_table)));
  if (tables.size > 1) fail(`D1 ${name} has conflicting migrations_table declarations`);
  const migrationTable = [...tables][0] || null;
  const file = join(tmp, `${name}-migrate.toml`);
  writeFileSync(file, [
    `name = "${name}-migrate"`, `compatibility_date = "${compat}"`, "",
    "[[d1_databases]]", 'binding = "MIGRATE"',
    `database_name = "${name}"`, `database_id = "${found.uuid}"`,
    `migrations_dir = ${JSON.stringify(staged.staged_dir.replaceAll("\\", "/"))}`,
    ...(migrationTable ? [`migrations_table = ${JSON.stringify(migrationTable)}`] : []), "",
  ].join("\n"));
  await wrangler(["d1", "migrations", "apply", name, "--remote", "--config", file]);
  log(`ok D1 ${name}: ${staged.files.length} ordered migrations from ${dir} (${staged.normalised} comment-only transport repairs; original hashes preserved)`);
  return dir;
}

/** The deploy order is the contract: every D1 a Worker binds is migrated before it; the artefact is re-checked against the seal before each one. */
export async function ship(root, deps) {
  const { kit, env, cf, gh, checkoutHead, wrangler, run, log = console.log, now = () => new Date(), tmp } = deps;
  const { doc, problems } = loadRelease(root, kit);
  if (!doc) fail(problems.map((p) => `${p.file}: ${p.problem}`).join("; "));
  let id;
  try { id = releaseIdentity(doc, env, kit); } catch (e) { fail(e.message); }
  const workers = releaseWorkers(root, doc);
  await guard({ env, gh, id, checkoutHead });
  const owner = ownerAddress(env, registryProject(kit, doc.project)?.domain);   // config first: stops the run before any change
  // every declared secret must exist in the environment before ANY production change (names only in the refusal, never a value)
  const plan = await secretPlan(root, doc);
  // Resolve one canonical identity per secret across every deployed consumer,
  // including monitor-derived secret names. Deny drift BEFORE any remote mutation.
  // This static authority does not claim equality of opaque remote secret values.
  const authority = credentialAuthority(doc, plan, workers);
  // Only explicit, reviewed, project-owned daemon credentials may be minted.
  // Never invent external provider secrets, and NEVER regenerate a key merely
  // because a CI process restarted: stable hashes, invitations and authorisation
  // depend on persistence across deploys.
  const daemonNames = new Set(authority.filter((x) => x.lifecycle === "daemon").map((x) => x.name));
  const plannedNames = new Set(authority.map((x) => x.name));
  const workerFor = new Map(workers.map((w) => [`${w.wrangler}\u0000${w.env || ""}`, w.name]));
  const reusedProvider = new Set();
  const absentOptional = new Set();
  const absent = [];
  for (const name of [...plannedNames].sort()) {
    if (daemonNames.has(name) || secretValue(env, name)) continue;
    // An existing Cloudflare write-only provider secret is valid T0
    // authority. Preserve it as-is instead of demanding someone copy its
    // plaintext into GitHub or losing it by destructive redeployment.
    const targets = plan.filter((p) => p.name === name);
    const found = [];
    for (const x of targets) {
      const workerName = workerFor.get(`${x.wrangler}\u0000${x.env || ""}`);
      if (!workerName || typeof cf.scriptSecretExists !== "function")
        fail(`provider ${name}: no verifiable Worker binding for ${x.wrangler}`);
      found.push(await cf.scriptSecretExists(workerName, name));
    }
    if (found.every(Boolean)) reusedProvider.add(name);
    else if (found.some(Boolean))
      fail(`provider ${name}: partial remote secret bindings; refuse mismatched Worker credentials`);
    else if (targets.every((p) => p.optional)) absentOptional.add(name);
    else absent.push(name);
  }
  if (absent.length) fail(`the environment lacks ${absent.join(", ")} and Cloudflare has no existing binding: external provider credentials must exist in protected GitHub Environment or all declared Worker secret bindings; daemon credentials are minted only when T0-declared`);
  // All generated credentials have ONE value across their declared consumers.
  // On repeats, Cloudflare's existing write-only bindings are the durable
  // authority; a partial binding cannot be repaired by inventing a second
  // pepper or salt. Reject it before ANY production mutation.
  const daemon = new Map();
  for (const name of [...daemonNames].sort()) {
    if (secretValue(env, name))
      fail(`daemon secret ${name} is both generated_secrets and an environment value: declare one canonical owner`);
    const targets = plan.filter((p) => p.name === name);
    const found = [];
    for (const x of targets) {
      const workerName = workerFor.get(`${x.wrangler}\u0000${x.env || ""}`);
      if (!workerName || typeof cf.scriptSecretExists !== "function")
        fail(`daemon ${name} has no uniquely verifiable Worker binding`);
      found.push(await cf.scriptSecretExists(workerName, name));
    }
    if (found.some(Boolean) && !found.every(Boolean))
      fail(`daemon ${name}: partial existing Worker secret bindings; refusing to fork persistent credential identity`);
    daemon.set(name, found.every(Boolean) ? { reuse: true } : { reuse: false, value: randomBytes(48).toString("base64url") });
  }
  // the digest the build step reported (its step output, SEAL_SHA256): the seal on disk must be that one, of this commit
  if (!/^[0-9a-f]{64}$/.test(env.SEAL_SHA256 || "")) fail("SEAL_SHA256 is not set to the build step's digest: the workflow passes `steps.build.outputs.sha256`, so a reseal after the build step is refused");
  const sealed = () => { const s = sealProblems(root, doc.build.artifact, { commit: id.commit, sha256: env.SEAL_SHA256 }); if (s.length) fail(s.join("; ")); };
  sealed();
  if (doc.workers_dev) { const sub = await cf.subdomain(); if (sub !== doc.workers_dev) fail(`the account's workers.dev subdomain is ${sub}, release.json workers_dev says ${doc.workers_dev}: the watcher would read another URL`); }
  const b = await bootstrap(root, { doc, workers, cf, env, now, fetch: deps.fetch, commit: id.commit });
  // Explicit cutover authority, not accidental rotation: legacy shells may
  // already have an ADMIN_TOKEN whose plaintext is irretrievable. The new
  // governed publisher MUST have a usable first-boot credential. Rotate ONLY
  // this admin bearer after bootstrap attests ALL Workers are unreleased,
  // never a persistent pepper/salt, and never on repeat ready deployments.
  if (doc.rotate_legacy_admin_on_bootstrap === true && b.state === "bootstrap" &&
      b.receipt?.eligible === true && daemon.get("ADMIN_TOKEN")?.reuse) {
    daemon.set("ADMIN_TOKEN", { reuse: false, value: randomBytes(48).toString("base64url") });
    log("T0 approved bootstrap cutover: replacing unknown legacy ADMIN_TOKEN once; daemon identity now owned by the protected release");
  }
  // Canonical backup inventory is checked BEFORE provisioning mutates anything.
  // Existing physical D1 IDs must be snapshotted, with a read-back verified R2
  // object, BEFORE the first SQL migration or new Worker serves traffic.
  const backups = d1BackupPlan(doc, readJsonIf(root, RESILIENCE_FILE));
  const existingD1 = new Set();
  for (const d of doc.databases || []) if (await cf.d1Find(d.name)) existingD1.add(d.name);
  const prov = await provision(root, { doc, workers, cf, log });
  const after = releaseWorkers(root, doc);                           // re-read: provisioning may have wired an id
  const bindings = databaseBindings(after);
  for (const name of existingD1) {
    await snapshotExistingD1({
      root, doc, name, bucket: backups.get(name), configs: bindings.get(name),
      cf, wrangler, tmp, commit: id.commit, runId: env.GITHUB_RUN_ID, log,
    });
  }
  // A failed export/readback has stopped the entire release before this line.
  const migrated = new Set();
  for (const w of after) {
    for (const d of w.facts.d1) if (d.name && !migrated.has(d.name)) { await migrate(root, { name: d.name, configs: bindings.get(d.name), cf, wrangler, log, tmp }); migrated.add(d.name); }
    sealed();
    await wrangler(["deploy", "-c", w.wrangler, ...(w.env ? ["--env", w.env] : []), "--var", `BUILD_COMMIT:${id.commit}`, "--tag", id.commit.slice(0, 12), "--message", id.central ? `${id.source}@${id.commit} by ${id.runner}` : id.commit]);
    log(`deployed ${w.name} at ${id.commit.slice(0, 12)}`);
    if (w.purge) await run("purge");
  }
  for (const x of plan) {
    const managed = daemon.get(x.name);
    if (absentOptional.has(x.name)) { log(`optional external secret ${x.name} not provisioned (disabled, not generated)`); continue; }
    if (managed?.reuse || reusedProvider.has(x.name)) {
      log(`preserved ${x.name} on ${x.wrangler} (existing Cloudflare write-only binding; never reset by a CI retry)`);
      continue;
    }
    const value = managed ? managed.value : secretValue(env, x.name);
    await wrangler(["secret", "put", x.name, "-c", x.wrangler, ...(x.env ? ["--env", x.env] : [])], { input: value });
    log(`set ${x.name} on ${readWranglerConfig(root, x.wrangler).envs[x.env]?.name ?? x.wrangler} (${managed ? "initial daemon bootstrap" : "governed provider"} secret)`);
  }
  // The first release's publisher must authenticate to its just-deployed
  // Worker, but no human owns the daemon ADMIN_TOKEN. In the ONE protected
  // GitHub job, hand the first-boot credential to subsequent bootstrap drills
  // through a chmod-0600 file OUTSIDE the repo. Never put it in a GitHub output,
  // artifact, log, command argument or release record. Runner cleanup removes it.
  const firstAdmin = daemon.get("ADMIN_TOKEN");
  if (firstAdmin && !firstAdmin.reuse && doc.state === "bootstrap") {
    if (!env.GITHUB_RUN_ID?.match(/^\d+$/) || !env.RUNNER_TEMP || !env.GITHUB_ACTIONS)
      fail("T0 daemon first-boot publisher handoff requires an authenticated ephemeral GitHub runner");
    const filepath = join(env.RUNNER_TEMP, `kit-daemon-admin-${env.GITHUB_RUN_ID}.json`);
    writeFileSync(filepath, JSON.stringify({
      schema: "kit.daemon-admin-handoff.v1", run: env.GITHUB_RUN_ID,
      commit: id.commit, token: firstAdmin.value,
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    log("T0 first-boot admin credential handed to same-run publisher (runner-temp only; no value emitted)");
  }
  for (const t of doc.owner.targets || []) {
    await wrangler(["secret", "put", t.name, "-c", t.wrangler], { input: owner });
    log(`set ${t.name} on ${readWranglerConfig(root, t.wrangler).name} (the owner address, ${OWNER_SECRET})`);
  }
  const v = await verify(root, { doc, workers: after, commit: id.commit, fetch: deps.fetch, attempts: deps.attempts ?? 12, waitMs: deps.waitMs ?? 10000, sleep: deps.sleep });
  if (v.problems.length) fail(`not every Worker serves ${id.commit}:\n${v.problems.map((p) => `- ${p}`).join("\n")}`);
  log(`ok every Worker serves ${id.commit}`);
  return { state: b.state, commit: id.commit, workers: after.map((w) => w.name), records: prov.changed || b.state === "bootstrap" };
}

async function readJson(f, url) {
  const r = await f(url, { headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.json();
}
const commitValue = (v) => (v === null ? null : v === UNREACHABLE ? UNREACHABLE : SHA_RE.test(String(v)) ? v : undefined);

/** One read of every Worker's served commit: { served: { name: sha|null }, unreadable: [reason], notFound: Set of names whose endpoint answered 404 (or sits behind one that did) }. */
export async function readServed(doc, workers, f = globalThis.fetch) {
  const served = {}, unreadable = [], answers = new Map(), notFound = new Set();
  for (const w of workers) {
    const url = buildUrl(doc, w);
    if (!url) { if (!w.behind) unreadable.push(`${w.name}: no build endpoint can be derived (no build URL, and workers_dev needs the top-level workers_dev subdomain)`); continue; }   // never silently skipped (Codex on #148)
    try { const b = await readJson(f, url); answers.set(w.wrangler, b); const c = commitValue(b?.commit); if (c === undefined || c === UNREACHABLE) unreadable.push(`${w.name}: ${url} answered no commit`); else served[w.name] = c; }
    catch (e) { unreadable.push(`${w.name}: ${url} unreadable (${e.message})`); if (e.status === 404) notFound.add(w.name); }
  }
  for (const w of workers.filter((x) => x.behind)) {
    const front = workers.find((x) => x.wrangler === w.behind.worker);
    if (!front || !answers.has(front.wrangler)) { unreadable.push(`${w.name}: behind ${w.behind.worker}, which did not answer`); if (front && notFound.has(front.name)) notFound.add(w.name); continue; }
    const c = commitValue(answers.get(front.wrangler)?.services?.[w.behind.role]?.commit);
    if (c === undefined || c === UNREACHABLE) unreadable.push(`${w.name}: ${front.name}'s /api/build has no reachable services.${w.behind.role}`); else served[w.name] = c;
  }
  return { served, unreadable, notFound };
}

/** Per Worker name: the commit its public /api/build serves (a sha), when it serves one; nothing else is evidence of anything. */
export async function servedCommits(doc, workers, f = globalThis.fetch) {
  const { served } = await readServed(doc, workers, f);
  return Object.fromEntries(Object.entries(served).filter(([, c]) => SHA_RE.test(String(c))));
}

/** Every Worker against `commit`: drift = a commit was read and it is another one (or none); unreadable = an endpoint could not be read. */
export async function verify(root, { doc, workers, commit, fetch: f = globalThis.fetch, attempts = 1, waitMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!SHA_RE.test(commit || "")) return { problems: [`the expected commit "${commit}" is not a full sha`], drift: false, unreadable: true };
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(waitMs);
    const { served, unreadable } = await readServed(doc, workers, f);
    const wrong = Object.entries(served).filter(([, c]) => c !== commit).map(([w, c]) => `${w}: serves ${c ?? "(no commit: deployed outside the production workflow)"}, not ${commit}`);
    const missing = workers.filter((w) => !(w.name in served) && !unreadable.some((u) => u.startsWith(`${w.name}:`))).map((w) => `${w.name}: no build endpoint declared`);
    last = { problems: [...wrong, ...unreadable, ...missing], drift: wrong.length > 0, unreadable: unreadable.length + missing.length > 0, served };
    if (!last.problems.length) return last;
  }
  return last;
}

/** Bootstrap can never be claimed while a Worker serves a build (read with no credential: the drift workflow's daily proof). */
export async function bootstrapLie(doc, workers, f = globalThis.fetch) {
  if (doc.state !== "bootstrap") return null;
  const { served } = await readServed(doc, workers, f);
  const live = Object.entries(served).filter(([, c]) => c);
  return live.length ? `release.json says bootstrap, but ${live.map(([w, c]) => `${w} serves ${c.slice(0, 12)}`).join(", ")}: production exists, so the state is ready and the drills are strict` : null;
}

/** One ordered release transaction: media must be populated before monitoring
 * or R2 restore drills assess it. Stable within phases; never drops a drill. */
export function plannedDrills(items) {
  return [...items.filter((d) => d.kind === "publish"), ...items.filter((d) => d.kind !== "publish")];
}

/** The drills asked for (none | restore | alert | publish | all); in bootstrap, all of them. Each is recorded; a failed one fails the run. */
export async function drills(root, { kit, requested = "none", run, env = {}, now = () => new Date(), log = console.log }) {
  const { doc, problems } = loadRelease(root, kit);
  if (!doc) fail(problems.map((p) => `${p.file}: ${p.problem}`).join("; "));
  let id;
  try { id = releaseIdentity(doc, env, kit); } catch (e) { fail(e.message); }   // main only, the registered repository only, the deployer only in central mode: like ship
  if (!["none", "restore", "alert", "publish", "all"].includes(requested)) fail(`--requested must be none, restore, alert, publish or all (got ${requested})`);
  const all = doc.state === "bootstrap";
  // T=0 bootstrap cannot monitor an empty media archive. First seed every
  // declared series with verified publish evidence, then run alert/restore
  // checks. Keep original order within both phases and always fail closed.
  const list = plannedDrills((doc.drills || []).filter((d) => all || requested === "all" || requested === d.kind));
  if (all && !list.length) fail("bootstrap: release.json declares no drill, so the first deploy would leave resilience unproven");
  const receipt = all ? readJsonIf(root, BOOTSTRAP_RECEIPT) : null;
  if (all && !receipt?.eligible) fail(`bootstrap drills without a receipt proving no production run had deployed (${BOOTSTRAP_RECEIPT}): kit release ship writes it first`);
  const date = now().toISOString().slice(0, 10), done = [];
  for (const d of list) {
    const proof = d.proof ? d.proof.replaceAll("{date}", date).replaceAll("{run}", String(env.GITHUB_RUN_ID || "local")) : null;
    if (proof && /[{}]/.test(proof)) fail(`drill ${d.kind}:${d.subject}: proof ${d.proof} has a placeholder other than {date} and {run}`);
    const code = await run(d.run, { KIT_DRILL_PROOF: proof ?? "", KIT_DRILL_DATE: date, KIT_DRILL_KIND: d.kind, KIT_DRILL_SUBJECT: d.subject });
    if (!proof || !existsSync(join(root, proof))) fail(`drill ${d.kind}:${d.subject} wrote no proof file (${proof ?? "release.json drills[].proof is not set"})`);
    recordDrill(root, "resilience.json", { kind: d.kind, subject: d.subject, date, result: code === 0 ? "pass" : "fail", proof });
    log(`${code === 0 ? "ok" : "FAILED"} drill ${d.kind}:${d.subject} (recorded)`);
    if (code !== 0) fail(`drill ${d.kind}:${d.subject} failed (exit ${code}); recorded as fail`);
    done.push(`${d.kind}:${d.subject}`);
  }
  if (all) {
    writeJson(root, BOOTSTRAP_RECEIPT, { ...receipt, deployed_commit: id.commit, drills: done });
    const raw = JSON.parse(readFileSync(join(root, "release.json"), "utf8"));
    writeJson(root, "release.json", { ...raw, state: "ready" });
    log("bootstrap complete: release.json state is ready (the records pull request commits it)");
  }
  return { drills: done, records: done.length > 0 };
}
