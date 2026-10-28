/**
 * @saasreport/cli — `kit`: init, check, plan, render, publish, status, migrate, deploy, purge, site, plugin, diagrams, widgets, decide, sdk, persian.
 *   main(argv, io?) → exit code. `io` ({ cwd, env, out, err, fetch, spawn }) is injectable for tests.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs, CliError, CLI_BOOLEAN } from "./args.js";
import { CLI_VERSION } from "./paths.js";
import { commandEntry } from "./commands/table.js";
import { init } from "./commands/init.js";
import { check } from "./commands/check.js";
import { plan } from "./commands/plan.js";
import { render } from "./commands/render.js";
import { publish, status } from "./commands/admin.js";
import { migrate, deploy } from "./commands/wrangler.js";
import { site } from "./commands/site.js";
import { purge } from "./commands/purge.js";
import { plugin } from "./commands/plugin.js";
import { diagrams } from "./commands/diagrams.js";
import { widgets } from "./commands/widgets.js";
import { vendor } from "./commands/vendor.js";
import { source } from "./commands/source.js";
import { decide } from "./commands/decide.js";
import { podcast } from "./commands/podcast.js";
import { migrations } from "./commands/migrations.js";
import { sdk } from "./commands/sdk.js";
import { claude } from "./commands/claude.js";
import { agentGuard } from "./commands/agent-guard.js";
import { persian } from "./commands/persian.js";
import { concepts } from "./commands/concepts.js";
import { shariah } from "./commands/shariah.js";
import { ledger } from "./commands/ledger.js";
import { trust } from "./commands/trust.js";
import { docs } from "./commands/docs.js";
import { resilience } from "./commands/resilience.js";
import { release } from "./commands/release.js";
import { comms } from "./commands/comms.js";
import { ci } from "./commands/ci.js";

export { parseArgs, CliError } from "./args.js";
export { parseToml } from "./toml.js";
export { loadProject, runtime, readWrangler } from "./project.js";

export const COMMANDS = { init, check, plan, render, publish, status, migrate, deploy, purge, site, plugin, diagrams, widgets, vendor, source, decide, sdk, podcast, migrations, claude, "agent-guard": agentGuard, persian, concepts, shariah, ledger, trust, docs, resilience, release, comms, ci };
const BOOLEAN = CLI_BOOLEAN;

export const HELP = `kit ${CLI_VERSION} — a self-hosted publishing site on Cloudflare

Usage: kit <command> [options]

  init [dir] [--locale en|fa] [--locales en,ar] [--name n] [--link]
                                                    new site from the starter template (+ client assets);
                                                    --locales: bilingual, the first locale at /, the other at /<locale>/
  check                                             validate kit.config.js and the content pack (every locale)
  check canon [--only schemas,contracts,…] [--json] the constitution (docs/CONSTITUTION.md) against kit.canon.json:
                                                    schemas, contracts, sdk, hardcoding (+ canon.allow.json), freshness, diagrams,
                                                    digits, persian, vendor, spelling (en-GB), tokens, claude, resilience, release
  check staleness [--json] [--alert] [--report f] [--local [--registry f]]
                                                    nothing stale (docs/FRESHNESS.md): a branch behind main, a vendored kit behind the kit's head,
                                                    a registry fact past its max age, toolchain drift, a deploy behind main (kit.staleness-report.v1)
  check schemas|contracts|sdk|hardcoding|freshness|diagrams|digits|persian|vendor|spelling|tokens|claude|enforcement|resilience|release|findings
                                                    one canon check
  comms check [--config f] [--site f] [--forms f]    the build gate of form coverage (docs/FORMS.md): every form the site posts
                                                    (lead forms, events.rsvpForm) is declared in the comms config
  comms secrets [--config f] [--require-value]       the deploy gate of form notifications (docs/FORMS.md): the comms-engine Worker
                                                    holds forms.owner.secret, and its deploy value is the project's own info@
  resilience check|record-drill|watch|keepalive|secrets|report|canary
                                                    monitors, routes, dead-man, backups and drills from resilience.json (docs/RESILIENCE.md);
                                                    watch/keepalive: the scheduled independent watcher; secrets: the deploy gate (names only)
  release check|build|ship|verify|drills|workers|head-check|deployer-check|review-marker|records|status-url the one production workflow's steps from release.json (docs/RELEASE.md): the one build sealed
                                                    before the tests, ship (CI only), verify every Worker's /api/build, drills, bootstrap → ready
  check persian [--json]                            the project's Persian copy and podcast scripts against the Persian rule
                                                    pack (persian.config.json; docs/PERSIAN.md): errors fail, warnings listed
  check fa-review                                   the deploy gate: Persian copy changed since a native reader approved it
                                                    (fa-review.json) does not publish
  persian fix [--write] [--log f.json] [files…]     apply the safe typography fixes (ZWNJ, ی/ک, punctuation) to the sources
  persian review                                    each Persian source's review state (approved, baseline, changed, new)
  persian approve --by <name> --key <pem> files…    a native reader signs the current text of the named files (own encrypted key, terminal passphrase)
  persian baseline                                  create the ledger: files live before the gate, unsigned (once)
  persian migrate                                   the old fa-review.json to the approval ledger, in place (changed copy stays pending)
  persian reject|withdraw --by <name> --key <pem> files…   a native reader signs a rejection or a withdrawal of the named files
  concepts status|schedule|script|verify              a concept series (docs/CONCEPTS.md): counts, held concepts and the runway; APPEND the next
                                                    eligible concepts to the schedule (--write); a concept's script and article; re-check quotes
  check concepts [--history] [--runway]             concepts.config.json, the catalogue, the schedule (append-only with --history),
                                                    the runway (--runway): the format and size of every episode, sources and accuracy
  shariah init|review|approve|reject|withdraw       the signed approval ledger of Shariah content: a qualified reviewer signs with their own Ed25519 key;
                                                    nothing unapproved is scheduled. The AI never signs off and issues no fatwa
  ledger keygen --out <file> | verify <shariah|persian|uploads> | roster add|remove <kind> | witness-sql | witness-bootstrap
                                                    a new approver key (private key outside any git work tree) and its public key for the roster
  trust propose|body|attach|verify|signer-hash                       the owner-signed trust record (who may approve what), verified against the owner's GitHub SSH signing keys
  check shariah-review                              the deploy gate: everything kit check concepts proves, the ledger's git history, and every scheduled
                                                    concept signed-approved at its current text
  podcast migrate [--check]
                                                    append-only D1 provenance triggers: a NEW numbered migration when the schema or origins change
  podcast drill --series <id> [--at <ISO>] [--proof <file>]
                                                    the publish drill: today's episode generated in dry mode through the project's Worker and its
                                                    scheduled handler on a fresh local D1; asserts row, audio, feed item and page; writes the proof
  migrations sync [--check]                         append the migrations of every kit engine a Worker runs (comms, monitor, ...) that no D1 binding of it applies
  check migrations                                  every migrations/*.sql run in order on a fresh local D1 per binding, under D1's limits
  check podcast                                     podcast.config.json (voices, pacing, schedule, covers), the cron, the provenance
                                                    trigger and no hand-added episode files: the t=0 rule for podcasts
  plan [--from YYYY-MM-DD] [--days 371] [--out agenda.md] [--json]
                                                    dry run of everything the cron publishes → agenda.md
  render <series> <ref> [--speakable] [--json]      print an episode script and its estimated duration (--locale ar)
  publish <series> <ref> [--force] [--dry-run]      queue an episode on the live site (admin API)
  status [slug] [--json]                            episodes and their states on the live site
  migrate [--remote] [--dry-run]                    wrangler d1 migrations apply (local by default)
  deploy [--env name] [--dry-run]                   check, refresh client assets, wrangler deploy
  purge [--files <url,…>] [--dry-run]               purge the Cloudflare cache of site.url's zone after a deploy
                                                    (everything by default; --files: only those URLs or paths)
  site build [--config site.config.js] [--out site] [--check]
                                                    landing, inner pages, scripts and theme CSS per locale
  site check [--config site.config.js]              validate the site project (tokens, locales, content, pages)
  site shell|shell-qa|contrast-qa|visual-qa|search-qa
                                                    the rendered gates of a built site: the shell, contrast below WCAG AA,
                                                    visual QA at phone and desktop sizes, the global search (Playwright)
  plugin new <prefix> --skills <prefix>-a,<prefix>-b [--mcp name=url | --api url] [--dir plugins/<prefix>]
                                                    agent plugin: skills writing ./<prefix>-out/<skill>/<run-id>/
                                                    + compile-report.json (confirmed / not_confirmed / flagged)
  plugin check [dir] [--prefix p] [--server name=url]
                                                    validate a plugin (manifest, skills, prefixes, MCP, runtime)
  diagrams theme                                    rewrite every diagram to the theme of its header's project (own docs/diagrams/theme.init, or a vendored one)
  diagrams derive [--config site.config.js] [--project key] [--check]
                                                    write docs/diagrams/theme.init (with its project declaration) from the site project's brand tokens
  diagrams themes [--check]                         fail when a vendored organisation theme differs from its recorded git blob id
  diagrams themes --sync <key> --from <file> --repo <o/r> --path <p> --commit <sha> [--via copy|derive] [--fonts-dir d]
                                                    refresh one vendored organisation theme, its fonts and its provenance record
  diagrams render [files…] [--all] [--mermaid p] [--chromium p] [--playwright dir]
                                                    theme, write the lineage graph + index from the headers, render stale .mmd
                                                    files to PNGs stamped with source hash and id (local Chromium)
  diagrams render --file <x.mmd> --out <dir> [--project p]
                                                    a diagram outside docs/diagrams (a scratch deliverable): same theme, header check, gates, stamp
  diagrams migrate [--project key] [--out file]     PROPOSE only: a worklist of diagrams without a header (writes none; --out outside the repo)
  diagrams check [--project key]                    fail when a diagram is off the brand theme, a PNG is older than its source, or the
                                                    lineage rule is broken (header, duplicate id, dangling reference, cycle, depicts path)
  docs export-view <file.md> --out <dir> [--base-url url]
                                                    self-contained copy of a Markdown file for a viewer that cannot load relative images or
                                                    draw Mermaid (the mobile app): images inlined as data URIs (or URLs for a PR body), each
                                                    Mermaid block kept as image first + collapsed source
  ci unstarted --jobs <jobs.json> --attempt <n> [--out <verdict.json>]
                                                    re-run a failed CI run once when none of its failed jobs ever started (a CI
                                                    provider outage, never a test); a run that ran a step stays red
  ci hold --runs <runs.json> --sha <head sha> --event <event> --run-id <id> [--out <verdict.json>]
                                                    hold a scheduled run whose cause is unchanged: the newest decided run of this
                                                    workflow at the same head failed, so the run is cancelled, not failed and mailed
                                                    again (templates/ci/scheduled-hold.yml)
  widgets build [--spec widgets.spec.json] [--check]
                                                    generate the project's widgets (widgets.generated.json) from its
                                                    spec (audiences, use cases, scenarios) and contracts
  vendor sync --source <kit clone> --commit <sha>  write the vendored kit snapshot (kit.canon.json vendor) and its
                                                    manifest (commit + sha256 per file): no submodule, no credentials
  vendor check                                      fail when a vendored file differs from the manifest
  vendor publish-head                               the kit's CI only: publish kit main's head (kit.kit-head.v1) for vendor-stale
  source init [--path .kit] [--repository url]      the kit at t=0 (docs/FRESHNESS.md): this repository resolves the kit at its head before
                                                    every use and stores nothing of it; writes scripts/kit.mjs, the ignore rule, vendor.mode
  source sync | check | record [--out f]            fetch to the head, verify, install and link (what scripts/kit.mjs does); verify only (the
                                                    t=0 gate, also kit check canon › vendor); the record of the last ensure (kit.kit-source.v1)
  widgets qa <url...> [--widths 390,1280]           layout QA of the generated widgets in a real browser (empty gaps, Playwright)
  widgets check [--spec widgets.spec.json]          fail when a widget has no scenario, a text is not traceable to the
                                                    spec or its sources, another project's words appear, or it is stale
  sdk generate [--target name]                      every OpenAPI contract (kit.sdk.json) → a typed JS client, types, CLI and Python
                                                    client with @saasreport/forge (native Forge), + forge.manifest.json (docs/SDK.md)
  sdk check                                         fail when a contract has no generated SDK, it is stale or hand-edited, or a
                                                    hand-written client duplicates it (also in kit check canon)
  claude sync|check [--check]                       .claude/settings.json cost keys + standard agents from claude.policy.json
                                                    (kit defaults + the project's overrides); never touches foreign keys (docs/COST.md)
  agent-guard sync [--check] | check | coverage [--json] | managed | github verify|apply --repo o/r
                                                    the one constitution registry (constitution.rules.json) -> guard hooks, CLAUDE.md block, ruleset;
                                                    what is forced and what is only text; managed-settings JSON; live ruleset check (docs/AGENT-GUARD.md)
  agent-guard daemon ensure|stop|status | evidence show|verify | decide | audit --base ref | reconcile | identity | bench [--check] [--json] [--only id,id]
                                                    the resident decision daemon; its evidence chain; one decision from stdin; the CI audit; orphans; agent keys;
                                                    the latency budget at every boundary (p50 and the declared tail against the registry's budgets)
  claude policy | budget [--json] | managed         effective policy; loop budget (eval "$(kit claude budget)"); admin-console JSON
  decide --gate <gate|name> --state <file|-> [--config decide.config.json] [--backend name] [--json]
                                                    typed decisions on a small local model (packages/decide): each
                                                    question's choice or "escalate", and whether the big model must read
  decide eval --gate <gate|name> --cases <eval.json> [--backend name] [--limit n] [--out file] [--json]
                                                    accuracy, calibration, coverage, reads avoided, latency

Options: --cwd <dir> (project directory), --config <file> (default kit.config.js), --url <site> (publish/status),
         --locale <code> (plan, render, publish, status: one locale of a multi-locale site),
         --help, --version.
Environment: KIT_ADMIN_TOKEN (publish, status: the Worker's ADMIN_TOKEN), KIT_SITE_URL (default: config site.url),
             CLOUDFLARE_API_TOKEN (purge: Zone.Cache Purge + Zone.Zone Read; never printed).
`;

function defaultIO(overrides = {}) {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    fetch: (...a) => globalThis.fetch(...a),
    spawn: (cmd, args, opts) => new Promise((res) => {
      const child = nodeSpawn(cmd, args, { stdio: "inherit", ...opts });
      child.on("error", (e) => { process.stderr.write(`cannot run ${cmd}: ${e.message}\n`); res(127); });
      child.on("exit", (code) => res(code ?? 1));
    }),
    ...overrides,
  };
}

export async function main(argv = [], ioOverrides = {}) {
  const io = defaultIO(ioOverrides);
  const args = parseArgs(argv, { boolean: BOOLEAN, alias: { h: "help", v: "version", C: "cwd", f: "force" } });
  const [name, ...rest] = args._;
  args._ = rest;
  if (args.flags.version) { io.out(CLI_VERSION); return 0; }
  if (!name || args.flags.help || name === "help") { io.out(HELP); return name || args.flags.help ? 0 : 1; }
  const cmd = COMMANDS[name];
  if (!cmd) { io.err(`unknown command "${name}"\n`); io.err(HELP); return 1; }
  if (args.flags.cwd) io.cwd = resolve(io.cwd, String(args.flags.cwd));
  try {
    // the command table is the one list of subcommands: one it does not name never reaches a dispatcher
    const { subs } = commandEntry(name), sub = args._[0];
    if (subs.length && sub !== undefined && !subs.includes(String(sub))) throw new CliError(`unknown subcommand "${sub}" (one of ${[...new Set(subs)].join(", ")})`, 2);   // a usage error, as a refused flag is
    return await cmd(io, args);
  } catch (e) {
    if (e instanceof CliError) { io.err(`kit ${name}: ${e.message}`); return e.code; }
    io.err(`kit ${name}: ${e?.stack || e}`);
    return 1;
  }
}
