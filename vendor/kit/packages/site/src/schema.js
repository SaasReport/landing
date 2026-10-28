/**
 * JSON Schema validation for site config, so a project's data is checked against a published schema before anything is
 * rendered: no project content hard-coded in templates, and a typo in config fails the build instead of reaching a page.
 * One validator for the whole kit (docs/CONSTITUTION.md §2): this is @saasreport/core/schema (JSON Schema 2020-12)
 * under the names the site package has always exported.
 *
 *   validateSchema(value, schema)  → [{ path: "/items/0/tone", message: "must be one of \"ok\", \"warn\" …" }]   ([] when valid)
 *   assertSchema(value, schema, where)  throws an Error listing every problem
 */
import { validate } from "@saasreport/core/schema";

/** Problems with a value against a JSON Schema, [] when it is valid (the root's path is "/"). */
export function validateSchema(value, schema) {
  return validate(value, schema).map((p) => ({ path: p.path || "/", message: p.message }));
}

/** Throw an Error listing every problem of a value against a schema; returns the value when it is valid. */
export function assertSchema(value, schema, where = "config") {
  const problems = validateSchema(value, schema);
  if (problems.length) throw new Error(`${where} does not match ${schema.$id || schema.title || "its schema"}:\n${problems.map((p) => `  ${p.path}: ${p.message}`).join("\n")}`);
  return value;
}
