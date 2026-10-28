// The one JSON Schema validator (src/schema.js) and the bundled schema registry (schemas/index.json): every entry exists,
// carries its $id and title, compiles, and the kit's own theme line matches kit.diagram-theme.v1. Real artefacts (configs,
// packs, manifests) are validated by the kit's kit.canon.json through `kit check schemas`, not by copies here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createValidator, validate, formatProblems, EXTENSIONS } from "../src/schema.js";
import { TOP_KEYS, FEATURES } from "../src/config.js";

const here = (p) => new URL(p, import.meta.url);
const json = (p) => JSON.parse(readFileSync(here(p), "utf8"));
const index = json("../schemas/index.json");
const load = (e) => json(`../schemas/${e.file}`);

test("validator: types, formats, combinators, $ref by pointer and by $id", () => {
  const a = { $id: "urn:t:a", type: "object", required: ["n"], properties: { n: { type: "integer", minimum: 1 }, d: { type: "string", format: "date" },
    c: { type: "string", format: "hex-color" }, k: { $ref: "#/$defs/k" }, o: { oneOf: [{ type: "string" }, { type: "number" }] } }, additionalProperties: false, $defs: { k: { enum: ["x", "y"] } } };
  const b = { $id: "urn:t:b", type: "array", items: { $ref: "urn:t:a" }, uniqueItems: true };
  const v = createValidator([a, b]);
  assert.deepEqual(v.validate([{ n: 2, d: "2026-10-01", c: "#FF5A00", k: "x", o: 1 }], "urn:t:b"), []);
  const p = formatProblems(v.validate([{ n: 0, d: "2026-02-30", c: "orange", k: "z", o: true, extra: 1 }, { n: 0, d: "2026-02-30", c: "orange", k: "z", o: true, extra: 1 }], "urn:t:b"));
  for (const re of [/\/0\/n: must be ≥ 1/, /\/0\/d: must be a valid date/, /\/0\/c: must be a valid hex-color/, /\/0\/k: must be one of/, /\/0\/o: must match one of 2/, /\/0\/extra: unknown property/, /^\/: items must be unique/])
    assert.ok(p.some((x) => re.test(x)), `${re}\n${p.join("\n")}`);
  assert.deepEqual(validate({ n: 1 }, a), []);
  assert.throws(() => validate({}, { $ref: "urn:nope" }), /unresolved \$ref "urn:nope" at \/\$ref/);
  assert.deepEqual(validate("x", { if: { const: "x" }, then: { minLength: 2 } }).length, 1);
});

test("registry: every bundled schema exists, has its $id and title, and compiles", () => {
  const names = new Set();
  for (const e of index.schemas) {
    assert.ok(!names.has(e.name), `duplicate name ${e.name}`); names.add(e.name);
    assert.ok(existsSync(here(`../schemas/${e.file}`)), `${e.file} missing`);
    const s = load(e);
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", `${e.name}: 2020-12`);
    assert.ok(s.$id.endsWith(e.file.replace(/^(\.\.\/)+/, "")), `${e.name}: $id ${s.$id} must end with its path`);
    assert.match(s.title, /^kit\.[a-z0-9.-]+\.v\d+$/, `${e.name}: title kit.<name>.v<n>`);
    assert.ok(s.description?.length > 20, `${e.name}: a description`);
    assert.ok(e.describes && e.gate, `${e.name}: describes and gate`);
  }
  const v = createValidator(index.schemas.map(load));
  for (const e of index.schemas) assert.ok(Array.isArray(v.validate({}, load(e).$id)), e.name);
});

test("kit-config schema: top-level keys and features are exactly core's", () => {
  const s = load(index.schemas.find((e) => e.name === "kit-config"));
  assert.deepEqual(Object.keys(s.properties).sort(), [...TOP_KEYS].sort());
  assert.deepEqual([...s.properties.features.propertyNames.enum].sort(), [...FEATURES].sort());
});

test("diagram-theme schema: the kit's theme.init line is valid", () => {
  const line = readFileSync(here("../../../docs/diagrams/theme.init"), "utf8").split("\n")[0];
  const init = JSON.parse(line.replace(/^%%\{init:\s*/, "").replace(/\}%%\s*$/, ""));
  assert.deepEqual(validate(init, load(index.schemas.find((e) => e.name === "diagram-theme"))), []);
});

test("project registry: valid, keys = full prefixes, and no prefix or short is used twice anywhere", () => {
  const reg = json("../registry/projects.json");
  assert.deepEqual(validate(reg, load(index.schemas.find((e) => e.name === "projects"))), []);
  // ONE multiset of every full prefix and every short, across all projects: a value twice is a collision (a full prefix of one project
  // equal to another's short, two full prefixes alike), except a project whose short IS its own full prefix (counted once)
  const values = [];
  for (const p of reg.projects) {
    assert.equal(`${p.key}-`, p.prefix, p.key);
    values.push(p.prefix);
    if (p.short && p.short !== p.prefix) values.push(p.short);
  }
  for (const l of reg.legacy || []) values.push(l.prefix);
  const dup = values.filter((v, i) => values.indexOf(v) !== i);
  assert.deepEqual(dup, [], `prefixes used twice: ${dup.join(", ")}`);
});

test("project registry: the multiset check itself fails on a full prefix equal to another project's short, and on two equal full prefixes", () => {
  const dups = (projects) => { const v = []; for (const p of projects) { v.push(p.prefix); if (p.short && p.short !== p.prefix) v.push(p.short); } return v.filter((x, i) => v.indexOf(x) !== i); };
  assert.deepEqual(dups([{ prefix: "a-", short: "b-" }, { prefix: "b-", short: null }]), ["b-"]);
  assert.deepEqual(dups([{ prefix: "a-", short: null }, { prefix: "a-", short: null }]), ["a-"]);
  assert.deepEqual(dups([{ prefix: "acme-", short: "acme-" }, { prefix: "a-", short: "x-" }]), []);
});

test("project registry: a project that decided it has NO short form (shortPolicy none) cannot carry one; the table says 'by decision'", async () => {
  const reg = json("../registry/projects.json");
  const schema = load(index.schemas.find((e) => e.name === "projects"));
  for (const key of ["saasreport"]) { const p = reg.projects.find((x) => x.key === key); assert.equal(p.shortPolicy, "none", key); assert.ok(p.short == null, key); }
  // must fail: a short on a no-short project (a later "swc-" cannot slip in), and a shortPolicy other than none
  const withShort = structuredClone(reg); withShort.projects.find((p) => p.key === "saasreport").short = "sr-";
  assert.ok(validate(withShort, schema).length > 0, "a short prefix on a shortPolicy none project is refused");
  const odd = structuredClone(reg); odd.projects.find((p) => p.key === "saasreport").shortPolicy = "later";
  assert.ok(validate(odd, schema).length > 0, "only none is a policy");
  // must pass: the registry as it is, and a project with a short and no policy
  assert.deepEqual(validate(reg, schema), []);
  const { table } = await import("../scripts/registry-table.mjs");
  const t = table(reg);
  assert.match(t, /\| SaasReport \| saasreport\.ai \| `saasreport-` \| \(none, by decision\) \|/);
  const undecided = structuredClone(reg); delete undecided.projects[0].shortPolicy;
  assert.match(table(undecided), /\| SaasReport \| saasreport\.ai \| `saasreport-` \| \(none yet\) \|/, "no decision recorded: still 'none yet'");
});

test("claude-policy schema: registered, and the kit's defaults file is valid and complete", () => {
  const entry = index.schemas.find((e) => e.name === "claude-policy");
  assert.ok(entry, "claude-policy is in the registry");
  const s = load(entry);
  const v = createValidator(index.schemas.map(load));
  const defaults = json("../registry/claude.policy.json");
  assert.deepEqual(v.validate(defaults, s), []);
  assert.deepEqual(v.validate(defaults, { $ref: `${s.$id}#/$defs/complete` }), []);
  assert.ok(v.validate({ $schema: s.$id }, { $ref: `${s.$id}#/$defs/complete` }).length, "an empty policy is not complete");
  assert.ok(v.validate({ ...defaults, extends: "kit" }, s).length, "an overriding file cannot carry `managed`");
});

test("formatMinimum / formatMaximum compare a date or date-time to a bound; an unreadable bound or value is refused, never passed", () => {
  const s = { type: "string", format: "date", formatMinimum: "2026-10-07", formatMaximum: "2026-12-31" };
  for (const ok of ["2026-10-07", "2026-11-19", "2026-12-31"]) assert.deepEqual(validate(ok, s), [], ok);
  for (const bad of ["2026-10-06", "2027-01-01"]) assert.equal(validate(bad, s).length, 1, bad);
  assert.equal(validate("2026-11-19", { type: "string", format: "date", formatMinimum: "tomorrow" }).length, 1, "a bound that is not a date");
  assert.equal(validate("2026-11-19", { type: "string", formatMinimum: "2026-10-07" }).length, 1, "a bound without the format it is read in");
  const dt = { type: "string", format: "date-time", formatMinimum: "2026-10-07T10:00:00Z" };
  assert.deepEqual(validate("2026-10-07T12:00:00+01:00", dt), []);
  assert.equal(validate("2026-10-07T08:00:00Z", dt).length, 1);
});

test("a keyword the validator does not implement throws, naming the keyword and its JSON pointer: never a silent pass (constitution §11)", () => {
  for (const [schema, keyword, at] of [
    [{ type: "object", unevaluatedProperties: false }, "unevaluatedProperties", "/unevaluatedProperties"],
    [{ properties: { a: { items: { unevaluatedItems: false } } } }, "unevaluatedItems", "/properties/a/items/unevaluatedItems"],
    [{ allOf: [{ type: "string" }, { dependentSchemas: {} }] }, "dependentSchemas", "/allOf/1/dependentSchemas"],
    [{ $defs: { x: { definitions: {} } }, $ref: "#/$defs/x" }, "definitions", "/$defs/x/definitions"],
    [{ if: { required: ["a"] }, then: { contentMediaType: "x" } }, "contentMediaType", "/then/contentMediaType"],
    [{ properties: { "a/b": { not: { contentEncoding: "base64" } } } }, "contentEncoding", "/properties/a~1b/not/contentEncoding"],
  ]) {
    assert.throws(() => validate({}, schema), (e) => e.message.includes(`"${keyword}"`) && e.message.includes(at), `${keyword}: ${JSON.stringify(schema)}`);
    assert.throws(() => createValidator([{ $id: "urn:x", ...schema }]).validate({}, "urn:x"), /unsupported keyword/);
  }
  // data is not schema: a property named like a keyword, const, enum, default and examples hold values
  assert.deepEqual(validate({ minContains: 1 }, { properties: { minContains: { const: 1 } }, const: { unevaluatedProperties: 1 }, default: { x: 1 } }).length, 1);
});

test("every annotation keyword is a declared no-op and passes", () => {
  const s = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "urn:x:annot", $comment: "c", title: "t", description: "d", examples: [1], default: 1, deprecated: true, readOnly: true, writeOnly: false, $defs: { a: { title: "a" } }, type: "integer" };
  assert.deepEqual(validate(1, s), []);
  assert.equal(validate("x", s).length, 1);
});

test("minContains / maxContains count the items that match contains; the four named extensions are declared no-ops and a typo of one is refused", () => {
  const s = { type: "array", contains: { const: 1 }, minContains: 2, maxContains: 3 };
  assert.deepEqual(validate([1, 1, 2], s), []);
  assert.equal(validate([1, 2], s).length, 1);
  assert.equal(validate([1, 1, 1, 1], s).length, 1);
  assert.equal(validate([], { contains: { const: 1 }, minContains: 0 }).length, 0);
  assert.deepEqual(validate(1, { type: "integer", "x-trigger-by-origin": { a: 1 } }), []);
  assert.throws(() => validate(1, { type: "integer", "x-trigger-by-orgin": {} }), /unsupported keyword "x-trigger-by-orgin"/);
  assert.deepEqual(Object.keys(EXTENSIONS).sort(), ["x-allowed-only-by-origin", "x-minTau2OverTau1", "x-required-by-origin", "x-trigger-by-origin"]);
});

// #124 review: three holes the validator left open, each now refused (an error), never ignored.
test("array-form items (the pre-2020-12 tuple form) is refused: it would be ignored and pass what it was written to refuse", () => {
  assert.throws(() => validate(["x"], { type: "array", items: [{ type: "integer" }] }), /array-form items at \/items.*prefixItems/);
  assert.throws(() => validate({}, { properties: { a: { items: [{ type: "string" }] } } }), /array-form items at \/properties\/a\/items/);
  assert.throws(() => createValidator([{ $id: "urn:x:tuple", $defs: { t: { items: [true] } } }]), /array-form items at \/\$defs\/t\/items/);
  assert.deepEqual(validate(["x", 1], { prefixItems: [{ type: "string" }], items: { type: "integer" } }), []);
  assert.equal(validate(["x", "y"], { prefixItems: [{ type: "string" }], items: { type: "integer" } }).length, 1);
  assert.throws(() => validate(1, { properties: "no" }), /properties at \/properties must be an object of schemas/);
  assert.throws(() => validate(1, { allOf: {} }), /allOf at \/allOf must be a list of schemas/);
  assert.throws(() => validate(1, { not: 3 }), /not at \/not must be a schema/);
});

test("a $ref must reach a schema: a pointer into const, enum, default or a keyword's own list is an error, not data used as a schema", () => {
  const doc = (ref) => ({ $id: "urn:x:ref", $defs: { data: { const: { a: { type: "string" } }, enum: [{ type: "integer" }], default: { type: "null" } }, ok: { type: "string" }, deep: { properties: { p: { type: "integer" } } } }, properties: { x: { $ref: ref } } });
  for (const bad of ["#/$defs/data/const/a", "#/$defs/data/enum/0", "#/$defs/data/default", "#/$defs", "#/$defs/missing", "#/properties", "#/$defs/deep/properties", "#/$defs/deep/type", "#name", "#/$defs/%E0", "#/"]) {
    assert.throws(() => validate({ x: "s" }, doc(bad)), /unresolved \$ref/, bad);
  }
  // the references that reach a schema still resolve
  for (const good of ["#/$defs/ok", "#/$defs/deep/properties/p", "#", "urn:x:ref#/$defs/ok"]) {
    const v = createValidator([doc(good)]);
    assert.ok(!v.validate({ x: 1 }, "urn:x:ref").some((e) => /unresolved/.test(e.message)), good);
  }
  assert.deepEqual(validate({ x: "s" }, doc("#/$defs/ok")), []);
  assert.equal(validate({ x: 1 }, doc("#/$defs/ok")).length, 1);
});

test("an unknown format is refused (it would pass every value); every implemented format, and one added through the options, is accepted", () => {
  for (const f of ["uuid", "int64", "ipv4", "Date", "", "regex"]) assert.throws(() => validate("x", { type: "string", format: f }), /unknown format/, f);
  assert.throws(() => validate("x", { properties: { a: { format: "nope" } } }), /unknown format "nope" at \/properties\/a\/format/);
  assert.throws(() => validate("x", { format: 3 }), /unknown format 3/);
  for (const f of ["date", "date-time", "uri", "uri-reference", "email", "hex-color"]) assert.doesNotThrow(() => validate("x", { format: f }), f);
  const v = createValidator([{ $id: "urn:x:fmt", format: "even" }], { formats: { even: (s) => s.length % 2 === 0 } });
  assert.deepEqual(v.validate("ab", "urn:x:fmt"), []);
  assert.equal(v.validate("abc", "urn:x:fmt").length, 1);
  // a property named "format" is a name, not the keyword
  assert.deepEqual(validate({ format: "anything" }, { properties: { format: { type: "string" } } }), []);
});

// #124 confirming review of d03de25: a schema is checked whole at registration, not only the branches an instance reaches.
test("every $ref is resolved at registration: a dangling or data-pointing $ref in a branch no instance reaches is an error", () => {
  const defs = { data: { const: { type: "string" } }, ok: { type: "string" } };
  for (const bad of ["#/$defs/data/const", "#/$defs/missing", "#nowhere", "urn:x:none#/$defs/a"]) {
    assert.throws(() => validate(1, { $defs: defs, if: { const: 99 }, then: { $ref: bad } }), /unresolved \$ref/, `then: ${bad}`);
    assert.throws(() => validate(1, { $defs: defs, anyOf: [true, { properties: { a: { items: { $ref: bad } } } }] }), /unresolved \$ref/, `deep: ${bad}`);
    assert.throws(() => createValidator([{ $id: "urn:x:late", $defs: defs, not: { $ref: bad } }]), /unresolved \$ref/, `registered: ${bad}`);
  }
  assert.deepEqual(validate(1, { $defs: defs, if: { const: 99 }, then: { $ref: "#/$defs/ok" }, type: "integer" }), []);
  // a $ref to a schema registered later in the same list still resolves
  const v = createValidator([{ $id: "urn:x:a", $ref: "urn:x:b" }, { $id: "urn:x:b", type: "string" }]);
  assert.equal(v.validate(1, "urn:x:a").length, 1);
});

test("a malformed value of an implemented keyword is an error, never ignored or coerced", () => {
  const bad = [
    [{ enum: "abc" }, /enum at \/enum must be an array/], [{ enum: { a: 1 } }, /enum at \/enum must be an array/],
    [{ required: "id" }, /required at \/required must be a list of strings/], [{ required: [1] }, /required at \/required must be a list of strings/],
    [{ dependentRequired: { a: "b" } }, /dependentRequired at \/dependentRequired\/a must be a list of strings/], [{ dependentRequired: [] }, /dependentRequired at \/dependentRequired must be an object/],
    [{ minLength: "3" }, /minLength at \/minLength must be a non-negative integer/], [{ maxItems: -1 }, /maxItems at \/maxItems must be a non-negative integer/], [{ minProperties: 1.5 }, /minProperties/],
    [{ minimum: "1" }, /minimum at \/minimum must be a finite number/], [{ multipleOf: 0 }, /multipleOf at \/multipleOf must be a number above 0/],
    [{ uniqueItems: "yes" }, /uniqueItems at \/uniqueItems must be a boolean/],
    [{ type: "strng" }, /type at \/type must be/], [{ type: [] }, /type at \/type must be/], [{ type: 3 }, /type at \/type must be/],
    [{ pattern: 3 }, /pattern at \/pattern must be a string/], [{ pattern: "(" }, /pattern at \/pattern is not a regular expression/],
    [{ patternProperties: { "(": true } }, /patternProperties at \/patternProperties\/\( is not a regular expression/],
    [{ $ref: 3 }, /\$ref at \/\$ref must be a string/], [{ formatMinimum: 3, format: "date" }, /formatMinimum at \/formatMinimum must be a string/],
    [{ enum: [{ $bind: "runner" }] }, /\$bind at \/enum\/0 is not substituted/], [{ const: { a: [{ $bind: "x" }] } }, /\$bind at \/const\/a\/0 is not substituted/],
    [{ properties: { a: { required: "id" } } }, /\/properties\/a\/required/],
  ];
  for (const [schema, message] of bad) assert.throws(() => validate({}, schema), message, JSON.stringify(schema));
  assert.deepEqual(validate({ id: "a" }, { type: ["object", "null"], required: ["id"], minProperties: 1, dependentRequired: { id: [] }, enum: [{ id: "a" }], pattern: "^x", multipleOf: 0.5, uniqueItems: false }), []);
});

test("an extension keyword names the test file that fails when its rule is broken: the path exists", () => {
  for (const [name, test_] of Object.entries(EXTENSIONS)) {
    assert.match(test_, /^packages\/[a-z0-9-]+\/test\/[a-z0-9.-]+\.test\.mjs$/, `${name}: a test file path, not free text`);
    assert.ok(existsSync(here(`../../../${test_}`)), `${name}: ${test_} does not exist`);
  }
});

test("github-branch-glob-excludes-archive evaluates GitHub's filter syntax against the archive branch family, decided existentially by the pattern (text before the first ** compiled; else first segment plus two more segments), never by a list of sample branches", async () => {
  const { validate, githubGlobRe } = await import("../src/schema.js");
  const ok = (g) => validate(g, { type: "string", format: "github-branch-glob-excludes-archive" }).length === 0;
  for (const g of ["**", "*/**", "a*/**", "**/x", "**/release", "**/prod", "archive/**", "archive/*/x", "archive/*/*", "archive/2026-10-13/x", "archive/2026-10-14/**", "archive/**/prod", "arch*/**/x", "archive/[0-9]*/x", "[a]rchive/**"]) assert.equal(ok(g), false, `${g} matches an archive branch`);
  for (const g of ["main", "release-records/**", "resilience-records/**", "releases/**", "claude/**", "archive*", "archive", "v*", "!archive/**", "arch?ve/**", "x/archive/**", "archive/x", "archive*/x"]) assert.equal(ok(g), true, `${g} matches no archive branch`);
  assert.ok(githubGlobRe("feature/*").test("feature/a") && !githubGlobRe("feature/*").test("feature/a/b"), "* stops at /");
  assert.ok(githubGlobRe("v1.?").test("v1") && githubGlobRe("v1.?").test("v1.") && !githubGlobRe("v1.?").test("v1x"), "? is zero or one of the preceding character, and . is literal");
});
