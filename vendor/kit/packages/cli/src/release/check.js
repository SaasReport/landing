/**
 * canon check `release` (docs/RELEASE.md): how a repository changes production, proven from its files at t=0. Every problem names the
 * check code it proves; the codes refine the registry rule deploy-through-reviewed-environment (one-owner-address refines
 * alerts-have-recipients, bootstrap-before-first-deploy resilience-proven-by-drills), so the agent context stays one rule. Deterministic: no network (the live half is `kit release verify` and the drift
 * workflow).
 *
 *   one-production-workflow     the production and drift workflows are the kit templates byte for byte (vendor path substituted); nothing
 *                               else deploys: no package.json script, other workflow or composite action runs a deploy, a remote
 *                               migration, a secret write or a purge (the shell deploys of 2026-10-13: deploy:mail with no tests at all)
 *   tested-artefact-deployed    release.json declares the one build and its artefact (the template seals it before the tests and ship
 *                               refuses a changed tree); a build command or a deploy script that rebuilds after the tests is refused
 *   every-worker-released       every Worker config this repository deploys is a release Worker, in an order where a Worker comes after
 *                               every released Worker it binds over a service binding
 *   served-commit-verified      every release Worker answers GET /api/build: its entry module wraps it with withBuild
 *                               (@saasreport/cloudflare/build), and it has a public build URL or a role behind one that has
 *   d1-migrated-before-binders  every D1 a release Worker binds is a release database with at most one migrations directory
 *   health-from-monitor         no source answers /api/health with a constant ok: true (use healthResponse, @saasreport/cloudflare/health)
 *   one-owner-address           the monitor's email recipient and the comms engine's owner secret are both targets of OPS_NOTIFY_TO
 *   drill-proof-in-records      every drill's proof file lies under records.paths (kit.canon.json workflows.ci.records.paths, the list the records
 *                               step commits and the pull_request trigger ignores): a proof outside it is never committed, so its record
 *                               would point at a file no pull request carries
 *   records-check-by-push-event the records pull request's required check is produced by a push (or pull_request) event, never by workflow_dispatch:
 *                               a dispatched run does not satisfy a ruleset's required status check, and a push made with GITHUB_TOKEN starts
 *                               no workflow. So a workflow that opens the records pull request (`gh pr create`) dispatches nothing
 *                               (`gh workflow run`, `workflow_dispatch` API calls), pushes over SSH with RECORDS_DEPLOY_KEY, and the workflow
 *                               named records.workflow lists the records branch pattern in on.push.branches. Read as structure, not text, per JOB
 *                               and by invocation (commandsOf/invocationOf of deployer-check): in the job whose step invokes `gh pr create`, the step
 *                               that invokes `git push` is preceded by an actions/checkout whose with.ssh-key is exactly the RECORDS_DEPLOY_KEY secret
 *                               and which has no token; the push is `git push origin HEAD:refs/heads/<branch>`; no git/curl command in the job names a
 *                               URL, x-access-token, `remote set-url|add` or an extra header option; `gh workflow run` and /dispatches are refused as
 *                               commands (an echo or comment mentioning them is not one)
 *   declared-secrets-written    release.json lists exact released Workers receiving runtime secrets, including secrets not used by monitors;
 *                               the owner recipient is separate and must not be duplicated; `kit release ship` refuses
 *                               before any change when one is absent
 *   bootstrap-before-first-deploy  state bootstrap only before any drill, receipt or deployment, and with a drill command for every drill
 *                               resilience.json requires; state ready leaves the drill rules strict (kit check resilience)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import YAML from "yaml";
import { join } from "node:path";
import { alertVariables } from "@saasreport/channels";
import { githubGlobRe } from "@saasreport/core/schema";
import { recordsConstants } from "./records.js";
import { commandsOf, invocationOf, invokes } from "./deployer-check.js";
import { parseYaml } from "../yaml-lite.js";
import { walk, isTestFile } from "../canon/files.js";
import { deployScan } from "../canon/facts.js";
import { vendorRoots, DEFAULT_VENDOR_PATH } from "../vendor-path.js";
import { readWranglerConfig } from "../wrangler-config.js";
import { RESILIENCE_FILE, activeRoutes, monitorConfig, requiredSecrets } from "../resilience/check.js";
import { publishDrillNeeds } from "../podcast-drill.js";
import { loadRelease, releaseWorkers, registryProject, buildUrl, databaseBindings, migrationsDirFor, readJsonIf, BOOTSTRAP_RECEIPT, OWNER_SECRET } from "./config.js";

export const TEMPLATES = Object.freeze({ workflow: "templates/ci/production.yml", drift: "templates/ci/drift.yml" });
/** Commands that change production: only the production workflow (through `kit release ship|drills`) may run them. */
export const PRODUCTION_COMMAND = /\b(wrangler\s+(deploy|publish|versions\s+deploy|pages\s+deploy|secret\s+(put|bulk|delete)|d1\s+migrations\s+apply\b[^\n]*--remote|d1\s+execute\b[^\n]*--remote)|kit(?:\.js)?\s+(deploy|purge|migrate\b[^\n]*--remote|release\s+(build|ship|drills)))\b/;
/** A build after the tests: npm test (or the canon) and then a build command in the same script. */
const BUILD_AFTER_TEST = /\b(npm\s+(run\s+)?test|kit\s+check\s+canon)\b[\s\S]*?(&&|;)[\s\S]*?\b(npm\s+run\s+(build|stamp|site|prebuild)|kit\s+site\s+build)\b/;
// a constant health answer: the path, then within 400 characters (statements and newlines included, but neither healthResponse nor the next
// route) an ok literal that is constant truthy: true, 1, !0, !!1, quoted or not as a key ("ok": true, ok:!0, ok: 1)
const CONSTANT_HEALTH = /["'`]\/api\/health["'`](?:(?!healthResponse|["'`]\/api\/(?!health["'`]))[\s\S]){0,400}?\bok["']?\s*:\s*(?:true\b|1\b|!0(?![\w.])|!!1\b)/g;
const WITH_BUILD = /\bwithBuild\s*\(/;
const COMMS_ENGINE = /\bcreateCommsEngine\s*\(/;

const P = (rule, file, problem) => ({ file, problem: `${rule}: ${problem}` });
/**
 * What a workflow or composite action does with production credentials (central mode: only the deployer holds them), read from the parsed
 * YAML, never matched as text: a `secrets.NAME` / `secrets['NAME']` reference to any of `names` (case-insensitive: the one source is the
 * release schema's $defs.deployCredentials), a dynamic index (`secrets[env.X]`, `secrets[format(...)]`), the whole context
 * (`toJSON(secrets)`), and a job that passes secrets on (`jobs.*.secrets`: `inherit` or a mapping). `on.workflow_call.secrets` declares names
 * a caller may pass; it is not a use. → [{ line: number|null, use }]
 */
export function deploySecretUses(text, names) {
  const wanted = new Set(names.map((n) => n.toUpperCase()));
  const doc = parseYaml(text);
  const uses = new Map();   // use → needle regexp of the lines that hold it
  const add = (use, needle) => { if (!uses.has(use)) uses.set(use, needle); };
  const scan = (expr) => {
    for (const m of expr.matchAll(/(?<![\w.])secrets\b/gi)) {
      const rest = expr.slice(m.index + m[0].length);
      let a;
      if ((a = /^\s*\.\s*([A-Za-z_][\w-]*)/.exec(rest))) { if (wanted.has(a[1].toUpperCase())) add(`secrets.${a[1]}`, new RegExp(`secrets\\s*\\.\\s*${a[1]}\\b`, "i")); }
      else if ((a = /^\s*\[\s*(['"])([^'"]*)\1\s*\]/.exec(rest))) { if (wanted.has(a[2].toUpperCase())) add(`secrets['${a[2]}']`, new RegExp(`secrets\\s*\\[\\s*['"]${a[2]}['"]`, "i")); }
      else if (/^\s*\[/.test(rest)) add("a dynamic secrets[...] index", /secrets\s*\[\s*[^'"\s]/i);
      else add("the whole secrets context", /(?<![\w.])secrets\b(?!\s*[.[])/i);
    }
  };
  const visit = (v, k) => {
    if (typeof v === "string") { if (k === "if") scan(v); for (const m of v.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) scan(m[1]); }
    else if (Array.isArray(v)) v.forEach((x) => visit(x, k));
    else if (v && typeof v === "object") for (const [kk, x] of Object.entries(v)) visit(x, kk);
  };
  visit(doc);
  for (const job of Object.values(doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {})) if (job && typeof job === "object" && "secrets" in job) add(job.secrets === "inherit" ? "secrets: inherit" : "secrets: (passed to a called workflow)", /^\s*secrets\s*:/);
  const lines = text.split("\n");
  const out = [];
  for (const [use, needle] of uses) {
    const at = lines.map((l, i) => (!l.trim().startsWith("#") && needle.test(l) ? i + 1 : 0)).filter(Boolean);
    if (at.length) for (const line of at) out.push({ line, use }); else out.push({ line: null, use });
  }
  return out;
}

/** The template text as this repository must hold it: the kit's file with the vendored snapshot's path in place of vendor/kit. */
export function templateFor(root, canon, name) {
  const { snapshot } = vendorRoots(canon.vendor);
  const file = join(root, snapshot, TEMPLATES[name]);
  if (!existsSync(file)) return { file: `${snapshot}/${TEMPLATES[name]}`, text: null };
  return { file: `${snapshot}/${TEMPLATES[name]}`, text: readFileSync(file, "utf8").split(`${DEFAULT_VENDOR_PATH}/`).join(`${snapshot}/`) };
}

/** Lines of workflows, composite actions and package.json scripts that change production, outside the production workflow. */
export function productionCommands(root, workflow) {
  const out = [];
  for (const f of walk(root)) {
    if (/^(vendor|\.kit|findings|node_modules)\//.test(f) || f === workflow) continue;   // .kit: the kit's source checkout, not the site's commands
    if (/^\.github\/(workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/.test(f)) {
      for (const l of readFileSync(join(root, f), "utf8").split("\n")) { const t = l.trim(); if (!t.startsWith("#") && PRODUCTION_COMMAND.test(t)) out.push({ file: f, line: t }); }
    }
    if (f.split("/").pop() === "package.json") {
      let pkg; try { pkg = JSON.parse(readFileSync(join(root, f), "utf8")); } catch { continue; /* reported by the schemas and resilience checks */ }
      for (const [k, cmd] of Object.entries(pkg.scripts || {})) if (PRODUCTION_COMMAND.test(String(cmd))) out.push({ file: f, line: `"${k}": ${cmd}`, script: k, cmd: String(cmd) });
    }
  }
  return out;
}

export async function checkRelease(root, canon, kit) {
  const ref = canon.release;
  if (!ref) return { ok: false, configured: false, checked: 0, summary: "NOT CONFIGURED", problems: [] };
  const file = ref.file || "release.json";
  const { doc, problems: lp } = loadRelease(root, kit, file);
  if (!doc) return { ok: false, configured: true, checked: 0, summary: file, problems: lp };
  const problems = [];
  let checked = 0;

  // one-production-workflow: the templates, byte for byte; nothing else changes production. Central mode (deployer) inverts it: the
  // deployer's workflow changes production, so this repository holds no production or drift workflow and no deploy secret at all.
  if (doc.deployer) {
    for (const name of ["workflow", "drift"]) {
      checked++;
      if (existsSync(join(root, doc[name]))) problems.push(P("one-production-workflow", doc[name], `release.json names ${doc.deployer.repository} as the deployer (central mode): this repository holds CI only, so ${doc[name]} must not exist (two deployers of one production)`));
    }
    const credentials = kit.byName("release").$defs.deployCredentials.enum;
    for (const f of walk(root).filter((x) => /^\.github\/(workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/.test(x))) {
      checked++;
      let uses;
      try { uses = deploySecretUses(readFileSync(join(root, f), "utf8"), credentials); } catch (e) { problems.push(P("one-production-workflow", f, `cannot be read (${e.message}): central mode proves from the parsed workflow that it uses no deploy secret`)); continue; }
      for (const u of uses) problems.push(P("one-production-workflow", u.line ? `${f}:${u.line}` : f, `uses ${u.use}: a deploy secret, a dynamic secret index or every secret passed on, although ${doc.deployer.repository} deploys this project (central mode): production credentials live only in the deployer's environment ${doc.deployer.environment}`));
    }
  }
  for (const name of doc.deployer ? [] : ["workflow", "drift"]) {
    checked++;
    const t = templateFor(root, canon, name);
    const have = existsSync(join(root, doc[name])) ? readFileSync(join(root, doc[name]), "utf8") : null;
    if (t.text === null) problems.push(P("one-production-workflow", t.file, "the kit template is not in the vendored snapshot: re-vendor a kit that has it"));
    else if (have === null) problems.push(P("one-production-workflow", doc[name], `missing: copy ${t.file} (the kit's ${name === "workflow" ? "production" : "drift"} workflow) unchanged`));
    else if (have !== t.text) problems.push(P("one-production-workflow", doc[name], `differs from ${t.file}: the ${name === "workflow" ? "production" : "drift"} workflow is the kit's template unchanged (project facts live in release.json); a step added after the tests, a removed guard or drill, or another order is refused`));
  }
  for (const c of productionCommands(root, doc.deployer ? null : doc.workflow)) {
    checked++;
    const untested = c.script && !/\b(npm\s+(run\s+)?test|kit\s+check\s+canon)\b/.test(c.cmd);
    problems.push(P("one-production-workflow", c.file, `${c.line.slice(0, 160)}: changes production outside ${doc.workflow}${untested ? " and without running the tests (a Worker deployed without tests)" : ""}. Production changes only through the production workflow (kit release ship), after the reviewed merge`));
    if (c.script && BUILD_AFTER_TEST.test(c.cmd)) problems.push(P("tested-artefact-deployed", c.file, `"${c.script}" rebuilds after the tests (${c.cmd.slice(0, 120)}): the deployed build is not the tested one`));
  }
  // tested-artefact-deployed: the one build runs before the tests (the template); the build command itself does not run the tests first
  checked++;
  if (BUILD_AFTER_TEST.test(doc.build.run)) problems.push(P("tested-artefact-deployed", file, `build.run "${doc.build.run}" runs the tests and then builds: the template runs the one build, then the tests, then deploys the sealed artefact`));
  for (const a of doc.build.artifact) if (/^(\.|vendor|node_modules|\.git)(\/|$)/.test(a)) problems.push(P("tested-artefact-deployed", file, `build.artifact "${a}" is not a build output`));

  // every-worker-released
  let workers = [];
  try { workers = releaseWorkers(root, doc); } catch (e) { problems.push(P("every-worker-released", file, e.message)); }
  const res = readJsonIf(root, canon.resilience?.file || RESILIENCE_FILE);
  const key = (f, env = "") => `${f}\u0000${env}`;
  const notDeployed = new Set((res?.not_deployed || []).map((x) => key(x.wrangler, x.env)));
  const released = new Set(doc.workers.map((w) => key(w.wrangler, w.env)));
  for (const f of deployScan(root, canon).deployed) {
    let c; try { c = readWranglerConfig(root, f); } catch { continue; /* reported by resilience */ }
    for (const env of Object.keys(c.envs)) { checked++; if (!released.has(key(f, env)) && !notDeployed.has(key(f, env))) problems.push(P("every-worker-released", f, `${env ? `[env.${env}] of ` : ""}this config is deployed by this repository but is not a release.json worker: it would be deployed by hand or not at all`)); }
  }
  for (const id of doc.workers.map((w) => key(w.wrangler, w.env)).filter((k, i, a) => a.indexOf(k) !== i)) problems.push(P("every-worker-released", file, `worker ${id.replace("\u0000", " ")} is listed twice`));
  const order = new Map(workers.map((w, i) => [w.name, i]));
  workers.forEach((w, i) => { for (const s of w.facts.services) if (order.has(s.service) && order.get(s.service) > i) problems.push(P("every-worker-released", file, `${w.name} binds ${s.service} (${s.binding}) but is deployed before it: a Worker comes after every Worker it binds`)); });

  // served-commit-verified
  for (const w of workers) {
    checked++;
    if (!w.entryFile || !existsSync(join(root, w.entryFile))) { problems.push(P("served-commit-verified", w.wrangler, `main ${w.facts.main ?? "(none)"} is not a file in the repository: nothing proves it serves /api/build`)); continue; }
    if (!WITH_BUILD.test(readFileSync(join(root, w.entryFile), "utf8"))) problems.push(P("served-commit-verified", w.entryFile, `the entry of ${w.name} does not wrap its Worker with withBuild (@saasreport/cloudflare/build): GET /api/build would be 404 and nobody could tell which commit is live`));
    if (w.workers_dev && !doc.workers_dev) problems.push(P("served-commit-verified", file, `${w.name} answers on workers.dev but release.json has no workers_dev subdomain`));
    if (w.behind) {
      const front = workers.find((x) => x.wrangler === w.behind.worker);
      if (!front) problems.push(P("served-commit-verified", file, `${w.name} is behind ${w.behind.worker}, which is not a release worker`));
      else if (!front.behind && !buildUrl(doc, front) && !front.build) problems.push(P("served-commit-verified", file, `${w.name} is behind ${front.name}, which has no public build endpoint`));
      else if (front.behind) problems.push(P("served-commit-verified", file, `${w.name} is behind ${front.name}, which is itself behind another: one level, so the verify step reads it directly`));
    }
  }

  // d1-migrated-before-binders
  const binds = databaseBindings(workers);
  const declared = new Set(doc.databases.map((d) => d.name));
  for (const [name, configs] of binds) {
    checked++;
    if (!declared.has(name)) problems.push(P("d1-migrated-before-binders", file, `D1 ${name} is bound by ${configs.map((c) => c.wrangler).join(", ")} but is not a release database: it would never be created or migrated by the run`));
    try { migrationsDirFor(name, configs); } catch (e) { problems.push(P("d1-migrated-before-binders", configs[0].wrangler, e.message)); }
  }
  for (const d of doc.databases) if (!binds.has(d.name)) problems.push(P("d1-migrated-before-binders", file, `database ${d.name} is bound by no release worker (stale)`));

  // health-from-monitor
  for (const f of walk(root)) {
    if (/^(vendor|\.kit|findings|node_modules|sdk)\//.test(f) || isTestFile(f) || !/\.(m?js|cjs|ts)$/.test(f)) continue;
    const text = readFileSync(join(root, f), "utf8");
    if (!text.includes("/api/health")) continue;
    checked++;
    for (const m of text.matchAll(CONSTANT_HEALTH)) problems.push(P("health-from-monitor", `${f}:${text.slice(0, m.index).split("\n").length}`, "/api/health answers a constant ok: true: health must be derived from the monitor (healthResponse, @saasreport/cloudflare/health), or a failing site reports healthy"));
  }

  // one-owner-address: the address is info@<the project's registry domain>, so the project must resolve to one (checked at run time too)
  checked++;
  if (!registryProject(kit, doc.project)?.domain) problems.push(P("one-owner-address", file, `project "${doc.project}" has no domain in the kit project registry: the owner address info@<domain> cannot be derived`));
  const targets = new Set((doc.owner.targets || []).map((t) => key(t.wrangler, t.name)));
  for (const t of doc.owner.targets || []) if (!released.has(key(t.wrangler, ""))) problems.push(P("one-owner-address", file, `owner target ${t.wrangler} is not a release worker`));
  for (const m of res?.monitors || []) {
    if (m.kind !== "worker" || !m.worker) continue;
    for (const r of activeRoutes(res, m)) if (r.channel === "email") {
      const name = alertVariables("email").secrets[0];
      if (!targets.has(key(m.worker.wrangler, name))) problems.push(P("one-owner-address", file, `the monitor ${m.id} emails ${name} on ${m.worker.wrangler}, which is not an owner target: it would diverge from ${OWNER_SECRET} (one address, one source)`));
    }
  }
  for (const w of workers) if (w.entryFile && existsSync(join(root, w.entryFile)) && COMMS_ENGINE.test(readFileSync(join(root, w.entryFile), "utf8")) && !targets.has(key(w.wrangler, OWNER_SECRET))) problems.push(P("one-owner-address", file, `the comms engine ${w.name} holds the owner's recipients in ${OWNER_SECRET} (forms.owner.secret) but is not an owner target`));

  // drill-proof-in-records: the proof is committed by the records step, which commits exactly records.paths
  checked++;
  const records = recordsConstants(root).paths.map(githubGlobRe);
  for (const d of doc.drills || []) {
    const proof = d.proof?.replaceAll("{date}", "2026-01-01").replaceAll("{run}", "1");
    if (proof && !records.some((re) => re.test(proof))) problems.push(P("drill-proof-in-records", file, `drill ${d.kind}:${d.subject} writes its proof to ${d.proof}, which is outside workflows.ci.records.paths: the records step commits only those files, so the proof would never reach the pull request (put it under resilience/drills/, or declare the path in kit.canon.json workflows.ci.records.paths)`));
  }

  // records-check-by-push-event
  checked++;
  problems.push(...recordsCheckProblems(root));

  // declared-secrets-written: explicit runtime secret destinations; owner recipients have a separate authority.
  for (const x of doc.secrets || []) {
    checked++;
    if (!released.has(key(x.wrangler, x.env || ""))) problems.push(P("declared-secrets-written", file, `secrets ${x.name} names ${x.wrangler}${x.env ? ` [env.${x.env}]` : ""}, which is not a release worker`));
    const ownerOnly = new Set([OWNER_SECRET, ...(doc.owner.targets || []).map((t) => t.name)]);
    if (ownerOnly.has(x.name)) problems.push(P("declared-secrets-written", file,
      `secrets ${x.name} is reserved for owner-address delivery and cannot be copied as a runtime secret`));
  }

  // bootstrap-before-first-deploy
  checked++;
  // a daily publishing job is drilled after every deploy that asks for it: a release.json command that actually runs `kit podcast drill` for each
  // daily podcast series is owed in every state (a missing command would make the 30-day drill unobtainable, and the check fail forever)
  const publish = await publishDrillNeeds(root);
  if (publish.problem) problems.push(P("resilience-proven-by-drills", "podcast.config.json", publish.problem));
  for (const id of publish.ids) {
    checked++;
    const cmd = (doc.drills || []).find((d) => d.kind === "publish" && d.subject === id);
    if (!cmd) problems.push(P("resilience-proven-by-drills", file, `no publish drill command for the podcast series ${id}: add { "kind": "publish", "subject": "${id}", "run": "node ${DEFAULT_VENDOR_PATH}/packages/cli/bin/kit.js podcast drill --series ${id}", "proof": "resilience/drills/publish-${id}-{date}.json" } to drills`));
    else if (!new RegExp(`\\bpodcast\\s+drill\\s+--series\\s+${id}\\b`).test(cmd.run)) problems.push(P("resilience-proven-by-drills", file, `the publish drill command for ${id} (${cmd.run}) does not run \`kit podcast drill --series ${id}\`: a drill that does not generate the episode proves nothing`));
    else if (!cmd.proof) problems.push(P("resilience-proven-by-drills", file, `the publish drill ${id} names no proof file (resilience/drills/publish-${id}-{date}.json)`));
  }
  problems.push(...bootstrapProblems(root, doc, res, publish.ids));
  return { ok: !problems.length, configured: true, checked, summary: `${doc.state}: ${workers.length} worker(s), ${doc.databases.length} database(s), ${(doc.drills || []).length} drill command(s)`, problems };
}

/** Why the bootstrap state does not hold ([] in state ready, or when it holds). Shared with kit check resilience (bootstrapOwesDrills). */
export function bootstrapProblems(root, doc, res, publish = []) {
  if (doc.state !== "bootstrap") return [];
  const out = [];
  const receipt = readJsonIf(root, BOOTSTRAP_RECEIPT);
  if (receipt?.deployed_commit) out.push(P("bootstrap-before-first-deploy", BOOTSTRAP_RECEIPT, `records a deployment (${receipt.deployed_commit}): production exists, so the state is ready, forever`));
  if (receipt && receipt.eligible === false) out.push(P("bootstrap-before-first-deploy", BOOTSTRAP_RECEIPT, "records Workers a production run deployed (or that could not be read): bootstrap does not apply"));
  if ((res?.drills || []).length) out.push(P("bootstrap-before-first-deploy", RESILIENCE_FILE, "drills are recorded: production has run, so the state is ready"));
  const have = new Set((doc.drills || []).map((d) => `${d.kind}:${d.subject}`));
  const need = [...(res?.monitors || []).filter((m) => m.kind === "worker").map((m) => `alert:${m.id}`), ...(res?.backups || []).map((b) => `restore:${b.id}`), ...publish.map((id) => `publish:${id}`)];
  for (const n of need) if (!have.has(n)) out.push(P("bootstrap-before-first-deploy", "release.json", `no drill command for ${n}: a bootstrap deploy must run every drill resilience.json requires in the same job`));
  for (const d of doc.drills || []) if (!d.proof) out.push(P("bootstrap-before-first-deploy", "release.json", `drill ${d.kind}:${d.subject} names no proof file`));
  return out;
}

/** For kit check resilience: true when a missing drill is owed by a valid bootstrap (the first production run performs it), never otherwise. */
export function bootstrapOwesDrills(root, canon, kit, res, publish = []) {
  if (!canon.release) return false;
  const { doc } = loadRelease(root, kit, canon.release.file || "release.json");
  return Boolean(doc && doc.state === "bootstrap" && !bootstrapProblems(root, doc, res, publish).length);
}

const GH_PR_CREATE = /^gh\s+pr\s+create(?:\s|$)/;
const GH_DISPATCH = /^gh\s+workflow\s+run(?:\s|$)/;
const GIT_PUSH_BRANCH = /^git\s+push\s+origin\s+"?HEAD:refs\/heads\/[^\s"]+"?(?:\s+#.*)?$/;
const TOKEN_PUSH_PATH = /x-access-token|\bremote\s+(?:set-url|add)\b|extraheader|https?:\/\/\S*github\.com/i;
/** records-check-by-push-event: see the header. Reads every workflow of the repository with the `yaml` parser. */
function recordsCheckProblems(root) {
  const out = [];
  const c = recordsConstants(root);
  const dir = join(root, ".github/workflows");
  const wfs = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => {
    let doc = null;
    try { doc = YAML.parse(readFileSync(join(dir, f), "utf8")); } catch { /* unreadable: kit check canon's other gates report it */ }
    return { file: `.github/workflows/${f}`, doc };
  }) : [];
  for (const { file, doc } of wfs) {
    // the proof is read per JOB, by invocation (commandsOf/invocationOf, as deployer-check reads a step): the job whose step invokes `gh pr create`
    for (const [jobId, job] of Object.entries(doc?.jobs || {})) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      if (!steps.some((s) => invokes(s, GH_PR_CREATE))) continue;
      const where = `${file} job ${jobId}`;
      const cmds = steps.flatMap((s) => commandsOf(s.run).map((c) => ({ s, c, inv: invocationOf(c) })));
      for (const { c, inv } of cmds) if (GH_DISPATCH.test(inv) || (/^(?:gh|curl)\b/.test(inv) && /\/dispatches\b/.test(c))) out.push(P("records-check-by-push-event", where, `the job that opens the records pull request dispatches a run (${c}): a workflow_dispatch run does not satisfy a ruleset's required status check, so the pull request could never merge; the check comes from the push of the records branch`));
      for (const { c, inv } of cmds) if (TOKEN_PUSH_PATH.test(c) && /^(?:git|curl)\b/.test(inv)) out.push(P("records-check-by-push-event", where, `the job reroutes git to a token or URL (${c}): a push made with GITHUB_TOKEN starts no workflow, so the records branch would have no required check; the only push is \`git push origin HEAD:refs/heads/<branch>\` over the ssh remote the deploy-key checkout configured`));
      const pushAt = steps.findIndex((s) => commandsOf(s.run).some((c) => /^git\b.*\bpush\b/.test(invocationOf(c))));
      if (pushAt < 0) { out.push(P("records-check-by-push-event", where, "the job opens the records pull request but no step invokes `git push`: the records branch must be pushed by the deploy key so its required check runs")); continue; }
      for (const c of commandsOf(steps[pushAt].run)) if (/^git\b.*\bpush\b/.test(invocationOf(c)) && !GIT_PUSH_BRANCH.test(invocationOf(c))) out.push(P("records-check-by-push-event", where, `the push is \`${c}\`, not \`git push origin HEAD:refs/heads/<branch>\`: any URL, token or option other than the ssh remote origin starts no workflow`));
      // the checkout of THIS repository (a checkout of another repository into a path, the kit at .kit for one, is not the workspace the push is made from)
      const ck = steps.slice(0, pushAt).findLast((s) => /^actions\/checkout@/.test(String(s.uses ?? "")) && !("repository" in (s.with || {})));
      if (!ck || ck.with?.["ssh-key"] !== "${{ secrets.RECORDS_DEPLOY_KEY }}" || "token" in (ck.with || {})) out.push(P("records-check-by-push-event", where, "the step before the push does not check out with `ssh-key: ${{ secrets.RECORDS_DEPLOY_KEY }}` (and no `token`): a push made with GITHUB_TOKEN starts no workflow, so the records branch would have no required check"));
    }
  }
  const tested = wfs.filter((w) => w.doc?.name === c.workflow);
  const pattern = `${c.branch_prefix}**`;
  if (wfs.some((w) => w.doc && Object.values(w.doc.jobs || {}).some((j) => (j?.steps || []).some((s) => invokes(s, GH_PR_CREATE)))) && !tested.some((w) => (w.doc?.on?.push?.branches || []).includes(pattern))) out.push(P("records-check-by-push-event", ".github/workflows", `no workflow named ${c.workflow} lists ${pattern} in on.push.branches: the push of the records branch must run it, or the records pull request has no required check`));
  return out;
}
