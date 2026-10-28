// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance. Not derived from upstream Forge.
/**
 * generate(doc, target, options) → { files, model, problems }: one contract through Forge (initFromOpenApi, the
 * resolver) and the native targets, run as one Forge transformer (forge.emit per file). In memory, deterministic:
 * the same contract and options give the same bytes, which is what `kit check sdk` relies on.
 *
 *   javascript  index.mjs, index.d.ts, cli.mjs, package.json
 *   python      python/<module>/__init__.py, python/<module>/py.typed, python/pyproject.toml
 */
import { buildModel } from "./model.js";
import { generatedFileHeader } from "./strings.js";
import { emitCli } from "./targets/cli.js";
import { emitDts, emitIndex, emitPackage } from "./targets/javascript.js";
import { emitPyproject, emitPythonModule, pyModuleName } from "./targets/python.js";

/** Every native target, in emit order. */
export const TARGETS = ["javascript", "python"];

/**
 * @param {object} doc an OpenAPI 3.1 document
 * @param {{ name: string, cli?: string, contract?: string }} target
 * @param {{ mark: string, description?: string, languages?: string[], extra?: (model: object) => { path: string, content: string }[] }} options
 *   mark         the generator name every file's header carries
 *   description  the package description (package.json, pyproject.toml)
 *   languages    a subset of TARGETS (default: all)
 *   extra        more files from the model (e.g. a README)
 */
export async function generate(doc, target, { mark, description = "", languages = TARGETS, extra } = {}) {
  const unknown = languages.filter((l) => !TARGETS.includes(l));
  if (unknown.length) return { files: [], problems: [`unknown target language ${unknown.join(", ")} (${TARGETS.join(", ")})`] };
  let m;
  try {
    m = buildModel(doc, target);
  } catch (e) {
    return { files: [], problems: [`Forge rejected the contract: ${e.message}`] };
  }
  if (m.problems.length) return { files: [], model: m, problems: m.problems };
  const js = generatedFileHeader(mark, "//");
  const py = generatedFileHeader(mark, "#");
  const sources = await m.forge.transform((forge) => {
    if (languages.includes("javascript")) {
      forge.emit("index.mjs", emitIndex(m, js));
      forge.emit("index.d.ts", emitDts(m, doc, js));
      forge.emit("cli.mjs", emitCli(m, js));
      forge.emit("package.json", emitPackage(m, description));
    }
    if (languages.includes("python")) {
      const mod = pyModuleName(target);
      forge.emit(`python/${mod}/__init__.py`, emitPythonModule(m, doc, py));
      forge.emit(`python/${mod}/py.typed`, "");
      forge.emit("python/pyproject.toml", emitPyproject(m, description, py));
    }
    for (const f of extra?.(m) ?? []) forge.emit(f.path, f.content);
  });
  const files = sources.map((f) => ({ path: f.path, content: f.content })).sort((a, b) => a.path.localeCompare(b.path));
  return { files, model: m, problems: [] };
}
