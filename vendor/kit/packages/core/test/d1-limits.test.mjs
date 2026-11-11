// The D1 limits the local tests run under (src/d1-limits.js): every way past them that the #122 confirming review found (M6)
// is refused here, and nothing D1 accepts is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { D1_LIMITS, sqlStatements, unsupportedProblems as unsupportedProblemsOf, withD1Limits } from "../src/d1-limits.js";

const db = () => withD1Limits(new DatabaseSync(":memory:"));
const long = "x".repeat(D1_LIMITS.likePatternBytes + 1);
const ok = "x".repeat(D1_LIMITS.likePatternBytes);

test("a LIKE pattern longer than D1 allows fails, also after PRAGMA case_sensitive_like re-registers SQLite's own like()", () => {
  for (const pragma of [null, "PRAGMA case_sensitive_like = ON", "PRAGMA case_sensitive_like = OFF"]) {
    const d = db();
    if (pragma) d.exec(pragma);
    assert.throws(() => d.prepare(`SELECT 'a' LIKE '${long}' AS m`).get(), /pattern too complex/, String(pragma));
    assert.equal(d.prepare(`SELECT 'A' LIKE 'a' AS m`).get().m, pragma === "PRAGMA case_sensitive_like = ON" ? 0 : 1, `${pragma}: SQLite's own semantics`);
    assert.equal(d.prepare(`SELECT '${ok}' LIKE '${ok}' AS m`).get().m, 1);
  }
  const p = db();
  p.prepare("PRAGMA case_sensitive_like = ON").run();
  assert.throws(() => p.prepare(`SELECT 'a' LIKE '${long}' AS m`).get(), /pattern too complex/, "the pragma as a prepared statement");
});

test("bound parameters are counted from the SQL and from every argument, named object and positional together", () => {
  const d = db();
  const many = Array.from({ length: D1_LIMITS.boundParameters + 1 }, (_, i) => `?${i + 1}`).join(", ");
  assert.throws(() => d.prepare(`SELECT ${many}`), /bound parameters/, "placeholders in the SQL");
  const named = Array.from({ length: D1_LIMITS.boundParameters + 1 }, (_, i) => `:p${i}`).join(", ");
  assert.throws(() => d.prepare(`SELECT ${named}`), /bound parameters/, "named placeholders in the SQL");
  const st = d.prepare("SELECT ?1 AS a, :b AS b");
  const big = "y".repeat(D1_LIMITS.valueBytes + 1);
  assert.throws(() => st.get({ b: 1 }, big), /value bytes/, "a value after the named object");
  assert.deepEqual({ ...st.get({ b: 2 }, 1) }, { a: 1, b: 2 });
  assert.equal(d.prepare(`SELECT ${Array.from({ length: D1_LIMITS.boundParameters }, () => "?").join(", ")}`).all(...Array(D1_LIMITS.boundParameters).fill(1)).length, 1);
});

test("exec measures each statement of a script: a long script of short statements runs, one long statement fails", () => {
  const d = db();
  d.exec("CREATE TABLE t (v TEXT)");
  const row = `INSERT INTO t VALUES ('${"z".repeat(1000)}');\n`;
  d.exec(row.repeat(Math.ceil(D1_LIMITS.statementBytes / row.length) + 5));
  assert.ok(d.prepare("SELECT count(*) AS n FROM t").get().n > 100);
  assert.throws(() => d.exec(`SELECT 1; SELECT '${"z".repeat(D1_LIMITS.statementBytes)}';`), /statement bytes/);
  d.exec("CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 1 END; SELECT ';'; END; SELECT 1 -- ; comment\n;");
});

test("sqlStatements: a CREATE TRIGGER preceded by comments is still one statement (its BEGIN ... END holds semicolons)", async () => {
  const { sqlStatements } = await import("../src/d1-limits.js");
  const sql = "-- why this trigger exists; a comment with a semicolon\n/* and a block; comment */\nCREATE TRIGGER t BEFORE INSERT ON x\nBEGIN SELECT RAISE(ABORT, 'no'); END;\nSELECT 1;\n";
  const out = sqlStatements(sql);
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.match(out[0], /BEGIN SELECT RAISE\(ABORT, 'no'\); END;$/);
});

test("MUST FAIL (review of e865a625): commentProblems reads block comments with the one tokenizer: a quote in one is not a finding, a -- inside one is not a comment, and a real -- comment after one is still found", async () => {
  const { commentProblems } = await import("../src/d1-limits.js");
  assert.deepEqual(commentProblems("/* it's */\n-- bad; here\nSELECT 1;").map((f) => [f.line, f.chars]), [[2, [";"]]], "the fail-open probe");
  assert.deepEqual(commentProblems("/* a -- b; c */\nSELECT 1;"), [], "the false-positive probe");
  assert.deepEqual(commentProblems("SELECT '-- not; a comment', \"it's\";"), []);
});

test("MUST FAIL: every entry of registry/d1-unsupported.json is refused by exec AND by prepare().run(), cites a Cloudflare page, and has its own must-fail sample", async () => {
  const { unsupportedProblems } = await import("../src/d1-limits.js");
  const R = D1_LIMITS.unsupported;
  // one sample per refusal id; an entry added to the registry without a sample here fails this test
  const SAMPLE = {
    "explicit-transaction": ["BEGIN TRANSACTION", "BEGIN", "COMMIT", "END TRANSACTION", "ROLLBACK", "SAVEPOINT a", "RELEASE a"],
    "attach-detach": ["ATTACH DATABASE ':memory:' AS other", "DETACH DATABASE other"],
    vacuum: ["VACUUM"],
    "load-extension": ["SELECT load_extension('x')"],
    "virtual-table-module": ["CREATE VIRTUAL TABLE v USING rtree(id, a, b)", "CREATE VIRTUAL TABLE v USING"],
    "pragma-unsupported": ["PRAGMA writable_schema = ON", "PRAGMA journal_mode = WAL", "PRAGMA main.user_version = 3"],
    "foreign-keys-off": ["PRAGMA foreign_keys=OFF", "pragma foreign_keys = 0", "PRAGMA main.foreign_keys(false)", "PRAGMA \"main\".foreign_keys = 'no'"],
  };
  const ids = [...R.statements.map((e) => e.id), ...R.functions.map((e) => e.id), ...R.pragmas.valueRefusals.map((e) => e.id), "virtual-table-module", "pragma-unsupported"];
  for (const e of [...R.statements, ...R.functions, R.virtualTables, R.pragmas, ...R.pragmas.valueRefusals]) assert.match(e.source, /^https:\/\/developers\.cloudflare\.com\/d1\//, "a Cloudflare source per entry");
  for (const id of ids) {
    assert.ok(SAMPLE[id]?.length, `registry entry ${id} has a must-fail sample`);
    for (const sql of SAMPLE[id]) {
      assert.equal(unsupportedProblems(sql)[0]?.id, id, sql);
      assert.throws(() => db().exec(`${sql};`), new RegExp(`D1 does not run this statement \\(${id}\\)`), `exec ${sql}`);
      assert.throws(() => db().prepare(sql).run(), new RegExp(`D1 does not run this statement \\(${id}\\)`), `prepare ${sql}`);
    }
  }
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...ids].sort(), "no sample without a registry entry");
  // what D1 runs stays allowed: every supported pragma as a read, foreign keys ON, defer, fts5, a trigger body that starts with BEGIN, words in comments and strings
  for (const name of R.pragmas.supported) assert.deepEqual(unsupportedProblems(`PRAGMA ${name}`), [], name);
  for (const sql of ["PRAGMA foreign_keys=ON;", "PRAGMA defer_foreign_keys = ON;", "CREATE VIRTUAL TABLE v USING fts5(a);", "CREATE TABLE t (a); CREATE TRIGGER x BEFORE INSERT ON t BEGIN SELECT 1; END;", "-- BEGIN\nSELECT 1;", "SELECT 'BEGIN', 'PRAGMA foreign_keys=OFF';", "/* VACUUM */ SELECT 1;"]) {
    assert.deepEqual(sqlStatementsProblems(sql), [], sql);
  }
});

const sqlStatementsProblems = (script) => sqlStatements(script).flatMap((st) => unsupportedProblemsOf(st));

test("MUST FAIL (review of 7fa30afa): a pattern is a literal only if every part is a '...' literal and the chain ends where an operand ends: a column, a call, a sub-select or a cast after || is not one, nor is a \"...\" identifier", async () => {
  const { patternProblems, patternOperands } = await import("../src/d1-limits.js");
  const sixty = "x".repeat(60);
  assert.equal(patternProblems(`CREATE TRIGGER t BEFORE INSERT ON a WHEN NEW.b GLOB 'abc' || '${sixty}' BEGIN SELECT 1; END;`).length, 1, "a real concatenation of literals is measured");
  assert.equal(patternProblems(`SELECT 1 WHERE b LIKE '${sixty}' ESCAPE '!'`).length, 1);
  assert.equal(patternProblems(`SELECT b LIKE '${sixty}' AS m FROM t`).length, 1);
  assert.equal(patternProblems(`SELECT glob('${sixty}', b)`).length, 1, "the glob() function form");
  assert.deepEqual(patternProblems("SELECT 1 WHERE b GLOB 'abc' || 'def'"), []);
  const lit = (sql) => patternOperands(sql).map((o) => o.literal);
  for (const tail of ["col", "upper(c)", "f('x')", "(SELECT 'y')", "CAST(c AS TEXT)", "?1", "\"id\""]) {
    assert.deepEqual(lit(`SELECT 1 WHERE b LIKE 'a' || ${tail}`), [false], `|| ${tail}`);
    assert.deepEqual(lit(`SELECT glob('a' || ${tail}, b)`), [false], `glob(.. || ${tail})`);
  }
  assert.deepEqual(lit(`SELECT 1 WHERE b LIKE "${sixty}"`), [false], "double quotes are an identifier first");
  for (const op of ["+ 1", "- 1", "* 2", "/ 2", "% 2", "|| c"]) assert.deepEqual(lit(`SELECT 1 WHERE b LIKE 'a' ${op}`), [false], `'a' ${op} extends the expression: not measurable`);
  // review of 62db4e32: COLLATE does not change the pattern, so a long literal with it is measured and reported
  assert.deepEqual(lit("SELECT 1 WHERE b LIKE 'a' COLLATE NOCASE"), [true]);
  assert.equal(patternProblems(`SELECT 1 WHERE b LIKE '${sixty}' COLLATE NOCASE`).length, 1, "MUST FAIL: >50 bytes with COLLATE is reported");
  assert.equal(patternProblems(`SELECT 1 WHERE b GLOB '${sixty}' ESCAPE 'x' ISNULL`).length, 1);
  assert.deepEqual(lit("SELECT 1 WHERE b LIKE 'a' || c COLLATE NOCASE"), [false], "MUST PASS: a literal joined to a column stays unmeasured");
  assert.equal(patternProblems(`SELECT 1 WHERE b LIKE "${sixty}"`).length, 0, "and is left to the not-a-literal refusal");
  assert.deepEqual(lit(`SELECT 1 WHERE b GLOB ('${sixty}')`), [false]);
  assert.deepEqual(lit("SELECT 1 WHERE b LIKE c.d AND e GLOB ?1"), [false, false]);
});

test("MUST FAIL (review of 7fa30afa): prepare() refuses what exec refuses, and a comment or a string that mentions PRAGMA case_sensitive_like does not reroute a statement", () => {
  assert.throws(() => db().prepare("BEGIN").run(), /explicit-transaction/);
  assert.throws(() => db().prepare("PRAGMA foreign_keys=OFF").run(), /foreign-keys-off/);
  assert.throws(() => db().prepare("PRAGMA writable_schema=ON").run(), /pragma-unsupported/);
  const d = db();
  d.exec("-- PRAGMA case_sensitive_like = 1\nSELECT 1;");
  d.prepare("SELECT 'PRAGMA case_sensitive_like=1' AS s").get();
  assert.equal(d.prepare("SELECT 'A' LIKE 'a' AS m").get().m, 1, "still SQLite's case-insensitive LIKE: nothing reached the second connection");
  d.exec("CREATE TABLE t (a); PRAGMA case_sensitive_like = 1;");
  assert.equal(d.prepare("SELECT 'A' LIKE 'a' AS m").get().m, 0, "the real pragma statement does");
});

test("MUST FAIL (review of 7fa30afa): isEmptyStatement and commentProblems read /* and -- from the one tokenizer: a /* inside a string hides nothing, and a statement of comments and semicolons is empty", async () => {
  const { isEmptyStatement, commentProblems } = await import("../src/d1-limits.js");
  assert.equal(isEmptyStatement("/* x; y */ ;"), true);
  assert.equal(isEmptyStatement("-- only; a comment\n;"), true);
  assert.equal(isEmptyStatement("SELECT 1;"), false);
  assert.equal(isEmptyStatement("/* a */ SELECT '/*';"), false);
  assert.deepEqual(commentProblems("SELECT '/*';\n-- bad; here\nSELECT 1;").map((f) => [f.line, f.chars]), [[2, [";"]]], "a /* in a string is not a block comment, so the real comment after it is found");
});
