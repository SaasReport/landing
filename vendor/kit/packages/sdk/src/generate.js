/**
 * kit sdk generate: a project's OpenAPI 3.1 contract → typed SDKs and a CLI, through @saasreport/forge (the kit's native
 * Forge, packages/forge): the contract (JSON or YAML) → the kit's policy checks → Forge's command tree and resolver →
 * the native targets as one Forge transformer → <out>/:
 *
 *     index.mjs, index.d.ts   the JavaScript client and its types: createClient({ baseUrl, fetch, headers })
 *     cli.mjs, package.json   the Node CLI (<bin> <command> <method> --param value …) and the npm package
 *     python/                 the typed Python client (Python 3.11+, standard library only) and its pyproject.toml
 *     README.md               the generated reference: every operation
 *     forge.manifest.json     the checksum manifest (schema sdk-manifest): contract sha256, generator, every file
 *
 * Every output is generated, never edited by hand: `kit check sdk` regenerates in memory and diffs, byte for byte.
 */
import { createHash } from "node:crypto";
import { bundleExternalRefs } from "./bundle.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { generate, generatedFileHeader, ORIGIN, PACKAGE, pyModuleName, pyName, TARGETS, toKebabCase } from "../../forge/src/index.js";

/** The generator every manifest names: @saasreport/forge, its version and the upstream commit the port started from. */
export const FORGE = { package: PACKAGE.name, version: PACKAGE.version, license: PACKAGE.license, origin: { repository: ORIGIN.origin.repository, commit: ORIGIN.origin.commit } };
export const TRANSFORMER = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const MANIFEST_FILE = "forge.manifest.json";
export const MANIFEST_SCHEMA = "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/sdk-manifest.schema.json";
/** The marker every generated file carries (also how `kit check sdk` spots a copied generated file elsewhere). */
export const MARK = "kit sdk generate (@saasreport/forge)";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Read a contract: { doc, text }. JSON natively; YAML with the project's own `yaml` package (npm i -D yaml), the
 * same rule as kit widgets' YAML sources: the kit itself has no dependencies.
 */
export function loadContract(root, path) {
  const text = readFileSync(join(root, path), "utf8");
  if (!/\.ya?ml$/i.test(path)) return { doc: JSON.parse(text), text };
  let YAML;
  for (const base of [join(root, "package.json"), import.meta.url]) {
    try { YAML = createRequire(base)("yaml"); break; } catch { /* not installed from this base: the next is tried, none is an error below */ }
  }
  if (!YAML) throw new Error(`${path}: a YAML contract needs the "yaml" package in the project (npm i -D yaml)`);
  return { doc: YAML.parse(text), text };
}

/**
 * The kit's policy on a contract, beyond what Forge needs to generate it: an OpenAPI 3.1 document with operations,
 * each with a summary or description and a declared 2xx response. (Forge itself handles a missing operationId, tag,
 * request-body schema or 2xx schema, and every method: those are no longer problems.)
 */
export function adapt(doc, label = "contract") {
  if (!doc || typeof doc !== "object" || !doc.paths) return { doc: null, problems: [`${label}: not an OpenAPI document (no paths)`] };
  const problems = [];
  if (!/^3\.1\./.test(String(doc.openapi))) problems.push(`${label}: openapi ${doc.openapi}: the kit generates from OpenAPI 3.1 contracts`);
  let count = 0;
  for (const [path, item] of Object.entries(doc.paths || {})) {
    for (const m of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
      const op = item?.[m];
      if (!op) continue;
      count++;
      const where = `${m.toUpperCase()} ${path}${op.operationId ? ` (${op.operationId})` : ""}`;
      if (!op.summary && !op.description) problems.push(`${label}: ${where} has no summary or description`);
      if (!Object.keys(op.responses || {}).some((st) => /^2(\d\d|XX)$/.test(st))) problems.push(`${label}: ${where} declares no 2xx response`);
    }
  }
  if (!count) problems.push(`${label}: no operations`);
  return { doc, problems };
}

/** The generated reference (README.md): every operation, its JavaScript and Python call and its CLI command. */
function emitReadme(m, languages) {
  const bin = m.target.cli || m.target.name;
  const mod = pyModuleName(m.target);
  const js = languages.includes("javascript");
  const py = languages.includes("python");
  const rows = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        const op = m.ops[v];
        const cells = [];
        if (js) cells.push(`\`${[...prefix, k].join(".")}\``, `\`${bin} ${[...prefix, k].map(toKebabCase).join(" ")}\``);
        if (py) cells.push(`\`${[...prefix, k].map((s) => pyName(s)).join(".")}\``);
        cells.push(`\`${op.method} ${op.path}\``, `${(op.summary || "").replace(/\|/g, "\\|").replace(/\n/g, " ")}${op.derived ? " (operationId derived)" : ""}`);
        rows.push(`| ${cells.join(" | ")} |`);
      } else walk(v, [...prefix, k]);
    }
  };
  walk(m.tree, []);
  const head = [...(js ? ["Client", "CLI"] : []), ...(py ? ["Python"] : []), "Route", "Summary"];
  const h = generatedFileHeader(MARK).trimEnd().split("\n").map((l) => l.replace(/^\/\/ ?/, "")).join(" · ");
  return `<!-- ${h} -->

# ${m.target.name}-sdk

Generated by \`kit sdk generate\` with @saasreport/forge ${FORGE.version} (the kit's native Forge; ported from Cloudflare
Forge at \`${FORGE.origin.commit.slice(0, 12)}\`, Apache-2.0) from \`${m.target.contract}\` (${m.info.title || ""} ${m.info.version || ""}).
Never edit these files: change the contract and run \`kit sdk generate\`; \`kit check sdk\` fails on a stale or hand-edited file.
${js ? `
\`\`\`js
import { createClient } from "./index.mjs";
const api = createClient({ baseUrl: ${JSON.stringify(m.servers[0] || "https://…")} });
\`\`\`

\`\`\`sh
node cli.mjs --help
\`\`\`
` : ""}${py ? `
\`\`\`python
from ${mod} import Client  # python/${mod}, Python 3.11+, standard library only
api = Client(${JSON.stringify(m.servers[0] || "https://…")})
\`\`\`
` : ""}
| ${head.join(" | ")} |
|${head.map(() => "---").join("|")}|
${rows.join("\n")}
`;
}

/**
 * Generate one target in memory: { files: [{ path, content }], manifest, operations, problems }. No disk writes.
 * `target` = { name, contract, out, cli?, languages? } (kit.sdk.json); root = the repository root; targets = all of
 * kit.sdk.json's (an out directory may not overlap another's).
 */
export async function generateTarget(root, target, targets = [target]) {
  const label = target.contract;
  const where = outDir(root, target, targets);
  if (where.problem) return { files: [], problems: [`${label}: ${where.problem}`] };
  if (!existsSync(join(root, target.contract))) return { files: [], problems: [`${label}: contract missing`] };
  let loaded;
  try { loaded = loadContract(root, target.contract); } catch (e) { return { files: [], problems: [`${label}: cannot parse: ${e.message}`] }; }
  const { problems } = adapt(loaded.doc, label);
  if (problems.length) return { files: [], problems };
  // External schema references (a kit schema by its $id) are bundled, so no operation is generated as `unknown`.
  const bundle = bundleExternalRefs(loaded.doc, root);
  if (bundle.problems.length) return { files: [], problems: bundle.problems.map((p) => `${label}: ${p}`) };
  const languages = target.languages ?? TARGETS;
  const description = `Generated by ${MARK} from ${target.contract}: never edit by hand; regenerate with kit sdk generate.`;
  const g = await generate(bundle.doc, target, { mark: MARK, description, languages, extra: (m) => [{ path: "README.md", content: emitReadme(m, languages) }] });
  if (g.problems.length) return { files: [], problems: g.problems.map((p) => `${label}: ${p}`) };
  const files = g.files;
  const operations = Object.keys(g.model.ops).length;
  const manifest = {
    $schema: MANIFEST_SCHEMA,
    generated_by: "kit sdk generate",
    target: target.name,
    generator: {
      forge: { ...FORGE, targets: TARGETS.filter((t) => languages.includes(t)) },
      transformer: { package: TRANSFORMER.name, version: TRANSFORMER.version },
    },
    contract: { path: target.contract, sha256: sha256(loaded.text), openapi: String(loaded.doc.openapi), title: loaded.doc.info?.title ?? "", version: String(loaded.doc.info?.version ?? "") },
    operations,
    files: files.map((f) => ({ path: f.path, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content) })),
  };
  files.push({ path: MANIFEST_FILE, content: `${JSON.stringify(manifest, null, 2)}\n` });
  return { files, manifest, operations, problems: [] };
}

/** Where every generated SDK lives: a dedicated directory under the repository root (never a source directory). */
export const SDK_ROOT = "sdk";

/**
 * The output directory of a target, or why it is refused: it must be a subdirectory of <root>/sdk/ (not sdk/ itself),
 * spelled without . or .. segments, not a symlink out of the repository, not overlapping the contract or another
 * target's output. Checked before anything is written or deleted. → { dir } | { problem }
 */
export function outDir(root, target, targets = [target]) {
  const out = String(target.out || "");
  const bad = (why) => ({ problem: `target ${target.name}: out "${out}" ${why}` });
  const segs = out.replace(/\/$/, "").split("/");
  if (!out || isAbsolute(out) || segs.some((x) => x === "" || x === "." || x === "..")) return bad("must be a relative path without empty, . or .. segments");
  if (segs[0] !== SDK_ROOT || segs.length < 2) return bad(`must be a subdirectory of ${SDK_ROOT}/ (e.g. ${SDK_ROOT}/${target.name})`);
  const base = resolve(root, SDK_ROOT);
  const dir = resolve(root, out);
  if (!dir.startsWith(`${base}${sep}`)) return bad(`resolves outside ${SDK_ROOT}/`);
  // a symlinked sdk/ or parent pointing elsewhere: the real path must stay inside the real repository
  let probe = dir;
  while (!existsSync(probe)) probe = dirname(probe);
  const realRoot = realpathSync(root);
  if (!realpathSync(probe).startsWith(realRoot)) return bad("resolves through a symlink outside the repository");
  const inside = (a, b) => a === b || a.startsWith(`${b}${sep}`);
  const contract = resolve(root, target.contract || "");
  if (inside(contract, dir)) return bad(`contains the contract ${target.contract}`);
  for (const t of targets) {
    if (t === target || t.name === target.name || !t.out) continue;
    const other = resolve(root, t.out);
    if (inside(dir, other) || inside(other, dir)) return bad(`overlaps target ${t.name}'s out "${t.out}"`);
  }
  return { dir };
}

/**
 * Write a generated target to its out directory. Only a directory that kit sdk generate wrote is replaced: an existing
 * one must carry forge.manifest.json and hold nothing but the files it lists, else nothing is deleted and it throws.
 */
export function writeTarget(root, target, files, targets = [target]) {
  const r = outDir(root, target, targets);
  if (r.problem) throw new Error(r.problem);
  const out = r.dir;
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new Error(`target ${target.name}: ${target.out} exists and is not a directory; refusing to replace it`);
    const have = listFiles(out);
    if (have.length) {
      let manifest = null;
      try { manifest = JSON.parse(readFileSync(join(out, MANIFEST_FILE), "utf8")); } catch { /* no manifest yet: the SDK was never generated here */ }
      if (manifest?.generated_by !== "kit sdk generate") throw new Error(`target ${target.name}: ${target.out} exists and was not written by kit sdk generate (no ${MANIFEST_FILE}); refusing to delete it`);
      const known = new Set([MANIFEST_FILE, ...(manifest.files || []).map((f) => f.path)]);
      const foreign = have.filter((f) => !known.has(f));
      if (foreign.length) throw new Error(`target ${target.name}: ${target.out} holds files kit sdk generate did not write (${foreign.join(", ")}); remove them by hand first, nothing was deleted`);
    }
    rmSync(out, { recursive: true, force: true });
  }
  for (const f of files) {
    const p = join(out, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content, f.path === "cli.mjs" ? { mode: 0o755 } : undefined);
  }
}

/** Every file under dir, relative, sorted (Python's __pycache__ left out). */
export function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    // Python's bytecode cache appears wherever the generated client is imported: never part of the SDK
    if (f === "__pycache__") return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split("\\").join("/")];
  }).sort();
}
