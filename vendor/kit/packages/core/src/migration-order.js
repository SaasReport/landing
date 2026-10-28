/**
 * The ONE order of a migrations directory, a mirror of the comparator wrangler applies D1 migrations with (source as data: registry/migration-order-source.json,
 * wrangler 4.145.0, workers-utils d1-migrations.ts compareSegments): the number is parseInt(text before the first "_", 10), files with a number come first
 * in numeric order (9_ before 10_), a name without one (NaN) comes last, and a plain string comparison breaks every tie. So two files with one number
 * (0008_a.sql, 0008_b.sql) have a DEFINED order: the number, then the name. Like wrangler, a prefix beyond Number.MAX_SAFE_INTEGER loses precision.
 *
 *   migrationOrder(a, b)   the comparator for Array.sort over file names
 */
const numberOf = (f) => parseInt(String(f).split("_")[0], 10);

export const migrationOrder = (a, b) => {
  const x = numberOf(a), y = numberOf(b), nx = Number.isNaN(x), ny = Number.isNaN(y);
  if (nx !== ny) return nx ? 1 : -1;
  if (!nx && x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
