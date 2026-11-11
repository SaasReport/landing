/**
 * The command table as a kit's own code defines it, read from its sources: the commands its src/index.js exports in
 * COMMANDS, and for each, the subcommands its dispatcher has a branch for. Branches only, never messages (a message can
 * name a command whose branch is gone): `v === "x"` and `v !== "x"` tests, `["x", …].includes(v)`, the keys of a
 * `{ … }[v]` lookup and the default in `[v = "x"`, where v is the dispatcher's first positional; a branch that only throws
 * its refusal is not a command; kit check also runs every name in CHECKS. Used to prove the kit's own table
 * (test/command-table.test.mjs) and to read the table of a vendored kit too old to ship one (canon/findings.js).
 *
 *   deriveTable(read) → { [command]: [subs] }      read(path relative to packages/cli/src) → text | null
 *   handledSubs(source, fn, checks) → [subs]
 */

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The body of `export async function fn(` up to the next top-level export (the whole source when not found). */
function bodyOf(source, fn) {
  const start = source.search(new RegExp(String.raw`export\s+(?:async\s+)?function\s+${esc(fn)}\s*\(`));
  if (start < 0) return null;
  const next = source.slice(start + 1).search(/\nexport\s/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

export function handledSubs(source, fn, checks = []) {
  const body = bodyOf(source, fn);
  if (!body) return [];
  const sig = body.match(/\{\s*_\s*:\s*\[\s*([A-Za-z_$][\w$]*)/) || body.match(/(?:const|let)\s*\[\s*([A-Za-z_$][\w$]*)[^\]]*\]\s*=\s*_\s*;/);
  if (!sig) return [];   // no first positional: no subcommands
  const v = esc(sig[1]), out = new Set(), refused = new Set();
  for (const m of body.matchAll(new RegExp(String.raw`\b${v}\s*===\s*"([a-z-]+)"\)\s*\{\s*throw\b`, "g"))) refused.add(m[1]);
  for (const m of body.matchAll(new RegExp(String.raw`\b${v}\s*[!=]==\s*"([a-z-]+)"`, "g"))) out.add(m[1]);
  for (const m of body.matchAll(new RegExp(String.raw`\[((?:\s*"[a-z-]+"\s*,?)+)\]\.includes\(${v}\)`, "g"))) for (const k of m[1].matchAll(/"([a-z-]+)"/g)) out.add(k[1]);
  for (const m of body.matchAll(new RegExp(String.raw`\{([^{}]*)\}\[${v}\]`, "g"))) for (const k of m[1].matchAll(/(?:^|[,{]\s*)"?([a-z][a-z-]*)"?\s*:/g)) out.add(k[1]);
  for (const m of body.matchAll(new RegExp(String.raw`\[\s*${v}\s*=\s*"([a-z-]+)"`, "g"))) out.add(m[1]);
  if (new RegExp(String.raw`CHECKS\.includes\(${v}\)`).test(body)) for (const c of checks) out.add(c);
  return [...out].filter((x) => !refused.has(x)).sort();
}

export function deriveTable(read) {
  const index = read("index.js");
  if (!index) return null;
  const list = index.match(/export\s+const\s+COMMANDS\s*=\s*\{([^}]*)\}/);
  if (!list) return null;
  const modules = new Map();
  for (const m of index.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/commands\/([\w-]+)\.js"/g)) {
    for (const name of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)) modules.set(name, m[2]);
  }
  const canon = read("canon/index.js") || "";
  const checks = (canon.match(/export\s+const\s+CHECKS\s*=\s*\[([^\]]*)\]/)?.[1].match(/"([a-z-]+)"/g) || []).map((x) => x.slice(1, -1));
  const table = {};
  for (const entry of list[1].split(",").map((x) => x.trim()).filter(Boolean)) {
    const [key, value = key] = entry.split(":").map((x) => x.trim().replace(/^"|"$/g, ""));
    const file = modules.get(value);
    const source = file ? read(`commands/${file}.js`) : null;
    table[key] = source ? handledSubs(source, value, checks) : [];
  }
  return table;
}
