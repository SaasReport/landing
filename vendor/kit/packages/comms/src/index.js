/**
 * @saasreport/comms — a project's outbound email from one comms config: the comms-engine spec files
 * (manifest, blocks, links, providers), the Worker runtime, wrangler.toml for the two Workers, and previews.
 * Pure (no I/O); file writing is in "@saasreport/comms/node".
 */
export { LOCALE_PACKS, DEFAULT_COLORS, DEFAULT_FONT, resolveConfig, checkConfig, todos, colorsFromTokens, langOf, emailRoles, emailContrast, emailContrastProblems } from "./config.js";
export { buildSpecs, specFiles, templateId, ids } from "./specs.js";
export { engineRuntime, copyrightYears } from "./runtime.js";
export { wranglerToml, mailSenderOptions } from "./wrangler.js";
export { submitForm, readDelivery, deliverySummary, ledgerUrl, recordOf, ownerSecretProblems, requiredEngineSecrets } from "@saasreport/core/form-deliveries";
export { renderPreviews, sampleParams, previewIndex } from "./preview.js";
export { fieldsHtml, fieldsText, stepsHtml, styler } from "./html.js";
export { compileTemplate } from "../workers/comms-engine/compiler.js";
export {
  NOTICE_LIBRARY, AUDIENCES, JURISDICTIONS, DRAFT_STATUS, JURISDICTION_STATUS, checkNotices, noticeBlocks, selectNotices,
  noticeSelection, noticeTodos, noticeValues, noticePlaceholders, noticePageStrings, fillNotice, jurisdictionStatus,
} from "./notices.js";
