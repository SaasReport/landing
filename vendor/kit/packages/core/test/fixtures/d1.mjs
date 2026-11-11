// Test helper: a D1-shaped adapter over node:sqlite (prepare().bind().first()/run() with meta.changes), with the witness schema applied.
import { DatabaseSync } from "node:sqlite";
import { withD1Limits } from "../../src/d1-limits.js";
import { WITNESS_SQL } from "../../src/witness.js";
export const d1 = () => { const db = withD1Limits(new DatabaseSync(":memory:")); db.exec(WITNESS_SQL); return { raw: db, prepare: (sql) => ({ bind: (...a) => ({ first: async () => db.prepare(sql).get(...a) ?? null, run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...a).changes) } }) }) }) }; };
