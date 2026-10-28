/**
 * vendor-stale (docs/RELEASE.md): how far a site's vendored kit may lag the kit's main. On 2026-10-13 four sites ran a kit 50 to 68
 * commits old: the D1-safe podcast triggers (kit 88f87e40, 2026-10-07), the compulsory resilience check and every finding-class gate had
 * landed on main and reached none of them, so three podcast pipelines failed for a week and nobody was told. Nothing bounded the lag.
 *
 *   kitHeadDoc(root, { count })                 the kit's own CI: { v, repository, ref, sha, date, recent } from git (first-parent main)
 *   kitArchive(root, sha)                        the archive of that commit (tar.gz), what a site's bootstrap fetches with no credential
 *   publishHead(doc, { token, tokenId, accountId, archive, ... })  PUT the archive, then the head object naming it, to the public bucket packages/core/registry/kit-head.json names (Cloudflare R2 data-plane API, SigV4)
 *   staleProblems(manifest, cfg, deps)           a site: the vendored commit against the published head, with no credential
 *
 * The bound is kit.canon.json vendor.stale { max_commits (default 30), max_days (default 14) }: the snapshot fails when it is
 * max_commits or more FIRST-PARENT commits of main behind (merge commits count once; a branch's inner commits never), or when the oldest
 * commit it lacks is older than max_days. An unreadable head FAILS in CI (CI=true) and is
 * a warning on a developer's machine (no network is not a pass, and not a reason to block an offline edit either).
 *
 * KIT_HEAD_DOC=<file> reads the head document from a file instead of the registry's URL. It exists for the kit's own test run, whose
 * network is disabled (packages/cli/scripts/no-network.mjs), and is honoured ONLY when the test runner is active (NODE_TEST_CONTEXT is
 * set by the node test runner and inherited by the CLI a test spawns). Anywhere else it is REFUSED with a problem, never ignored and never
 * obeyed: a head from a file would let a site pretend its snapshot is current.
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { gitEnv } from "./git.js";
import { KIT_REPOSITORY } from "./vendor.js";

// read on first use, not at import: the canon loads this module in every repository, and a snapshot that lacks these files must fail
// the vendor check with a problem, never the whole canon run with an ENOENT
const readKit = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
let schema = null, validator = null, head = null;
export const kitHead = () => (head ??= readKit("../../core/registry/kit-head.json"));
export function headProblems(doc) {
  schema ??= readKit("../../core/schemas/kit-head.schema.json");
  validator ??= createValidator([schema]);
  return formatProblems(validator.validate(doc, schema.$id));
}
export const STALE_DEFAULTS = Object.freeze({ max_commits: 30, max_days: 14 });
const DAY = 864e5;

/** The head document of the kit clone at root (its main, first-parent, newest first). */
export function kitHeadDoc(root, { count = kitHead().recent, ref = "HEAD", repository = KIT_REPOSITORY, now = new Date() } = {}) {
  const out = execFileSync("git", ["-C", root, "log", "--first-parent", `-${count}`, "--format=%H %cI", ref], { encoding: "utf8", env: gitEnv() }).trim().split("\n");
  const recent = out.filter(Boolean).map((l) => { const [sha, d] = l.split(" "); return { sha, date: new Date(d).toISOString() }; });
  const doc = { v: 1, repository, ref: "main", sha: recent[0].sha, date: recent[0].date, published_at: now.toISOString(), recent };
  const bad = headProblems(doc);
  if (bad.length) throw new Error(`kit-head document off its contract: ${bad.join("; ")}`);
  return doc;
}

const sha256hex = (d) => createHash("sha256").update(d).digest("hex");

/** The archive of the kit at sha (git archive, tar.gz, prefix kit/): { key, bytes, sha256, body }. What the bootstrap's archive transport fetches. */
export function kitArchive(root, sha, { key = kitHead().archive_key } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`kitArchive: not a commit: ${sha}`);
  const body = execFileSync("git", ["-C", root, "archive", "--format=tar.gz", "--prefix=kit/", sha], { env: gitEnv(), maxBuffer: 512 * 1024 * 1024 });
  return { key: key.replace("{sha}", sha), bytes: body.length, sha256: sha256hex(body), body };
}
/** The public URL of an object published beside the head object (same base as the registry's url). */
export const publicUrlOf = (key, headUrl = kitHead().url) => new URL(key, headUrl).href;
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Signature Version 4 as Cloudflare R2's data-plane API requires it (node:crypto only). → the request's headers with `authorization` added. `headers` must hold every header to be
 * signed except x-amz-date, x-amz-content-sha256 and host, which are derived here when absent. Proven against the documented SigV4 example.
 */
export function signV4({ method, url, headers = {}, bodyHash, accessKeyId, secretAccessKey, region = "auto", service = "s3", amzDate }) {
  const u = new URL(url);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": bodyHash };
  const names = Object.keys(h).sort();
  const canonical = [method, u.pathname.split("/").map((seg) => enc(decodeURIComponent(seg))).join("/"),
    [...u.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&"),
    names.map((n) => `${n}:${h[n]}\n`).join(""), names.join(";"), bodyHash].join("\n");
  const day = amzDate.slice(0, 8), scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/**
 * PUT the document to the public object with the Cloudflare R2 data-plane API (R2's S3-compatible request format) (SigV4). Fails closed on anything but success. The Cloudflare R2 object
 * REST endpoint answers 403 to a token scoped to one bucket (proven 2026-10-13) and takes only an account-wide R2 write token; the data-plane API
 * honours the bucket-scoped token (access key id = the token's id, secret = SHA-256 hex of the token value), so the credential stays
 * least-privilege. tokenId (CLOUDFLARE_API_TOKEN_ID) is not secret.
 */
export async function publishHead(doc, { token, tokenId, accountId, bucket = kitHead().bucket, key = kitHead().key, archive = null, headUrl = kitHead().url, fetch: f = globalThis.fetch, now = new Date() }) {
  if (!token || !/^[0-9a-f]{32}$/.test(accountId || "")) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (the kit-head environment's secrets)");
  if (!/^[0-9a-f]{32}$/.test(tokenId || "")) throw new Error("CLOUDFLARE_API_TOKEN_ID (32 hex: the token's id, the kit-head environment's variable) is required: the Cloudflare R2 data-plane API signs with it");
  // the archive first, named by the head object: a head object is never published before the archive it names exists
  if (archive) doc = { ...doc, archive: { key: archive.key, url: publicUrlOf(archive.key, headUrl), sha256: archive.sha256, bytes: archive.bytes } };
  const bad = headProblems(doc);
  if (bad.length) throw new Error(`refusing to publish a document off its contract: ${bad.join("; ")}`);
  const put = async (k, body, contentType, cacheControl, timeout) => {
    const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${k.split("/").map(encodeURIComponent).join("/")}`;
    const headers = signV4({
      method: "PUT", url, headers: { "content-type": contentType, "cache-control": cacheControl }, bodyHash: sha256hex(body),
      accessKeyId: tokenId, secretAccessKey: sha256hex(token), amzDate: now.toISOString().replace(/[-:]|\.\d{3}/g, ""),
    });
    const r = await f(url, { method: "PUT", headers, body, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`publishing ${bucket}/${k} answered ${r.status}`);
  };
  if (archive) await put(archive.key, archive.body, "application/gzip", "public, max-age=31536000, immutable", 300000);   // content-addressed by its key: immutable
  await put(key, JSON.stringify(doc), "application/json", "no-store", 30000);
  return { bucket, key, sha: doc.sha, archive: doc.archive ?? null };
}

/**
 * → { problems: [string], warnings: [string], behind: number|null }. deps: { fetch, now, ci, url } (url: the registry's, or a test's).
 */
export async function staleProblems(manifest, cfg = {}, { fetch: f = globalThis.fetch, now = Date.now(), ci = process.env.CI === "true", url, env = process.env } = {}) {
  if (env.KIT_HEAD_DOC) {
    if (!env.NODE_TEST_CONTEXT) return { problems: ["vendor-stale: KIT_HEAD_DOC is set outside the kit's test run: it is honoured only by the test runner and refused everywhere else, so a site cannot read its head from a file"], warnings: [], behind: null };
    const file = env.KIT_HEAD_DOC;
    if (url === undefined) { url = `file:${file}`; f = async () => new Response(readFileSync(file, "utf8"), { headers: { "content-type": "application/json" } }); }   // an explicit url/fetch (a test of this function) wins
  }
  if (url === undefined) { try { url = kitHead().url; } catch (e) { return { problems: [`vendor-stale: the kit's head registry cannot be read (${e.message})`], warnings: [], behind: null }; } }
  const bound = { ...STALE_DEFAULTS, ...(cfg.stale || {}) };
  const commit = manifest?.source?.commit, vdate = manifest?.source?.commit_date;
  const unreadable = (why) => (ci ? { problems: [`vendor-stale: ${why}: the kit's head cannot be read, so the snapshot's lag is unknown (fails closed in CI)`], warnings: [], behind: null } : { problems: [], warnings: [`vendor-stale: ${why} (a warning on this machine; CI fails closed)`], behind: null });
  if (!/^[0-9a-f]{40}$/.test(commit || "")) return { problems: ["vendor-stale: the manifest names no full commit"], warnings: [], behind: null };
  if (!url) return unreadable("the kit head is not published yet (packages/core/registry/kit-head.json url is null)");
  let doc;
  try {
    const r = await f(url, { headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return unreadable(`${url} answered ${r.status}`);
    doc = await r.json();
  } catch (e) { return unreadable(`${url} is unreachable (${String(e?.message || e).slice(0, 120)})`); }
  const bad = headProblems(doc);
  if (bad.length) return { problems: [`vendor-stale: ${url} is off its contract (kit.kit-head.v1): ${bad.slice(0, 2).join("; ")}`], warnings: [], behind: null };
  if (vdate && Date.parse(doc.date) < Date.parse(vdate)) return { problems: [`vendor-stale: the published kit head (${doc.sha.slice(0, 12)}, ${doc.date}) is older than the vendored kit (${commit.slice(0, 12)}, ${vdate}): the publisher is behind or the snapshot is not from main; a head that cannot be trusted proves nothing`], warnings: [], behind: null };
  const idx = doc.recent.findIndex((c) => c.sha === commit);
  const age = (iso) => Math.floor((now - Date.parse(iso)) / DAY);
  if (idx === -1) {
    const oldest = doc.recent.at(-1);
    // a commit dated inside the window the head lists, yet not one of them, is not on main's first-parent line (a branch commit, a merged
    // branch's inner commit, a fork): that is not "behind", and re-vendoring from main is the only fix
    if (vdate && Date.parse(vdate) >= Date.parse(oldest.date)) return { problems: [`vendor-stale: the vendored kit ${commit.slice(0, 12)} (${vdate}) is not on main's first-parent line: it is dated within main's last ${doc.recent.length} commits (since ${oldest.date}) and is none of them (a branch commit, a merged branch's inner commit or another repository's). Re-vendor from a main commit: kit vendor sync --commit <main>`], warnings: [], behind: null };
    return { problems: [`vendor-stale: the vendored kit ${commit.slice(0, 12)} is not among main's last ${doc.recent.length} first-parent commits and is older than the oldest of them: more than ${doc.recent.length} behind (limit ${bound.max_commits}), main's oldest listed commit is ${age(oldest.date)} days old. Re-vendor: kit vendor sync --commit <main>`], warnings: [], behind: null };
  }
  const problems = [];
  if (idx >= bound.max_commits) problems.push(`vendor-stale: the vendored kit ${commit.slice(0, 12)} is ${idx} commits behind main ${doc.sha.slice(0, 12)} (limit ${bound.max_commits}, kit.canon.json vendor.stale.max_commits). Re-vendor: kit vendor sync --commit ${doc.sha.slice(0, 12)}`);
  if (idx > 0) { const missedSince = doc.recent[idx - 1].date, d = age(missedSince); if (d > bound.max_days) problems.push(`vendor-stale: main has had a commit the vendored kit lacks for ${d} days (since ${missedSince}; limit ${bound.max_days}, vendor.stale.max_days). Re-vendor: kit vendor sync --commit ${doc.sha.slice(0, 12)}`); }
  return { problems, warnings: [], behind: idx };
}
