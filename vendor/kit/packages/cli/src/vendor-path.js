/**
 * Where the vendored kit snapshot lives in a repository, from its one source: kit.canon.json `vendor` (path, optional manifest).
 * Zero npm dependencies: the agent-guard reads it from a vendored snapshot with nothing installed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

/** vendor.path when kit.canon.json declares none (what `kit vendor sync` writes by default). */
export const DEFAULT_VENDOR_PATH = "vendor/kit";
/** vendor.path in source mode when none is declared: the checkout of the kit at its head, ignored by git (docs/FRESHNESS.md, the kit at t=0). */
export const DEFAULT_SOURCE_PATH = ".kit";
/** The two ways a repository holds the kit: a snapshot (post-facto: a copy that goes stale and is re-vendored later) or the source at its head, verified before every use (t=0). */
export const VENDOR_MODES = ["snapshot", "source"];
export const isSourceMode = (cfgIn) => cfgIn != null && typeof cfgIn === "object" && cfgIn.mode === "source";

/** vendor.path as written in the config → a clean repo-relative POSIX path: ./third_party/kit/, third_party\\kit → third_party/kit. */
export const normalPath = (p) => posix.normalize(String(p).replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/+$/, "");
/**
 * A configured location (vendor.path, vendor.manifest) → a clean path strictly INSIDE the project. The project root itself, "..",
 * an absolute path, a drive path and anything that climbs out through ".." are refused: a sync swaps and deletes what lives there.
 */
export function insidePath(p, what = "vendor.path") {
  const raw = String(p ?? ""), n = normalPath(raw);
  if (!n || n === "." || n === ".." || n.split("/").includes("..") || posix.isAbsolute(n) || /^[A-Za-z]:/.test(n) || raw.includes("\0")) throw new Error(`${what} "${raw}" must be a folder inside the project: not the project root, not outside it, not absolute`);
  return n;
}
/** The configuration with its locations checked and cleaned. */
export function cleanConfig(cfgIn) {
  const cfg = { ...cfgIn, path: insidePath(cfgIn.path, "vendor.path") };
  if (cfgIn.manifest !== undefined) cfg.manifest = insidePath(cfgIn.manifest, "vendor.manifest");
  return cfg;
}
/** The snapshot's manifest file. */
export const manifestPath = (cfg) => cfg.manifest || `${normalPath(cfg.path)}.manifest.json`;

/** kit.canon.json's `vendor` checked: absent is the default; anything but an object with a string path (when given) throws (fail closed). */
function vendorConfig(cfgIn) {
  if (cfgIn === undefined) return { path: DEFAULT_VENDOR_PATH };
  if (cfgIn === null || typeof cfgIn !== "object" || Array.isArray(cfgIn)) throw new Error(`vendor must be an object ({ "path": "<folder>" }), got ${JSON.stringify(cfgIn)}`);
  if (cfgIn.mode !== undefined && !VENDOR_MODES.includes(cfgIn.mode)) throw new Error(`vendor.mode must be one of ${VENDOR_MODES.join(", ")}, got ${JSON.stringify(cfgIn.mode)}`);
  if (cfgIn.path !== undefined && typeof cfgIn.path !== "string") throw new Error(`vendor.path must be a string, got ${JSON.stringify(cfgIn.path)}`);
  if (cfgIn.manifest !== undefined && typeof cfgIn.manifest !== "string") throw new Error(`vendor.manifest must be a string, got ${JSON.stringify(cfgIn.manifest)}`);
  if (isSourceMode(cfgIn) && cfgIn.manifest !== undefined) throw new Error("vendor.manifest has no meaning in source mode: the kit at its head is verified against the published head object, never against a manifest");
  return cleanConfig(cfgIn.path !== undefined ? cfgIn : { ...cfgIn, path: isSourceMode(cfgIn) ? DEFAULT_SOURCE_PATH : DEFAULT_VENDOR_PATH });
}

/**
 * The snapshot roots of a vendor config: the configured one first, then the default when it differs (a snapshot left at the default
 * path is still the kit's: moving vendor.path never makes it writable or unproven). → [{ snapshot, manifest }]. Throws on a bad config.
 */
export function snapshotRoots(cfgIn) {
  const cfg = vendorConfig(cfgIn), roots = [{ snapshot: cfg.path, manifest: manifestPath(cfg), mode: cfg.mode ?? "snapshot" }];
  // a snapshot left at the default path is still the kit's, whatever mode the configuration names now (a migration to source mode that
  // forgot to delete vendor/kit still has it proven, and the finding class kit-source-t0 names it)
  if (cfg.path !== DEFAULT_VENDOR_PATH) roots.push({ snapshot: DEFAULT_VENDOR_PATH, manifest: `${DEFAULT_VENDOR_PATH}.manifest.json`, mode: "snapshot" });
  return roots;
}
/** The vendor configuration cleaned, with its mode: { path, mode, repository?, ... }. */
export function kitLocation(cfgIn) {
  const cfg = vendorConfig(cfgIn);
  return { ...cfg, mode: cfg.mode ?? "snapshot" };
}

/** The generated roots of a vendor config (or the default): { snapshot (the configured one), globs: every root's <path>/** and manifest }. */
export function vendorRoots(cfgIn) {
  const roots = snapshotRoots(cfgIn);
  return { snapshot: roots[0].snapshot, globs: roots.flatMap((r) => [`${r.snapshot}/**`, r.manifest]) };
}

/** kit.canon.json's `vendor` from its text (null: no canon file). Throws on unreadable JSON: never read as "no vendor". */
export function vendorOfCanonText(text) {
  if (text == null) return undefined;
  return JSON.parse(text).vendor;
}

/** The snapshot roots of the repository at `root`, from its kit.canon.json. */
export function repoSnapshotRoots(root) {
  const f = join(root, "kit.canon.json");
  return snapshotRoots(vendorOfCanonText(existsSync(f) ? readFileSync(f, "utf8") : null));
}
