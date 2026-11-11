/**
 * @saasreport/widgets — every interactive widget is generated for its own project from that project's
 * widgets.spec.json (audiences, use cases, scenarios) and its contracts; the archetypes carry no content.
 *
 *   buildWidgets(specPath)      → { generated, json, out }       kit widgets build
 *   checkWidgets(specPath)      → { problems, widgets }          kit widgets check
 *   renderWidget / renderWidgetsBody                               static HTML (the site's `widgets` page type)
 *   ARCHETYPES, RUNTIME_FILE, THEME_FILE, SPEC_SCHEMA, GENERATED_SCHEMA_JSON, VOCABULARIES
 */
export { buildWidgets, loadSpec, specProblems, specSchemaFor, GENERATED_SCHEMA, ENGINE_VERSION } from "./build.js";
export { checkWidgets, foreignTerms, projectTerms, vocabularyLeaks, termPattern, TEXT_KEYS } from "./check.js";
export { kitRegistry, createRegistry, registryFor, unionRegistries, isRegistry, validateManifest, composeSpecSchema, resolveBySchema, Registry, PLUGIN_CONTRACT, PLUGIN_SCHEMA } from "./registry.js";
export { KIT_PLUGINS } from "./plugins/index.js";
export { HTML_KIT } from "./html-kit.js";
import { KIT_PLUGINS as _KIT } from "./plugins/index.js";
/** The kit's archetype ids (the registry is the authority: a project may add its own). */
export const ARCHETYPE_NAMES = _KIT.map((p) => p.id);
export { renderWidget, renderWidgetsBody, localDigits, latinDigits } from "./html.js";
export { CHROME, chromeFor } from "./chrome.js";
export { sampleOf, operation, loadSources } from "./sources.js";
export { parseExpr, evalExpr } from "./util.js";
export { gapProbe, measureGaps } from "./qa.js";
// imported, then exported: the canonical JavaScript grammar (tree-sitter) has no re-export with import attributes yet
import SPEC_SCHEMA from "../schemas/widgets-spec.schema.json" with { type: "json" };
import GENERATED_SCHEMA_JSON from "../schemas/widgets-generated.schema.json" with { type: "json" };
import VOCABULARIES from "../registry/vocabularies.json" with { type: "json" };
export { SPEC_SCHEMA, GENERATED_SCHEMA_JSON, VOCABULARIES };

export { RUNTIME_FILE, THEME_FILE, RUNTIME_DIR, KIT_PLUGIN_DIR } from "./files.js";
export { themeTemplate, runtimeFiles } from "./theme.js";
