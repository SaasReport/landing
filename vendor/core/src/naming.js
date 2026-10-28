// Universal naming. Every resource name is built from registry/naming.json, never typed.
// Pure: the registry is passed in.

const PLACEHOLDER = /\{([a-z]+)\}/g;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/@]/g, "\\$&");

function kindOf(naming, id) {
  const kind = naming.kinds.find((k) => k.id === id);
  if (!kind) throw new RangeError(`unknown resource kind ${id}`);
  return kind;
}

function allowed(naming, kind, placeholder) {
  const list = naming.values[placeholder];
  if (!list) throw new RangeError(`kind ${kind.id}: placeholder {${placeholder}} has no values in the registry`);
  return placeholder === "env" && kind.envs ? list.filter((v) => kind.envs.includes(v)) : list;
}

/** Build a name: resourceName(naming, "d1", { component: "api", env: "production" }) -> "saasreport-api-production". */
export function resourceName(naming, kindId, values = {}) {
  const kind = kindOf(naming, kindId);
  return kind.pattern.replace(PLACEHOLDER, (_, p) => {
    const v = values[p];
    if (!allowed(naming, kind, p).includes(v)) throw new RangeError(`${kindId}: ${JSON.stringify(v)} is not a registered {${p}}`);
    return v;
  });
}

/** [] when `name` is a valid name for the kind, else one explanatory line. */
export function nameProblems(naming, kindId, name) {
  const kind = kindOf(naming, kindId);
  let source = "", last = 0, m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(kind.pattern))) {
    source += escape(kind.pattern.slice(last, m.index)) + `(?:${allowed(naming, kind, m[1]).map(escape).join("|")})`;
    last = m.index + m[0].length;
  }
  source += escape(kind.pattern.slice(last));
  return new RegExp(`^${source}$`).test(String(name)) ? [] : [`${JSON.stringify(name)} is not a ${kindId} name (pattern ${kind.pattern})`];
}

const KEYS = [["name", ["worker"]], ["database_name", ["d1"]], ["bucket_name", ["r2", "r2_archive"]], ["queue", ["queue"]]];

/** Check the resource names a wrangler.toml declares. Returns one line per problem. */
export function wranglerProblems(naming, toml, file = "wrangler.toml") {
  const problems = [];
  toml.split("\n").forEach((line, i) => {
    const m = /^\s*([a-z_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    const entry = m && KEYS.find(([key]) => key === m[1]);
    if (!entry) return;
    if (!entry[1].some((kind) => nameProblems(naming, kind, m[2]).length === 0)) problems.push(`${file}:${i + 1}: ${m[1]} = "${m[2]}" breaks the naming registry (${entry[1].join(" or ")})`);
  });
  return problems;
}
