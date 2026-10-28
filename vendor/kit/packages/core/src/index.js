/**
 * @saasreport/core — pure building blocks of a kit site: config, content contracts, planner, calendar reports,
 * agenda, markdown, SEO, feeds, calendar links, i18n, ids, locales (multi-locale sites) and series tooling (review gate,
 * citations). Runs anywhere (Workers, Node, browsers).
 */
export { defineConfig, KitConfigError, DEFAULT_CONTRACTS, DEFAULT_PATHS, FEATURES, KINDS, EVERY, seriesById, speechOptions } from "./config.js";
export { loadContent, normalizeContent } from "./content.js";
export { checkTopic, checkReport, checkTerm, checkTalk, checkSources, checkContent, isSlot } from "./contracts.js";
export { planner, roundRobin } from "./planner.js";
export { calendarTables, weekReport, monthReport, buildPost, articleMd, calOptions, weekRange, publishAt } from "./reports.js";
export { agenda } from "./agenda.js";
export { markdown, renderMarkdown, toPlain, readingMinutes, escapeHtml } from "./markdown.js";
export { seo, org, website, graph, crumbs, jsonLdScript, sitemap, hreflangs, robots, llmsTxt, llmsTxtLocales, llmsFull, absUrl, xmlEscape, AI_BOTS } from "./seo.js";
export { locales, isLocalized, localize, localeBase, localesOf, isMultiLocale, isLocaleRoot, defaultLocaleOf, configFor, contentFor, isKeyedByLocale, localePath, eachLocale } from "./locales.js";
export { feeds, rss, podcastRss, podcastGuid, itunesDuration } from "./feeds.js";
export { calendarLinks, calendarLinksFor, eventIcs } from "./calendar-links.js";
export { ids, slugify, isSlug } from "./ids.js";
import * as i18n from "./i18n.js";
import * as dates from "./dates.js";
export { i18n, dates };
export { createValidator, validate as validateSchema, formatProblems } from "./schema.js";
export { citations, originalUrl, hasOfficialHost, checkCitations, officiallyCited, officialDomains } from "./citations.js";
export { REVIEWED_FIELDS, ATTESTS, canonicalJson, approvalHash, sizeOf, reviewState, eligibility, composeTalk, conceptArticle, conceptItem, conceptItems, conceptSeries, checkCatalogue, checkSchedule, planSchedule, conceptStatus, quoteInText, squash } from "./concepts.js";
export { sha256 } from "./sha256.js";
export { ed25519Verify, checkPublicKey, checkSignature, canonicalBase64 } from "./ed25519.js";
export { LEDGER_VERSION, SIGNED_STATUSES, LEDGER_KINDS, kindActions, baselineHash, witnessKey, ROSTER_STATUSES, FUTURE_SKEW_MS, genesisFor, ledgerId, signedBody, entryHash, memberHash, ledgerHead, nextEntry, subjectOf, verifyLedger, verifiedLedger, witnessProblems, witnessJudge, checkAppend, PROPOSAL_MAX_MS } from "./ledger.js";
export { verifyRequest, verifierEndpoint, remoteVerify } from "./verifier.js";
export { scopeHash } from "./scope.js";
export { verdictBody, signVerdict, verifyVerdict, newNonce } from "./verdict.js";
export { trustedApprovals } from "./approvals.js";
export { trustNamespace, TRUST_VERSION, sshEd25519Raw, sshFingerprint, keyFingerprint, parseSshSig, verifySshSig, ownerKeysFromGithub, trustBody, recordHash, verifyTrustRecord, pinProblems } from "./trust.js";
export { WITNESS_SQL, LEDGER_ID, WITNESS_KEY, bootstrapSql, readBodyBounded, witnessedHead, serverNow, checkWitness, recordWitness, recordTrustWitness, checkTrustWitness, witnessEndpoint, witnessViaEndpoint } from "./witness.js";
export { LIMITS, TALK_LINES } from "./concepts.js";
export { seriesTools, checkEpisode, checkSeason, checkSeries, endOf, slugFor, approved, publishable, draftDates, contentItems } from "./series.js";
export { STRINGS, strings, t, fill, lang, dirFor, digits, toFaDigits, toLatinDigits } from "./i18n.js";
export { toDay, iso, zonedToUtc, localDay, monthKey, monthBounds, monthLabel, dayLabel, dayMonth } from "./dates.js";
