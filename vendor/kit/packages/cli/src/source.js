/**
 * The kit at t=0 (docs/FRESHNESS.md): a site resolves the kit at its head before every use and stores nothing of it. The one
 * implementation is the bootstrap the site commits, templates/site/scripts/kit.mjs (zero dependencies); this module imports it for
 * `kit source` and for the canon's vendor check in source mode, and adds what only the kit can judge: that the site's bootstrap is the
 * template byte for byte, that the checkout is ignored, and that no file: dependency on a snapshot is left in package.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SOURCE_PATH, DEFAULT_VENDOR_PATH, isSourceMode, kitLocation } from "./vendor-path.js";
import { KIT_REPOSITORY } from "./vendor.js";
import { SourceError, ensure, sourceConfig, verify } from "./source-bootstrap.mjs";

export { SourceError, ensure, sourceConfig, verify };
export const BOOTSTRAP = "scripts/kit.mjs";
export const TEMPLATE = fileURLToPath(new URL("./source-bootstrap.mjs", import.meta.url));   // the implementation; templates/site/scripts/kit.mjs is its generated copy
export const bootstrapText = () => readFileSync(TEMPLATE, "utf8");
const P = (file, problem) => ({ file, problem });

/** What a site in source mode must hold besides the checkout, as problems: the bootstrap, the ignore rule, no snapshot dependency, no snapshot left. */
export function siteProblems(root, cfgIn) {
  const problems = [];
  const cfg = kitLocation(cfgIn);
  if (cfg.path !== DEFAULT_SOURCE_PATH) problems.push(P("kit.canon.json", `vendor.path is ${JSON.stringify(cfg.path)}: in source mode the checkout lives at ${DEFAULT_SOURCE_PATH}, the one path the templates check out to and every scanner leaves out`));
  const b = join(root, BOOTSTRAP);
  if (!existsSync(b)) problems.push(P(BOOTSTRAP, "missing: the bootstrap that resolves the kit at its head before every use (kit source init writes it)"));
  else if (readFileSync(b, "utf8") !== bootstrapText()) problems.push(P(BOOTSTRAP, "differs from the kit's templates/site/scripts/kit.mjs: the bootstrap is generated, never edited; run kit source init to rewrite it"));
  const gi = join(root, ".gitignore");
  const ignored = existsSync(gi) && readFileSync(gi, "utf8").split("\n").map((l) => l.trim()).some((l) => l === `${cfg.path}/` || l === cfg.path || l === `/${cfg.path}/` || l === `/${cfg.path}`);
  if (!ignored) problems.push(P(".gitignore", `does not ignore ${cfg.path}/: the checkout of the kit is never committed`));
  const pj = join(root, "package.json");
  if (existsSync(pj)) {
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) for (const [name, spec] of Object.entries(pkg[k] ?? {})) {
      if (name.startsWith("@saasreport/") || /^file:.*(vendor\/kit|\.kit)/.test(String(spec))) problems.push(P("package.json", `${k}.${name} = ${JSON.stringify(spec)}: in source mode the kit's packages come through node_modules/@saasreport, linked by the bootstrap, never through a file: dependency; remove it and run npm ci`));
    }
  }
  if (cfg.path !== DEFAULT_VENDOR_PATH && (existsSync(join(root, DEFAULT_VENDOR_PATH)) || existsSync(join(root, `${DEFAULT_VENDOR_PATH}.manifest.json`)))) problems.push(P(DEFAULT_VENDOR_PATH, "a vendored snapshot (or its manifest) is still here beside the source: delete it, the kit is resolved at its head"));
  return problems;
}

/**
 * `kit source init`: turn a repository to source mode. Writes the bootstrap, the ignore rule and kit.canon.json's vendor block
 * ({ mode: "source", path, transport (archive, the default: no credential), repository }), and reports what the owner's commit must still do (delete the snapshot, drop the file:
 * dependencies, point scripts at the bootstrap). Returns { written: [...], next: [...] }.
 */
export function initSource(root, { path = DEFAULT_SOURCE_PATH, repository, transport = "archive", head } = {}) {
  const written = [], next = [];
  const canonFile = join(root, "kit.canon.json");
  if (!existsSync(canonFile)) throw new SourceError("kit.canon.json is missing: a repository without a canon cannot hold the kit");
  const canon = JSON.parse(readFileSync(canonFile, "utf8"));
  const before = canon.vendor;
  const vendor = { mode: "source", path, transport };
  if (repository && repository !== KIT_REPOSITORY) vendor.repository = repository;
  if (head) vendor.head = head;
  if (JSON.stringify(before) !== JSON.stringify(vendor)) {
    canon.vendor = vendor;
    if (canon.notApplicable?.vendor) delete canon.notApplicable.vendor;
    writeFileSync(canonFile, `${JSON.stringify(canon, null, 2)}\n`);
    written.push("kit.canon.json");
  }
  const b = join(root, BOOTSTRAP);
  if (!existsSync(b) || readFileSync(b, "utf8") !== bootstrapText()) { mkdirSync(dirname(b), { recursive: true }); writeFileSync(b, bootstrapText()); written.push(BOOTSTRAP); }
  const gi = join(root, ".gitignore");
  const lines = existsSync(gi) ? readFileSync(gi, "utf8").split("\n") : [];
  if (!lines.map((l) => l.trim()).some((l) => l === `${path}/` || l === path || l === `/${path}/` || l === `/${path}`)) {
    const text = (existsSync(gi) ? readFileSync(gi, "utf8").replace(/\n?$/, "\n") : "") + `# the kit at its head, resolved by scripts/kit.mjs before every use (docs/FRESHNESS.md): never committed\n${path}/\n`;
    writeFileSync(gi, text);
    written.push(".gitignore");
  }
  if (before && !isSourceMode(before)) next.push(`delete the snapshot ${kitLocation(before).path}/ and its manifest: the kit is resolved at its head now`);
  const pj = join(root, "package.json");
  if (existsSync(pj)) {
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    const kitDeps = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {}).filter((n) => n.startsWith("@saasreport/")).map((n) => `${k}.${n}`));
    if (kitDeps.length) next.push(`remove the kit's packages from package.json (${kitDeps.join(", ")}) and run npm ci: node_modules/@saasreport and node_modules/.bin/kit are links the bootstrap makes`);
    const scripts = Object.entries(pkg.scripts ?? {}).filter(([, s]) => /(^|[\s&;|(])kit\s/.test(String(s)) && !String(s).includes(BOOTSTRAP));
    if (scripts.length) next.push(`start every npm script that runs the kit with "node ${BOOTSTRAP} ..." (${scripts.map(([n]) => n).join(", ")}): the first use in a run resolves the kit at its head; later uses in the same script may call kit through node_modules/.bin`);
  }
  next.push(`in every workflow, run the kit as "node ${BOOTSTRAP} <command>" after npm ci (templates/ci/*.yml show it): the bootstrap fetches the published archive of the kit's head with no credential, so no checkout step and no secret is needed; delete any kit checkout step and KIT_SOURCE_KEY a workflow still carries`);
  return { written, next };
}

/** A workflow text without the kit-checkout step the templates carry (the kit itself is the kit: it checks out none). */
export function stripKitCheckout(text) {
  const lines = text.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- name: "the kit at its head \(t=0/.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }
    const indent = m[1];
    i++;
    while (i < lines.length && lines[i].startsWith(`${indent}  `)) i++;
    i--;
  }
  return out.join("\n");
}
