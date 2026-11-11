/**
 * @saasreport/site — the site theme: a landing page, its inner pages (terminal, lab, academy, partners, status,
 *   brand, sectors, directory, legal notices) and the surfaces of a product site (content pages from blocks, an
 *   OpenAPI reference, auth-gated app shells, a status board), the demo engines and page scripts, and the theme CSS, generated from tokens
 *   (colours, radii, fonts, logos), locale packs (fa, en, ar: direction, digits, numbers, dates, calendar, chrome
 *   strings) and structured content, strings and data per locale. One page per locale, hreflang alternates and a
 *   language switcher when there are several.
 *
 *   buildSite(project, { root, write }) → { files, out, locales }
 *   defineSite(project) → project (throws with every problem listed)
 */
import { checkProject } from "./validate.js";

export { buildSite, compareSite, projectLocales, TWINS_SCHEMA, TWINS_FILE } from "./build.js";
export { writeTwins } from "./twins-dir.js";
export { htmlToMarkdown, pageMarkdown, parseHtml, twinPath, twinLink, linkTwin, llmsIndex, llmsFullText } from "./markdown.js";
export { trademarker } from "./trademark.js";
export { checkProject, checkLanding, REQUIRED } from "./validate.js";
export { createLocale, checkLocale, LOCALES, DIGITS, CALENDARS, fill } from "./locale.js";
export { DEFAULT_TOKENS, resolveTokens, checkTokens, checkContrast, contrast, CONTRAST_PAIRS, derivedColors, surfaces, surfaceColours, surfaceSlots, contrastPairs, contrastGaps, ensureContrast, mix, WASHES, TEXT_ON, TONES, FILL_ROLES, SURFACE_ROLES, fontFaces, rgb, UI_ON, CHART_BASE, chartProblems, colourDistance, colorVars, colorRefs, colorRoles, roleVar, workerColors, toneStyle, fillOn } from "./tokens.js";
export { renderCss, readTheme, placeholders, THEME_CSS, EXTRA_THEME, THEME_DIR } from "./css.js";
export { renderPage, seoGraph, plain } from "./page.js";
export { SECTIONS } from "./sections/index.js";
export { ICONS } from "./icons.js";
export { renderTemplate, templateKeys, FILTERS } from "./template.js";
export { validateSchema, assertSchema } from "./schema.js";
export { ASSETS, ASSET_SCHEMAS, TERMINAL_VIEWS, TERMINAL_PARTS, CAST_ROLES, LAB_MISSIONS, renderAsset, assetSource, checkAssets } from "./assets.js";
export { PAGE_TYPES, renderTemplatePage, pageChrome, pageLd, menuFor } from "./pages.js";
export { buildRegistry, registryMenu, menuLinks, checkMenu, checkRegistry, registrySitemap, registryLlms, hubMembers, byUrl as registryByUrl, shortLabel, labelKey, TAXONOMY_SCHEMA, REGISTRY_SCHEMA, REGISTRY_VERSION } from "./registry.js";
export { crumbsHtml, footHtml, hubHtml, decorateHtml, decorateSite, crumbsLdNode, fileOfUrl, REGISTRY_CSS, REGISTRY_STRINGS } from "./registry-markup.js";
export { shellMarkup, searchIndex, writeSearchIndex, searchOptions, checkSearchIndex, INDEX_SCHEMA as SEARCH_INDEX_SCHEMA, SEARCH_CONFIG_SCHEMA, checkShell, headerSignature, navReach, shellProbe, contrastProbe, paintedContrast, fixedFlicker, terms as searchTerms, SEARCH_INDEX } from "./shell.js";
export { renderSectors, checkSectors } from "./generators/sectors.js";
export { renderDirectory, renderDirectoryPage, renderDirectoryJson, checkDirectory, normalize, CATEGORY_ROLES, DIRECTORY_SCHEMA_ID } from "./generators/directory.js";
export { renderNotices, checkNoticesPage } from "./generators/notices.js";
export { renderWidgetsPage, checkWidgetsPage } from "./generators/widgets.js";
export { renderWorkbenchPage, checkWorkbenchPage } from "./generators/workbench.js";
export { projectAssets, baseContext } from "./build.js";
export { renderContent, renderBlocks, contentBody, heroHtml, bandHtml, cardHtml, checkContent, CONTENT_BLOCKS } from "./generators/content.js";
export { renderReference, normalizeSpec, checkReference, referenceIndexJson, specId, opAnchor } from "./generators/reference.js";
export { renderApps, checkApps, APPS_SCRIPT } from "./generators/apps.js";
export { innerPage, webPageLd, crumbsLd, plainText, SURFACE_STYLES } from "./generators/shell.js";
export { APPS_STRINGS, STATUSBOARD_STRINGS, STATUSBOARD_SOURCES } from "./assets.js";

/** Validate a project up front (for site.config.js): returns it unchanged, or throws listing every problem. */
export function defineSite(project) {
  const problems = checkProject(project);
  if (problems.length) {
    const e = new Error(`site project has problems:\n  - ${problems.join("\n  - ")}`);
    e.name = "SiteConfigError";
    e.problems = problems;
    throw e;
  }
  return project;
}
export { preferredSourceCard, preferredDomain, preferredHref, checkPreferredSource, PREFERRED_SOURCE_SCHEMA, PREFERRED_SOURCE_URL, PREFERRED_PLACEMENTS, PREFERRED_CSS } from "./preferred.js";
