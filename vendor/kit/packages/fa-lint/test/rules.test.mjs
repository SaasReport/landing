// The rule pack proves itself (docs/PERSIAN.md): every rule's fail examples fail with that rule, every pass example passes it,
// every recorded correction's before/after is among them, and every autofix really fixes. One subtest per rule, so a broken
// rule is named in the test output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { KIT_RULES, compile, mergeClasses } from "../src/index.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../../core/schemas/fa-rules.schema.json", import.meta.url), "utf8"));
const L = compile([KIT_RULES], mergeClasses(KIT_RULES.exampleClasses));

test("the kit's pack is valid kit.fa-rules.v1, ids are unique and every pattern compiles", () => {
  assert.deepEqual(formatProblems(createValidator([SCHEMA]).validate(KIT_RULES, SCHEMA.$id)), []);
  const ids = KIT_RULES.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of L.rules) assert.ok(r.re instanceof RegExp, r.id);
});

test("every owner correction is a rule: before fails, after passes, and the owner's ids are kept", () => {
  const owner = KIT_RULES.rules.filter((r) => r.source.kind === "owner-correction");
  assert.ok(owner.length >= 20, `only ${owner.length} owner-correction rules`);
  for (const id of ["FA-BI-CALQUE", "FA-VERBAL-NOUN-FIRST", "FA-ORDER-NOUN-NAME"]) assert.ok(KIT_RULES.rules.some((r) => r.ownerId === id), id);
  // the four corrections named in the brief, verbatim
  const fails = (s, id) => assert.ok(L.lint(s).some((f) => f.rule === id), `${id} misses «${s}»`);
  const passes = (s, id) => assert.ok(!L.lint(s).some((f) => f.rule === id), `${id} flags «${s}»`);
  fails("تصمیم‌های اثرگذار بی‌پاسخ به یک پرسش ساده", "fa-bi-calque");
  passes("تصمیم‌های اثرگذار بدون پاسخ دادن به یک پرسش ساده", "fa-bi-calque");
  fails("خسارت پرداخت", "fa-object-before-verbal-noun");
  passes("پرداخت خسارت", "fa-object-before-verbal-noun");
  fails("اکمی پروتکل", "fa-brand-before-head");
  passes("پروتکل اکمی", "fa-brand-before-head");
  fails("ده چالش فراخوان", "fa-numeral-noun-stack");
  passes("فراخوان برای حل ده چالش", "fa-numeral-noun-stack");
});

for (const rule of L.rules) {
  test(`rule ${rule.id}: fail examples fail, pass examples pass, in every register it applies to`, () => {
    for (const register of rule.registers) {
      for (const s of rule.examples.fail) assert.ok(L.lint(s, { register, only: [rule.id] }).length, `${register}: fail example passes: «${s}»`);
      for (const s of rule.examples.pass) assert.deepEqual(L.lint(s, { register, only: [rule.id] }).map((f) => f.match), [], `${register}: pass example fails: «${s}»`);
    }
    const register = rule.registers[0];
    if (rule.source.before) assert.ok(rule.examples.fail.includes(rule.source.before), "source.before is a fail example");
    if (rule.source.after) assert.ok(rule.examples.pass.includes(rule.source.after), "source.after is a pass example");
    if (rule.autofix) for (const s of rule.examples.fail) assert.deepEqual(L.lint(L.fix(s, { register }), { register, only: [rule.id] }), [], `autofix leaves «${s}»`);
  });
}
