/**
 * @saasreport/plugins: agent plugins for kit projects. Small, prefix-scoped skills that write real files into
 * ./<prefix>-out/<skill>/<run-id>/ with a compile report (kit.compile-report.v1) whose items are confirmed,
 * not_confirmed or flagged, on top of the project's engine, MCP server or public API.
 *   scaffoldPlugin(opts) → files map        (kit plugin new)
 *   validatePlugin(dir, opts) → problems[]  (kit plugin check)
 *   validateReport(report) → problems[]     (honest statuses, critic verdicts, risk 1-10 on flagged items)
 *   validateLearnings(jsonl) → problems[]   (learnings.jsonl, kit.plugin-learning.v1)
 *   parseFrontmatter(text), runtimeSource(), checkSource(), RUNTIME_PATH, CHECK_PATH, SCHEMA_PATH, PREFIXES
 */
export { parseFrontmatter } from "./frontmatter.js";
export { validatePlugin, validateReport, validateLearnings, PREFIXES, FULL_PREFIXES, REPORT_SCHEMA, LEARNING_SCHEMA, STATUSES, VERDICTS, LEARNING_KINDS } from "./validate.js";
export { scaffoldPlugin, skillMd } from "./scaffold.js";
export { RUNTIME_FILE, CHECK_FILE, RUNTIME_PATH, CHECK_PATH, SCHEMA_PATH, LEARNINGS_SCHEMA_PATH, runtimeSource, checkSource } from "./runtime.js";
