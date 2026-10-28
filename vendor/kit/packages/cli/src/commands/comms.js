/**
 * kit comms check [--config comms.config.js] [--site kit.config.js] [--forms src/forms.js]
 *     the build gate of form coverage (docs/FORMS.md): every form the site posts (the FORMS of its lead-forms module, and
 *     events.rsvpForm when kit.config.js has events.rsvp on) is declared in the comms config, so no submission can be refused as
 *     undeclared. Exit 1 on any gap; a project's `npm test` runs it.
 * kit comms secrets [--config comms.config.js] [--wrangler workers/comms-engine/wrangler.toml] [--require-value]
 *     the deploy gate of the owner's notification (docs/FORMS.md): the comms-engine Worker holds the secret its comms config names in
 *     forms.owner.secret (the owner's recipients, e.g. OPS_NOTIFY_TO). Runs `wrangler secret list` on the engine's wrangler.toml and
 *     compares NAMES only, never values. Exit 1 when it is missing: a project's deploy:comms runs it before `wrangler deploy`, so an
 *     engine that would tell nobody of a submission never ships. When the deploy job's environment holds the secret (it sets the Worker
 *     secret from it), its value must be the project's own info@ (forms.owner.address); --require-value makes its absence a failure.
 *     The value is compared, never printed.
 */
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "../args.js";
import { existsSync } from "node:fs";
import { normalizeConfig } from "@saasreport/cloudflare/config";
import { ownerSecretProblems, requiredEngineSecrets, formCoverageProblems } from "@saasreport/core/form-deliveries";

const exec = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 4 << 20 }, (e, stdout, stderr) => res({ code: e ? (e.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

export async function comms(io, { _: [sub] = [], flags }) {
  if (sub === "secrets") return secrets(io, flags);
  if (sub === "check") return check(io, flags);
  throw new CliError("usage: kit comms check [--config f] [--site f] [--forms f] | kit comms secrets [--config f] [--wrangler f] [--require-value]");
}

const load = async (file) => (await import(pathToFileURL(file).href)).default;

async function check(io, flags) {
  const configFile = resolve(io.cwd, String(flags.config || "comms.config.js"));
  let config;
  try { config = await load(configFile); } catch (e) { io.err(`kit comms check: cannot load ${configFile}: ${e?.message || e}`); return 1; }
  const ids = [];
  const siteFile = resolve(io.cwd, String(flags.site || "kit.config.js"));
  if (flags.site || existsSync(siteFile)) {
    let site;
    try { site = await load(siteFile); } catch (e) { io.err(`kit comms check: cannot load ${siteFile}: ${e?.message || e}`); return 1; }
    // the one shape: the kit Worker's own normaliser, so the defaults (rsvpForm) are the Worker's, never a guess made here
    let ev;
    try { ev = normalizeConfig(site).events; } catch (e) { io.err(`kit comms check: ${siteFile} is not a kit config: ${e?.message || e}`); return 1; }
    if (ev.rsvp) ids.push(ev.rsvpForm);
  }
  const formsFile = resolve(io.cwd, String(flags.forms || "src/forms.js"));
  if (flags.forms || existsSync(formsFile)) {
    let mod;
    try { mod = await import(pathToFileURL(formsFile).href); } catch (e) { io.err(`kit comms check: cannot load ${formsFile}: ${e?.message || e}`); return 1; }
    const forms = mod.FORMS || mod.default;
    if (!forms || typeof forms !== "object") { io.err(`kit comms check: ${formsFile} exports no FORMS (kit.lead-forms.v1)`); return 1; }
    ids.push(...Object.keys(forms));
  }
  const problems = formCoverageProblems(ids, config);
  if (problems.length) { for (const p of problems) io.err(`kit comms check: ${p}`); return 1; }
  io.out(`ok comms check: ${ids.length} site form(s) declared in the comms config${ids.length ? ` (${[...new Set(ids)].join(", ")})` : ""}`);
  return 0;
}

async function secrets(io, flags) {
  const configFile = resolve(io.cwd, String(flags.config || "comms.config.js"));
  const wrangler = String(flags.wrangler || join("workers", "comms-engine", "wrangler.toml"));
  let config;
  try { config = (await import(pathToFileURL(configFile).href)).default; } catch (e) { io.err(`kit comms secrets: cannot load ${configFile}: ${e?.message || e}`); return 1; }
  const need = requiredEngineSecrets(config);
  if (!need.length) { io.out("ok comms secrets: the config declares no form"); return 0; }
  if (!config.forms?.owner?.secret) { io.err("kit comms secrets: the comms config declares forms and no forms.owner.secret (kit.forms-config.v1): every form notifies its owner"); return 1; }
  const run = io.exec || exec;
  const r = await run("npx", ["wrangler", "secret", "list", "--config", wrangler]);
  if (r.code !== 0) { io.err(`kit comms secrets: wrangler secret list failed (${r.code}): ${String(r.stderr).slice(0, 300)}`); return 1; }
  let names;
  try { names = JSON.parse(r.stdout).map((s) => s.name); } catch { io.err("kit comms secrets: wrangler did not answer a JSON list of names"); return 1; }
  const secret = config.forms.owner.secret;
  const value = io.env && Object.hasOwn(io.env, secret) && io.env[secret] !== "" ? io.env[secret] : undefined;
  const problems = ownerSecretProblems(config, names, { value, requireValue: Boolean(flags["require-value"]) });
  if (problems.length) { for (const p of problems) io.err(`kit comms secrets: ${p}`); return 1; }
  io.out(`ok comms secrets: ${config.project}-comms-engine holds ${need.join(", ")}${value !== undefined ? `; the deploy environment's value is ${config.forms.owner.address}` : " (names only)"}`);
  return 0;
}
