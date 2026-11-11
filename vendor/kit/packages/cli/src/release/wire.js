/**
 * Wiring a provisioned D1 id into a wrangler TOML config, per binding, never by a whole-file replace (review of kit #140, B1: a file with
 * two placeholders, the monitor's own MONITOR_DB and the watched site's id, got both set to the first uuid, so the monitor watched
 * itself). Each change names the block or the key it touches; a file left with any placeholder after wiring is refused.
 *
 * The editor edits one form: `[[d1_databases]]` / `[[env.<e>.d1_databases]]` tables and `[vars]` / `[env.<e>.vars]` tables of a TOML file.
 * Before touching a file it reads it with the kit's one wrangler reader (readWranglerConfig's parser) and REFUSES, with the form named,
 * any config the reader sees but this editor cannot edit (a .json/.jsonc config, inline-table arrays, dotted keys, an inline `vars`),
 * so a binding is never reported "missing" when it is only written differently.
 */
import { PLACEHOLDER_D1_ID } from "./config.js";
import { parseWranglerText } from "../wrangler-config.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADER = /^\s*(\[\[?)\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `name = "value"` (the key bare or quoted, the value in either quote, an optional trailing comment): groups prefix, quote, value, tail. */
const key = (k) => new RegExp(`^(\\s*(?:"${esc(k)}"|'${esc(k)}'|${esc(k)})\\s*=\\s*)(["'])((?:(?!\\2)[^\\n])*)\\2(\\s*(?:#.*)?)$`);
const dotted = (name) => name.replace(/\s*\.\s*/g, ".").replace(/["']/g, "");

/** The table headers of a TOML text: only lines at bracket depth 0 outside multi-line strings (an array element `["a"],` is not a header). */
function headers(lines) {
  const out = [];
  let depth = 0, ml = null;
  lines.forEach((line, i) => {
    if (ml === null && depth === 0) {
      const m = HEADER.exec(line);
      if (m) { out.push({ i, name: dotted(m[2]), array: m[1] === "[[" }); return; }
    }
    let q = null;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (ml) { if (line.startsWith(ml, j)) { ml = null; j += 2; } continue; }
      if (q) { if (c === "\\" && q === '"') j++; else if (c === q) q = null; continue; }
      if (line.startsWith('"""', j) || line.startsWith("'''", j)) { ml = line.slice(j, j + 3); j += 2; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === "#") break;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
    }
  });
  return out;
}
const endOf = (hs, lines, h) => hs.find((x) => x.i > h.i)?.i ?? lines.length;

/** The line without its trailing comment (a # inside a string stays). */
function codeOf(line) {
  let q = null;
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (q) { if (c === "\\" && q === '"') j++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#") return line.slice(0, j);
  }
  return line;
}

/** The environment's section of the parsed config (read with the one reader), or an error naming the file. */
function section(text, file, env) {
  if (/\.jsonc?$/.test(file)) throw new Error(`${file}: a JSON/JSONC wrangler config cannot be wired (the kit edits TOML tables in place): write it as wrangler.toml`);
  let o;
  try { o = parseWranglerText(text, file); } catch (e) { throw new Error(`${file}: cannot be read (${e.message})`); }
  const target = env ? o.env?.[env] : o;
  if (!target || typeof target !== "object") throw new Error(`${file}: has no [env.${env}] section`);
  return target;
}

/** Set `database_id` of the d1 block bound as `binding` (in [[d1_databases]], or [[env.<env>.d1_databases]]) to `uuid`. */
export function wireD1(text, binding, uuid, { env = "", file = "wrangler.toml" } = {}) {
  if (!ID.test(uuid)) throw new Error(`wireD1: ${uuid} is not a database id`);
  const target = section(text, file, env);
  const name = env ? `env.${env}.d1_databases` : "d1_databases";
  const lines = String(text).split("\n");
  const hs = headers(lines);
  const blocks = hs.filter((h) => h.array && h.name === name);
  const declared = Array.isArray(target.d1_databases) ? target.d1_databases.length : 0;
  if (declared !== blocks.length) throw new Error(`${file}: ${declared} ${name} entr${declared === 1 ? "y is" : "ies are"} declared but ${blocks.length} written as [[${name}]] tables (an inline-table array or dotted keys): the kit wires [[${name}]] tables only`);
  const hit = blocks.find((h) => lines.slice(h.i + 1, endOf(hs, lines, h)).some((l) => { const m = key("binding").exec(l); return m && m[3] === binding; }));
  if (!hit) throw new Error(`no [[${name}]] block with binding = "${binding}"`);
  const end = endOf(hs, lines, hit);
  const i = lines.slice(hit.i + 1, end).findIndex((l) => key("database_id").test(l));
  if (i < 0) throw new Error(`the [[${name}]] block of ${binding} has no database_id line to wire`);
  const at = hit.i + 1 + i;
  lines[at] = lines[at].replace(key("database_id"), `$1$2${uuid}$2$4`);
  return lines.join("\n");
}

/** Set a key of the `[vars]` table (`[env.<env>.vars]` for an environment) to `value`. Throws when the table or the key is missing. */
export function wireVar(text, name, value, { env = "", file = "wrangler.toml" } = {}) {
  const target = section(text, file, env);
  const table = env ? `env.${env}.vars` : "vars";
  const lines = String(text).split("\n");
  const hs = headers(lines);
  const h = hs.find((x) => !x.array && x.name === table);
  if (!h) throw new Error(target.vars && typeof target.vars === "object" ? `${file}: vars are declared but not as a [${table}] table (an inline table or dotted keys): the kit wires the [${table}] table only` : `no [${table}] table to wire`);
  const i = lines.slice(h.i + 1, endOf(hs, lines, h)).findIndex((l) => key(name).test(l));
  if (i < 0) throw new Error(`[${table}] has no ${name} to wire`);
  const at = h.i + 1 + i;
  lines[at] = lines[at].replace(key(name), `$1$2${value}$2$4`);
  return lines.join("\n");
}

/** Every line of `text` that still holds the placeholder id in code (a commented line is not): [{ line, text }]. */
export const placeholders = (text) => String(text).split("\n").map((t, i) => ({ line: i + 1, text: t.trim(), code: codeOf(t) })).filter((x) => x.code.includes(PLACEHOLDER_D1_ID)).map(({ line, text: t }) => ({ line, text: t }));
