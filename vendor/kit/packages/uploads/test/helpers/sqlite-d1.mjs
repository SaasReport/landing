// A D1-shaped adapter over a real SQLite (node:sqlite): the migration files are executed as written, so a test runs the SQL, not a model of it.
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "@saasreport/core/d1-limits";

export function sqliteD1() {
  const db = withD1Limits(new DatabaseSync(":memory:"));
  return {
    db,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const st = db.prepare(sql);
      return { bind: (...a) => ({
        run: async () => { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; },
        first: async () => st.get(...a) ?? null,
        all: async () => ({ results: st.all(...a) }),
      }) };
    },
  };
}
