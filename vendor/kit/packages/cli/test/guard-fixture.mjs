// Test helper: give a fixture repository the enforcement every repository now carries (docs/AGENT-GUARD.md): the guard pack (copied from the
// kit's own sources, as `kit vendor sync` would), the installed hooks, a workflow that runs npm test on pull requests, a test script that
// runs the canon first, and CODEOWNERS for the enforcement files.
import { cpSync, symlinkSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_PROJECT, syncGuard } from "../src/agent-guard/install.js";
import { isSourceMode, vendorRoots } from "../src/vendor-path.js";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { useHeadDoc } from "./support/head-doc.mjs";

const KIT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const WORKFLOW = "name: test\non:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n  push:\n    branches: [main, 'resilience-records/**']\n  workflow_dispatch:\nconcurrency:\n  group: test-${{ github.run_id }}\n  cancel-in-progress: true\njobs:\n  test:\n    name: test (ubuntu-24.04)\n    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    steps:\n      - run: npm ci\n      - run: npm test\n      - run: kit agent-guard bench --check\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.base_ref }}\n          path: base\n      - run: node base/packages/cli/bin/kit.js agent-guard audit --base origin/main\n";

export function installGuard(root, { mode = "snapshot" } = {}) {
  // a site runs the guard from where kit.canon.json vendor.path says, never from the repository root: its snapshot (mode snapshot, post-facto,
  // kept here for the tests of that mode) or its checkout of the kit at its head (mode source, the kit at t=0: docs/FRESHNESS.md)
  let canon0 = JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8"));
  if (mode === "source" && canon0.project !== KIT_PROJECT) {
    const { notApplicable = {}, ...rest } = canon0; delete notApplicable.vendor;
    canon0 = { ...rest, vendor: { mode: "source", path: ".kit", transport: "git", repository: pathToFileURL(join(root, ".kit")).href }, ...(Object.keys(notApplicable).length ? { notApplicable } : {}) };
    writeFileSync(join(root, "kit.canon.json"), `${JSON.stringify(canon0, null, 2)}\n`);
  }
  const base = canon0.project === KIT_PROJECT ? root : join(root, vendorRoots(canon0.vendor).snapshot);
  cpSync(join(KIT, "packages/cli/src"), join(base, "packages/cli/src"), { recursive: true });
  cpSync(join(KIT, "packages/core/registry"), join(base, "packages/core/registry"), { recursive: true });
  // the copied kit imports its workspace packages (@saasreport/core, web-tree-sitter): resolve them from this checkout's node_modules, as an installed repository would
  if (!existsSync(join(root, "node_modules"))) symlinkSync(join(KIT, "node_modules"), join(root, "node_modules"), "dir");
  for (const p of ["sdk", "monitor"]) if (!existsSync(join(base, "packages", p))) symlinkSync(join(KIT, "packages", p), join(base, "packages", p), "dir");
  if (base !== root && isSourceMode(canon0.vendor)) {
    // the kit at t=0: the checkout is a git repository whose origin is itself (a file: URL), its registry names a published head on disk, and the
    // head is the checkout's HEAD; the site holds the bootstrap and ignores the checkout (what kit source init writes)
    const headDoc = join(root, ".kit-head.json");
    writeFileSync(join(base, "packages/core/registry/kit-head.json"), `${JSON.stringify({ bucket: "fixture", key: "kit-main.json", url: pathToFileURL(headDoc).href, recent: 300 })}\n`);
    writeFileSync(join(base, ".gitignore"), "node_modules/\n");
    const g = (...a) => execFileSync("git", ["-C", base, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-qm", "the kit at its head (fixture)");
    g("remote", "add", "origin", canon0.vendor.repository);
    const sha = g("rev-parse", "HEAD");
    writeFileSync(headDoc, `${JSON.stringify({ v: 1, repository: "https://github.com/SaasReport/kit", ref: "main", sha, date: g("show", "-s", "--format=%cI", "HEAD"), recent: [{ sha }] })}\n`);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/kit.mjs"), readFileSync(join(KIT, "packages/cli/src/source-bootstrap.mjs"), "utf8"));
    const gi = join(root, ".gitignore");
    writeFileSync(gi, `${existsSync(gi) ? readFileSync(gi, "utf8").replace(/\n?$/, "\n") : ""}.kit/\n.kit-head.json\n`);
  }
  // a site's snapshot is configured and proven: kit.canon.json vendor, and a manifest that names every file of it (what kit vendor sync writes)
  if (base !== root && !isSourceMode(canon0.vendor)) {
    const snap = vendorRoots(canon0.vendor).snapshot, files = [];
    // the same walk kit vendor check makes (it follows links, as statSync does)
    const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else { const b = readFileSync(f); files.push({ path: relative(base, f).split("\\").join("/"), sha256: createHash("sha256").update(b).digest("hex"), bytes: b.length }); } } };
    walk(base);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = { $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/vendor-manifest.schema.json", path: snap,
      source: { repository: "https://github.com/SaasReport/kit", ref: "main", commit: "0".repeat(40), commit_date: "2026-10-09T00:00:00.000Z" }, include: ["packages"], generated_by: "kit vendor sync", files };
    useHeadDoc("0".repeat(40));   // the snapshot is current against a head from a file: the test run has no network
    writeFileSync(join(root, `${snap}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    const { notApplicable = {}, ...rest } = canon0; delete notApplicable.vendor;
    writeFileSync(join(root, "kit.canon.json"), `${JSON.stringify({ ...rest, vendor: { path: snap, include: ["packages"] }, ...(Object.keys(notApplicable).length ? { notApplicable } : {}) }, null, 2)}\n`);
  }   // the CLI imports these two siblings by path
  // the copied sources carry the kit's own reviewed finding allowances (canon.allow.json, category finding:*): the fixture repository's gate must see the same
  const allowFile = join(root, "canon.allow.json");
  if (existsSync(allowFile)) {
    const mine = JSON.parse(readFileSync(allowFile, "utf8")), kit = JSON.parse(readFileSync(join(KIT, "canon.allow.json"), "utf8"));
    mine.entries = [...(mine.entries || []), ...kit.entries.filter((e) => e.category.startsWith("finding:") && e.file.startsWith("packages/cli/src/"))];
    writeFileSync(allowFile, `${JSON.stringify(mine, null, 2)}\n`);
  }
  const put = (f, t) => { if (!existsSync(join(root, f))) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), t); } };
  put(".github/workflows/test.yml", WORKFLOW);
  put("package.json", `${JSON.stringify({ name: "fixture", private: true, scripts: { test: "kit check canon && node --test" } }, null, 2)}\n`);
  const co = join(root, ".github/CODEOWNERS");
  const have = existsSync(co) ? readFileSync(co, "utf8") : "";
  writeFileSync(co, `${have}/.claude/settings.json @owner\n/.claude/hooks/ @owner\n/kit.canon.json @owner\n/.github/rulesets/default-branch.json @owner\n/CLAUDE.md @owner\n/constitution.rules.json @owner\n/.githooks/ @owner\n/.github/workflows/ @owner\n/agent-identities.json @owner\n/guard-approvals.jsonl @owner\n/packages/cli/src/agent-guard/ @owner\n/vendor/kit/packages/cli/src/agent-guard/ @owner\n`);
  const canon = JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8"));
  const r = syncGuard(root, canon);
  if (r.problems.length) throw new Error(JSON.stringify(r.problems));
  return root;
}
