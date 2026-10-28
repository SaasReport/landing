/** Minimal in-memory D1 for tests: UPDATE/SELECT with `col = ?|'lit'` and `col < ?|>` conditions joined by AND. */
export function fakeD1(tables = {}) {
  const db = { tables, log: [] };
  const val = (tok, args) => (tok === "?" ? args.shift() : /^\?\d+$/.test(tok) ? args.orig[Number(tok.slice(1)) - 1] : tok.replace(/^'(.*)'$/, "$1"));
  const where = (clause, args) => {
    if (!clause) return () => true;
    const conds = clause.split(/\s+AND\s+/i).map((c) => {
      const m = c.trim().match(/^(\w+)\s*(=|<=|>=|<|>)\s*(\?\d*|'[^']*')$/);
      if (!m) throw new Error(`fakeD1: unsupported condition ${c}`);
      return [m[1], m[2], val(m[3], args)];
    });
    return (row) => conds.every(([c, op, v]) => ({ "=": row[c] === v, "<": row[c] < v, ">": row[c] > v, "<=": row[c] <= v, ">=": row[c] >= v })[op]);
  };
  db.prepare = (sql) => {
    let bound = [];
    const stmt = {
      bind: (...a) => { bound = a; return stmt; },
      async run() {
        db.log.push([sql, bound]);
        const args = [...bound]; args.orig = bound;
        const u = sql.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/is);
        if (!u) throw new Error(`fakeD1: unsupported ${sql}`);
        const sets = u[2].split(",").map((s) => { const [c, t] = s.split("=").map((x) => x.trim()); return [c, val(t, args)]; });
        const ok = where(u[3], args);
        let changes = 0;
        for (const row of Object.values(db.tables[u[1]] || {})) if (ok(row)) { for (const [c, v] of sets) row[c] = v; changes++; }
        return { success: true, meta: { changes } };
      },
      async all() {
        db.log.push([sql, bound]);
        const args = [...bound]; args.orig = bound;
        const s = sql.match(/^SELECT \* FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY \w+)?(?: LIMIT (\?\d*))?$/is);
        if (!s) throw new Error(`fakeD1: unsupported ${sql}`);
        const ok = where(s[2], args);
        const limit = s[3] ? val(s[3], args) : Infinity;
        return { results: Object.values(db.tables[s[1]] || {}).filter(ok).slice(0, limit).map((r) => ({ ...r })) };
      },
    };
    return stmt;
  };
  return db;
}
