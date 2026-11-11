import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDirectoryJson } from "../src/generators/directory.js";

const tax = {
  tiers: [{ key: "policy", name: "Policy" }],
  categories: [{ key: "regulator", name: "Regulator", tier: "policy", color: "chart1" }],
  tags: [],
};
const ctx = {
  pathOf: (path) => path,
  colorHex: { chart1: "#0072B2" },
};
const base = {
  entries: [],
  tax,
  sectors: [],
  c: { json: {} },
  L: { lang: "en" },
  url: "https://example.org",
  ctx,
};

test("directory v2 publishes semantic colour roles without brand hex and satisfies its schema", () => {
  const doc = JSON.parse(renderDirectoryJson({ ...base, page: { path: "/directory/", json: { schema: "kit.directory.v2" } } }));
  assert.equal(doc.schema, "kit.directory.v2");
  assert.equal(doc.taxonomy.categories[0].colorRole, "chart1");
  assert.equal(Object.hasOwn(doc.taxonomy.categories[0], "color"), false);
  assert.doesNotMatch(JSON.stringify(doc), /#[0-9a-f]{6}/i);
});

test("directory v1 retains resolved colours for compatibility with existing clients", () => {
  const doc = JSON.parse(renderDirectoryJson({ ...base, page: { path: "/directory/" } }));
  assert.equal(doc.schema, "kit.directory.v1");
  assert.equal(doc.taxonomy.categories[0].color, "#0072B2");
  assert.equal(doc.taxonomy.categories[0].colorRole, "chart1");
});
