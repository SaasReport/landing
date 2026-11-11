/**
 * Cron arithmetic for the resilience rules: the LONGEST gap between consecutive firings of a set of 5-field cron expressions
 * (UTC, minute hour day-of-month month day-of-week; *, lists, ranges, steps). A monitor's stale window and dead-man interval are
 * measured against this gap, so `0 3 * * *` plus `0 4 * * 1` is a daily cadence, and `0 3 * * 1-5` has a 3-day weekend gap.
 */
/**
 * Two dialects, because the two schedulers number weekdays differently:
 *   github     (POSIX, GitHub Actions on.schedule): day-of-week 0-6, 0 = Sunday; names SUN-SAT; day-of-month and day-of-week both
 *              restricted means EITHER matches (POSIX).
 *   cloudflare (Workers cron triggers): day-of-week 1-7, 1 = Sunday, 7 = Saturday (developers.cloudflare.com/workers/configuration/
 *              cron-triggers); names SUN-SAT; L (last day of the month; "5L" the last Thursday) and # ("2#1" the first Monday).
 *              How a restricted day-of-month and day-of-week combine is not documented, so an expression restricting both is refused.
 * The result is always JavaScript's numbering (getUTCDay: 0 = Sunday). Anything not understood throws: a schedule nobody can read is a
 * failure, never a guess.
 */
const RANGES = { github: [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]], cloudflare: [[0, 59], [0, 23], [1, 31], [1, 12], [1, 7]] };
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function field(spec, [lo, hi], i, dialect) {
  const out = new Set(), special = [];
  const name = (t) => {
    if (/^\d+$/.test(t)) return Number(t);
    const u = t.toUpperCase();
    if (i === 4 && DAYS.includes(u)) return DAYS.indexOf(u) + (dialect === "cloudflare" ? 1 : 0);
    if (i === 3 && MONTHS.includes(u)) return MONTHS.indexOf(u) + 1;
    throw new Error(`cron field ${i + 1} "${spec}": "${t}" is not a number or a name`);
  };
  for (const part of String(spec).split(",")) {
    if (dialect === "cloudflare" && i === 2 && part === "L") { special.push({ last: true }); continue; }
    const lw = dialect === "cloudflare" && i === 4 ? /^([A-Za-z]{3}|\d)(L|#([1-5]))$/.exec(part) : null;
    if (lw) { const v = name(lw[1]); if (v < lo || v > hi) throw new Error(`cron field 5 "${spec}" is out of range ${lo}-${hi}`); special.push({ dow: v - 1, ...(lw[2] === "L" ? { lastOf: true } : { nth: Number(lw[3]) }) }); continue; }
    const m = /^(\*|([A-Za-z]{3}|\d+)(?:-([A-Za-z]{3}|\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron field ${i + 1} "${spec}" is not a number, name, range, list, step or *${dialect === "cloudflare" ? ", L or #" : ""}`);
    const step = m[4] ? Number(m[4]) : 1;
    let a = lo, b = hi;
    if (m[1] !== "*") { a = name(m[2]); b = m[3] != null ? name(m[3]) : (m[4] ? hi : a); }
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`cron field ${i + 1} "${spec}" is out of range ${lo}-${hi}${i === 4 ? (dialect === "cloudflare" ? " (Cloudflare: 1 = Sunday ... 7 = Saturday)" : " (GitHub, POSIX: 0 = Sunday ... 6 = Saturday)") : ""}`);
    for (let v = a; v <= b; v += step) out.add(i === 4 && dialect === "cloudflare" ? v - 1 : v);
  }
  return { set: out, special };
}

export function parseCron(expr, { dialect = "github" } = {}) {
  if (!RANGES[dialect]) throw new Error(`unknown cron dialect "${dialect}"`);
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron "${expr}" does not have 5 fields`);
  const parsed = f.map((x, i) => field(x, RANGES[dialect][i], i, dialect));
  const domStar = f[2] === "*", dowStar = f[4] === "*";
  if (dialect === "cloudflare" && !domStar && !dowStar) throw new Error(`cron "${expr}": Cloudflare does not document how a restricted day-of-month and day-of-week combine; restrict one of them`);
  return { sets: parsed.map((p) => p.set), special: { dom: parsed[2].special, dow: parsed[4].special }, domStar, dowStar };
}

const lastDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
const domMatch = (c, d) => c.sets[2].has(d.getUTCDate()) || c.special.dom.some((x) => x.last && d.getUTCDate() === lastDay(d));
const dowMatch = (c, d) => c.sets[4].has(d.getUTCDay()) || c.special.dow.some((x) => x.dow === d.getUTCDay()
  && (x.lastOf ? d.getUTCDate() + 7 > lastDay(d) : Math.ceil(d.getUTCDate() / 7) === x.nth));

/** The window: four whole years from a fixed Monday (a leap day included), so yearly and 29-February crons are measured, not missed. */
export const WINDOW_DAYS = 4 * 365 + 1;

/**
 * Longest gap in minutes between consecutive firings over four years, wrapping around (null when nothing ever fires, e.g. "0 0 30 2 *":
 * the caller treats null as a failure). Throws on an invalid expression.
 */
const dayMatches = (c, d) => c.sets[3].has(d.getUTCMonth() + 1)
  && (c.domStar && c.dowStar ? true : c.domStar ? dowMatch(c, d) : c.dowStar ? domMatch(c, d) : domMatch(c, d) || dowMatch(c, d));

export function maxGapMin(exprs, { from = Date.UTC(2026, 0, 5), dialect = "github" } = {}) {
  const cs = exprs.map((e) => parseCron(e, { dialect }));
  const times = new Set();
  for (let day = 0; day < WINDOW_DAYS; day++) {
    const d = new Date(from + day * 864e5);
    for (const c of cs) {
      if (!dayMatches(c, d)) continue;
      for (const h of c.sets[1]) for (const m of c.sets[0]) times.add(from + day * 864e5 + (h * 60 + m) * 60000);
    }
  }
  if (!times.size) return null;
  const t = [...times].sort((a, b) => a - b);
  let gap = (t[0] + WINDOW_DAYS * 864e5 - t.at(-1)) / 60000;
  for (let i = 1; i < t.length; i++) gap = Math.max(gap, (t[i] - t[i - 1]) / 60000);
  return gap;
}
