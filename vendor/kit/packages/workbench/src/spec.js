/**
 * From the project's widgets.spec.json to a workbench definition for one locale: every text (a string, a {locale: text}
 * map, a {$ref} into a source or an {$engine} call) under a text key is resolved with the widget builder's resolver;
 * everything else (adapters, contracts, fixtures, parameters) is copied as written.
 */
import { workbenchProblems } from "./define.js";

/** Keys whose value is a text a reader sees. */
export const TEXT_KEYS = new Set(["title", "intro", "name", "summary", "line", "label", "hint", "empty", "disabledReason", "note", "unit", "sanctionsNote", "text"]);
/** Keys copied untouched (data, not wording). */
const RAW_KEYS = new Set(["contract", "fixture", "params", "query", "headers"]);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

export async function resolveWorkbench(raw, text) {
  const walk = async (v, key) => {
    if (Array.isArray(v)) return Promise.all(v.map((x) => walk(x, key)));
    if (!isObj(v)) return v;
    if (TEXT_KEYS.has(key)) return text(v);
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = RAW_KEYS.has(k) ? x : await walk(x, k);
    return out;
  };
  return walk(raw, "");
}

/** The definition (schema kit.workbench.v1) of one locale, validated; throws with every problem. */
export async function buildDefinition(raw, { text, asOf, locale }) {
  const body = await resolveWorkbench(raw, text);
  const def = { schema: "kit.workbench.v1", asOf, locale: { code: locale.code, dir: locale.dir, digits: locale.digits, intl: locale.intl, tz: raw.tz }, ...body };
  delete def.tz;
  const problems = workbenchProblems(def);
  if (problems.length) throw new Error(`workbench ${raw.id} (${locale.code}) has problems:\n  - ${problems.join("\n  - ")}`);
  return def;
}
