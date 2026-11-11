/**
 * @saasreport/workbench: the workbench archetype, after the Gloomberb pattern (a command line, panes, watchlists), built natively.
 * No content of its own: every command, pane and source comes from the project's widgets.spec.json (export `workbench`).
 *
 *   workbenchChunks(def, strings) → { first, panes, last }         server-rendered page in flushable chunks
 *   workbenchProblems(def)        → string[]                        schema + cross-checks of a resolved definition
 *   buildDefinition(raw, { text, asOf, locale })                    spec → validated definition (kit widgets build)
 *   runtimeSource() / loadRuntime()                                 the browser script / its pure API in a vm
 *   SCHEMAS, ENVELOPE_SCHEMA, COMMANDS_SCHEMA, WORKBENCH_SCHEMA     JSON Schema 2020-12
 */
export { workbenchChunks, renderWorkbenchBody, badge } from "./render.js";
export { workbenchProblems, validator, SCHEMAS, ENVELOPE_SCHEMA, COMMANDS_SCHEMA, WORKBENCH_SCHEMA } from "./define.js";
export { buildDefinition, resolveWorkbench, TEXT_KEYS } from "./spec.js";
export { runtimeSource, loadRuntime } from "./runtime.js";
export { chromeFor, CHROME } from "./chrome.js";
