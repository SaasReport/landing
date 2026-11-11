/**
 * kit vendor sync --source <local kit clone> --commit <sha>
 *                         write the kit snapshot declared by kit.canon.json `vendor` (default: packages, templates,
 *                         LICENSE, NOTICE into vendor/kit) and vendor/kit.manifest.json (commit, sha256 per file)
 * kit vendor publish-head          the kit's own CI (environment kit-head): publish the archive of kit main's head, then the head object naming it
 *                         (kit.kit-head.v1) to the public bucket packages/core/registry/kit-head.json names, read by every site's bootstrap
 * kit vendor check [--upstream]  every vendored file matches the manifest (also part of kit check canon); --upstream also compares the trust-carrying files
 *                         (ledger, trust, signature code, owner-signed records) with the kit repository at the manifest's commit
 */
import { resolve } from "node:path";
import { CliError } from "../args.js";
import { loadCanon } from "../canon/index.js";
import { checkVendor, manifestPath, syncVendor, upstreamProblems } from "../vendor.js";
import { kitArchive, kitHeadDoc, publishHead } from "../vendor-stale.js";

function config(io) {
  const { canon, problems } = loadCanon(io.cwd);
  if (!canon) throw new CliError(problems.map((p) => p.problem).join("; "), 1);
  if (!canon.vendor) throw new CliError('kit.canon.json declares no "vendor" (path, include)', 1);
  return canon.vendor;
}

export async function vendor(io, { _: [sub] = [], flags }) {
  if (sub === "sync") {
    const cfg = config(io);
    if (!flags.source || !flags.commit) throw new CliError("usage: kit vendor sync --source <local kit clone> --commit <sha>", 2);
    const r = syncVendor(io.cwd, cfg, { source: resolve(io.cwd, String(flags.source)), commit: String(flags.commit) });
    io.out(`kit vendor sync: ${r.files} files (${Math.round(r.bytes / 1024)} KB) from ${r.commit.slice(0, 12)} (${r.date}) → ${cfg.path}, ${manifestPath(cfg)}`);
    if (r.added?.length) io.out(`added file: dependencies to package.json for the vendored packages another one needs: ${r.added.join(", ")}`);
    io.out("next (manual, not run by sync): npm install --package-lock-only to refresh package-lock.json, then npm test, then commit the snapshot, its manifest, package.json and the lockfile together");
    return 0;
  }
  if (sub === "check") {
    const cfg = config(io);
    const { manifest, problems } = checkVendor(io.cwd, cfg);
    if (flags.upstream) { const env = io.env || process.env; problems.push(...await upstreamProblems(io.cwd, cfg, io.fetch, { repository: env.KIT_UPSTREAM_REPO, minCommit: env.KIT_UPSTREAM_MIN_COMMIT, branch: env.KIT_UPSTREAM_BRANCH })); }
    for (const p of problems) io.err(`  - ${p.file}: ${p.problem}`);
    if (problems.length) { io.err(`kit vendor check: ${problems.length} problem${problems.length === 1 ? "" : "s"}`); return 1; }
    io.out(`ok vendor: ${manifest.files.length} files match ${manifest.source.repository}@${manifest.source.commit.slice(0, 12)}`);
    return 0;
  }
  if (sub === "publish-head") {
    const env = io.env || process.env;
    if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_ACTIONS !== "true") throw new CliError("kit vendor publish-head runs only in the kit's CI on main", 2);
    const doc = kitHeadDoc(io.cwd);
    if (doc.sha !== env.GITHUB_SHA) throw new CliError(`the checkout's HEAD ${doc.sha} is not the run's commit ${env.GITHUB_SHA}`, 1);
    const archive = kitArchive(io.cwd, doc.sha);
    const r = await publishHead(doc, { token: env.CLOUDFLARE_API_TOKEN, tokenId: env.CLOUDFLARE_API_TOKEN_ID, accountId: env.CLOUDFLARE_ACCOUNT_ID, archive, fetch: io.fetch });
    io.out(`published kit main ${r.sha.slice(0, 12)} (${doc.recent.length} commits) to ${r.bucket}/${r.key}, with its archive ${archive.key} (${Math.round(archive.bytes / 1024)} KB, sha256 ${archive.sha256.slice(0, 16)})`);
    return 0;
  }
  throw new CliError(`unknown vendor command "${sub ?? ""}" (sync, check, publish-head)`, 2);
}
