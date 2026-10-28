/** @saasreport/core — types. Days are integers (days since 1970-01-01, UTC), as in @saasreport/calendar. */
export type Day = number;
export type DayLike = Day | string | Date;
export type Kind = "topic" | "report" | "term";
export type Every = "day" | "week" | "month";
export type Speaker = string;
export type TalkLine = [Speaker, string];

export interface Series {
  id: string; kind: Kind; every: Every;
  /** weekly: JS weekday 0-6 (0 = Sunday; config accepts "sat", "mon", …); monthly: day of month 1-31 or -1 (last day) */
  on?: number | string;
  /** local time "HH:MM" in site.timezone (default "06:00") */
  at: string; start?: string; end?: string;
  rotation?: "round-robin" | "sequential" | null;
  source?: (() => Promise<unknown> | unknown) | unknown;
  post: boolean; glossary: boolean; title: string;
  podcast: false | { show: string; maxSeconds: number; marginSeconds: number; [k: string]: unknown };
  /** template with {id} {date} {month} {slug} {number}, or a function of those vars */
  slug: string | ((vars: Record<string, unknown>) => string);
  /** what a slot without content does: "skip" (topic, term default) or "tables" (report default: calendar tables only) */
  empty: "skip" | "tables";
  tables: false | "week" | "month";
  contract: false | Record<string, number | boolean | string>;
  [k: string]: unknown;
}
export interface Show { key: string; title: string; description: string; feed: string; cover?: string | null; category?: string | string[] | string[][]; language?: string; author?: string; ownerEmail?: string; explicit?: boolean; type?: string; [k: string]: unknown }
export interface Config {
  site: { name: string; url: string; locale: string; dir: "rtl" | "ltr"; timezone: string; description: string; logo: string | null; ogImage: string | null;
    org: { name: string; url: string; logo?: string | null; sameAs: string[]; [k: string]: unknown }; [k: string]: unknown };
  brand: { colors: Record<string, string>; fonts: Record<string, string>; [k: string]: unknown };
  calendar: { system: "jalali" | "gregorian"; weekend: number[]; weekendName: string | null; holidays: "iran" | "none";
    profiles: Record<string, { key: string; weekend: number[]; label?: string }>; settlement: number; ahead: number;
    /** Market ids served as /calendar/<id>.ics (@saasreport/cloudflare, feature "feeds"); default: the market profiles; false: none. */
    feeds?: string[] | false; [k: string]: unknown };
  hosts: Record<string, { name: string; role?: string; voice?: string | null; [k: string]: unknown }>;
  tts: Record<string, unknown>;
  speech: { locale: string; terms: Array<[string, string]> | Record<string, string>; defaults: boolean; cps: number };
  series: Series[];
  shows: Record<string, Show>;
  channels: Record<string, unknown>;
  features: Record<"blog" | "podcasts" | "glossary" | "events" | "reactions" | "share" | "calendar" | "feeds" | "monitor" | "llms" | "sitemap", boolean>;
  monitor: { at: string; journeys: unknown[]; [k: string]: unknown };
  strings: Record<string, unknown>;
  paths: { blog: string; podcasts: string; glossary: string; events: string; calendar: string; status: string; [k: string]: string };
}
export class KitConfigError extends Error { problems: string[] }
export function defineConfig(cfg: Record<string, unknown>): Config;
export const DEFAULT_CONTRACTS: Record<Kind, Record<string, number | boolean | string>>;
export const DEFAULT_PATHS: Config["paths"];
export const FEATURES: string[]; export const KINDS: Kind[]; export const EVERY: Every[];
export function seriesById(config: Config, id: string): Series;
export function speechOptions(config: Config): { locale: string; terms: unknown; defaults: boolean };

/* content */
export interface Topic { date: string; title: string; summary: string; tags: string[]; related?: string | string[]; article: string; talk?: TalkLine[] }
export interface Report { month: string; title: string; intro: string }
export interface Term { slug: string; term: string; en?: string; category: string; short: string; definition: string; related: string[]; talk?: TalkLine[] }
export interface Category { key: string; name: string }
export type Content = Record<string, Topic[] | Report[] | { items?: unknown[]; categories?: Category[]; terms?: Term[] }>;
export function loadContent(config: Config, content?: Content): Promise<Content>;
export function normalizeContent(config: Config, content?: Content): Record<string, { items: any[]; categories: Category[] } | null>;

/* contracts */
export interface Ctx { config?: Config; series?: Series; categories?: Category[] }
export function checkTopic(item: Topic, ctx?: Ctx): string[];
export function checkReport(item: Report, ctx?: Ctx): string[];
export function checkTerm(item: Term, ctx?: Ctx): string[];
export function checkTalk(talk: TalkLine[], at: string, limits: Record<string, any>, ctx?: Ctx): string[];
export function checkContent(config: Config, content: Content): string[];
export function isSlot(config: Config, series: Series, iso: string): boolean;

/* planner */
export interface Entry { series: string; kind: Kind; day: Day; date: string; key: string | null; slug: string | null; item: any; publishAt: string; number?: number; category?: Category | null; missing: boolean }
export interface Plan {
  config: Config; content: ReturnType<typeof normalizeContent>;
  due(day: DayLike): Entry[]; slotsOn(day: DayLike): Entry[]; range(from: DayLike, to: DayLike): Entry[];
  find(series: string, ref: string): Entry | null; rotation(series: string): Term[]; dayOf(series: string, slug: string): Day | null; isSlot(series: string, day: DayLike): boolean;
}
export function planner(config: Config | Record<string, unknown>, content?: Content): Plan;
export function roundRobin(categories: Category[], terms: Term[]): Term[];

/* reports */
export interface TableDay { day: Day; iso: string; label: string; short: string; weekday: number; business: boolean; weekend: boolean; holiday: boolean; predicted: boolean; uncertain: boolean;
  status: "business" | "holiday" | "predicted" | "weekend"; holidays: { title: string; predicted: boolean }[]; events: { title: string; kind: string; holiday: boolean }[];
  settlement: { day: Day; iso: string; label: string; short: string; uncertain: boolean } | null }
export interface Tables { from: Day; to: Day; days: TableDay[]; counts: { key: string; label?: string; weekend: number[]; business: number; total: number }[];
  holidays: { day: Day; iso: string; label: string; title: string; predicted: boolean }[]; ahead: Tables["holidays"]; aheadDays: number;
  finance: { day: Day; label: string; title: string }[]; monthEnd: Day | null; firstBusiness: Day | null; lastBusiness: Day | null; uncertain: boolean; predicted: boolean; settlement: number }
export interface ReportPost { title: string; summary: string; body_md: string; tags: string[]; tables: Tables; [k: string]: unknown }
export interface Post extends Partial<ReportPost> { slug: string; series: string; kind: Kind; title: string; summary: string; body_md: string; tags: string[]; published_at: string; source: "auto"; topic: string | null }
export function calendarTables(config: Config, range: { from: DayLike; to?: DayLike; ahead?: number }): Tables;
export function weekReport(config: Config, day: DayLike, o?: { topic?: Topic | null; podcastUrl?: string | null; start?: Day | null }): ReportPost & { range: string };
export function monthReport(config: Config, monthKey: string, o?: { theme?: { title: string; intro: string } | null; topics?: Topic[] }): ReportPost;
export function buildPost(plan: Plan, entry: Entry): Post | null;
export function calOptions(config: Config, profile?: string): { weekend: number[]; holidays: boolean };
export function weekRange(config: Config, start: Day, len?: number): string;
export function publishAt(config: Config, day: DayLike, at?: string): string;

/* agenda */
export interface AgendaStats { from: string; to: string; days: number; total: number; episodes: number; problems: number;
  series: Record<string, { kind: Kind; every: Every; title: string; items: number; missing: number; posts: number; episodes: number; seconds: { min: number | null; max: number | null; avg: number | null } }> }
export function agenda(config: Config | Record<string, unknown>, content: Content, o?: { from?: DayLike; days?: number; now?: Date;
  episode?: (series: Series, entry: Entry) => { speaker: string; text: string }[] | null }): { markdown: string; problems: string[]; stats: AgendaStats; items: (Entry & { title: string | null; summary: string | null; lines: any[] | null; ms: number | null })[] };

/* markdown */
export function renderMarkdown(md: string, o?: { origin?: string }): { html: string; headings: { id: string; level: number; text: string }[] };
export function toPlain(md: string): string;
export function readingMinutes(md: string, wpm?: number): number;
export function escapeHtml(s: unknown): string;
export const markdown: { render: typeof renderMarkdown; toPlain: typeof toPlain; readingMinutes: typeof readingMinutes; escapeHtml: typeof escapeHtml };

/* seo */
export function org(config: Config): Record<string, unknown>;
export function website(config: Config): Record<string, unknown>;
export function graph(...nodes: unknown[]): { "@context": string; "@graph": unknown[] };
export function crumbs(config: Config, items: [string, string][]): Record<string, unknown>;
export function jsonLdScript(data: unknown): string;
export type SitemapUrl = string | { loc: string; lastmod?: string; changefreq?: string; priority?: number };
export function sitemap(urls: SitemapUrl[], o?: { base?: string }): string;
export function sitemap(config: Config, urls: SitemapUrl[]): string;
export function robots(config: Config, o?: { disallow?: string[]; aiBots?: boolean; extra?: string }): string;
export interface LlmsSection { title: string; text?: string; links?: { title: string; url: string; description?: string }[] }
export function llmsTxt(config: Config, sections?: LlmsSection[], o?: { intro?: string }): string;
export function llmsFull(config: Config, sections?: LlmsSection[], docs?: { title: string; url?: string; markdown: string }[], o?: { intro?: string }): string;
export function absUrl(config: Config, path?: string): string;
export function xmlEscape(s: unknown): string;
export const AI_BOTS: string[];
export const seo: Record<string, Function | string[]>;

/* feeds */
export function rss(config: Config, items: { title: string; url?: string; path?: string; slug?: string; summary?: string; html?: string; published_at: string; guid?: string; tags?: string[]; categories?: string[] }[],
  o?: { title?: string; description?: string; path?: string; feedPath?: string; language?: string }): string;
export interface Episode { slug: string; title: string; summary: string; published_at: string; audio_url?: string; audio_bytes?: number; audio_type?: string; duration_ms?: number; number?: number; url?: string; image?: string; guid?: string; type?: string }
export function podcastRss(config: Config, show: string | Show, episodes: Episode[], o?: { ownerEmail?: string }): Promise<string>;
export function podcastGuid(feedUrl: string): Promise<string>;
export function itunesDuration(ms: number): string;
export const feeds: { rss: typeof rss; podcastRss: typeof podcastRss; podcastGuid: typeof podcastGuid; itunesDuration: typeof itunesDuration };

/* calendar links */
export interface CalEvent { title: string; start: string; end?: string; allDay?: boolean; details?: string; location?: string; timezone?: string }
export function calendarLinks(e: CalEvent): { google: string; outlook: string; office: string };
export function calendarLinksFor(config: Config, e: CalEvent): { google: string; outlook: string; office: string };
export function eventIcs(config: Config, e: CalEvent & { slug?: string; url?: string; status?: string }, now?: Date): string;

/* ids, i18n, dates */
export function slugify(text: string, max?: number): string;
export function isSlug(s: string, max?: number): boolean;
export const ids: { slugify: typeof slugify; isSlug: typeof isSlug; SLUG_RE: RegExp };
export const STRINGS: { fa: Record<string, string>; en: Record<string, string> };
export function strings(config: Config | { site: { locale: string } } | string): Record<string, any>;
export function t(config: Config, key: string, vars?: Record<string, unknown>): string;
export function fill(template: string, vars?: Record<string, unknown>): string;
export function lang(x: Config | string): string;
export function dirFor(locale: string): "rtl" | "ltr";
export function digits(x: Config | string, v: unknown): string;
export function toFaDigits(v: unknown): string;
export function toLatinDigits(v: unknown): string;
export const i18n: { STRINGS: typeof STRINGS; strings: typeof strings; t: typeof t; fill: typeof fill; lang: typeof lang; dirFor: typeof dirFor; digits: typeof digits; toFaDigits: typeof toFaDigits; toLatinDigits: typeof toLatinDigits; FA_DIGITS: string; AR_DIGITS: string };
export function toDay(x: DayLike): Day;
export function iso(n: Day): string;
export function zonedToUtc(date: DayLike, time?: string, timeZone?: string): string;
export function localDay(timeZone?: string, now?: Date): Day;
export function monthKey(config: Config, n: Day): string;
export function monthBounds(config: Config, key: string): { first: Day; last: Day; length: number; y: number; m: number };
export function monthLabel(config: Config, key: string): string;
export function dayLabel(config: Config, n: Day): string;
export function dayMonth(config: Config, n: Day): string;
export const dates: Record<string, Function | string[]>;

// ---- runtime exports declared by name (packages/cli/test/types.test.mjs keeps this list complete); the JSDoc in
// the source documents each; the parameters are typed loosely until each gets its precise type ----
export declare function approved(s: any, x: any, domains?: any): any;
export declare function articleMd(config: any, item: any): any;
export declare function checkCitations(x: any): any;
export declare function checkEpisode(x: any, weekday: any, opts?: any): any;
export declare function checkSeason(items: any, weekday: any, opts?: any): any;
export declare function checkSeries(defs: any, opts?: any): any;
export declare function checkSources(src: any, at?: any): any;
export declare function citations(opts?: any): any;
export declare function configFor(config: any, locale: any): any;
export declare function contentFor(config: any, content: any, locale?: any): any;
export declare function contentItems(s: any, arg1?: any): any;
export declare function createValidator(schemas?: any, arg1?: any): any;
export declare function defaultLocaleOf(config: any): any;
export declare function draftDates(s: any, domains?: any): any;
export declare function eachLocale(config: any, content: any): any;
export declare function endOf(s: any): any;
export declare function formatProblems(problems: any, prefix?: any): any;
export declare function hreflangs(config: any, path: any, has?: any): any;
export declare function isKeyedByLocale(config: any, content: any): any;
export declare function isLocaleRoot(config: any): any;
export declare function isLocalized(v: any, locales: any): any;
export declare function isMultiLocale(config: any): any;
export declare function hasOfficialHost(u: any, domains?: any): any;
export declare function llmsTxtLocales(config: any, parts?: any, arg2?: any): any;
export declare function localeBase(locale: any, defaultLocale: any): any;
export declare function localePath(config: any, locale: any, path?: any): any;
export declare const locales: Readonly<Record<string, any>>;
export declare function localesOf(config: any): any;
export declare function localize(value: any, locale: any, locales: any, fallback?: any): any;
export declare function officialDomains(config: any): any;
export declare function officiallyCited(x: any, domains?: any): any;
export declare function originalUrl(u: any): any;
export declare function publishable(s: any, domains?: any): any;
export declare function seriesTools(opts?: any): any;
export declare function slugFor(s: any): any;
export declare function validateSchema(value: any, schema: any, opts: any): any;

// ---- concept series (concepts.js, docs/CONCEPTS.md) and the synchronous SHA-256 it uses ----
export declare const REVIEWED_FIELDS: readonly string[];
export declare const ATTESTS: readonly string[];
export declare function canonicalJson(v: any): string;
export declare function approvalHash(config: any, catalogue: any, concept: any): string;
export declare function sizeOf(texts: string[], unit: "words" | "chars"): number;
export declare function reviewState(concept: any, approvals: any, hash: string): { state: string; entry: any; problems?: string[] };
export declare function eligibility(concept: any, config: any, approvals: any, opts?: { position?: number | null; catalogue?: any }): { ok: boolean; reasons: string[] };
export declare function composeTalk(config: any, concept: any): [string, string][];
export declare function conceptArticle(config: any, catalogue: any, concept: any): string;
export declare function conceptItem(config: any, catalogue: any, concept: any, entry: any): any;
export declare function conceptItems(o: { catalogue: any; config: any; schedule: any; approvals?: any }): { items: any[]; held: { id: string; date: string; reasons: string[] }[] };
export declare function conceptSeries(config: any, schedule: any, opts?: any): any;
export declare function checkCatalogue(catalogue: any, config: any): string[];
export declare function checkSchedule(schedule: any, catalogue: any, config: any, approvals?: any): string[];
export declare function planSchedule(o: { catalogue: any; config: any; approvals?: any; schedule?: any; from?: string | null; allowGap?: string | null; today: string }): { schedule: any; added: { id: string; date: string; order: number }[]; waiting: { id: string; reasons: string[] }[]; problems: string[] };
export declare function conceptStatus(o: { catalogue: any; config: any; schedule: any; approvals?: any; today: string }): any;
export declare function quoteInText(quote: string, text: string): boolean;
export declare function squash(t: string): string;
export declare function sha256(input: string | Uint8Array): string;

// ---- the approval ledger (ledger.js), the registry's approvals (approvals.js) and Ed25519 checks (ed25519.js) ----
export declare const LEDGER_VERSION: string;
export declare const SIGNED_STATUSES: readonly string[];
export declare const ROSTER_STATUSES: readonly string[];
export declare const FUTURE_SKEW_MS: number;
export declare const LIMITS: { titleMax: number; definitionMax: number; tagsMax: number };
export declare const TALK_LINES: { min: number; max: number };
export declare function ed25519Verify(publicKeyB64: string, message: string | Uint8Array, sigB64: string): Promise<boolean>;
export declare function checkPublicKey(publicKeyB64: string): string | null;
export declare function checkSignature(sigB64: string): string | null;
export declare function canonicalBase64(s: string): Uint8Array | null;
export declare function genesisFor(commit: string): string;
export declare function ledgerId(project: string, kind: string): string;
export declare function signedBody(ledger: any, entry: any): string;
export declare function entryHash(entry: any): string;
export declare function memberHash(member: { name: string; publicKey: string }): string;
export declare function ledgerHead(ledger: any): { seq: number; hash: string };
export declare function nextEntry(ledger: any, fields: any): any;
export declare function subjectOf(ledger: any, entry: any): string | undefined;
export declare function verifyLedger(ledger: any, opts?: { expect?: any; bootstrap?: { name: string; publicKey: string }[]; now?: number }): Promise<{ ok: boolean; problems: string[]; subjects: Map<string, any>; roster: { name: string; publicKey: string }[]; head: { seq: number; hash: string } | null }>;
export declare function verifiedLedger(ledger: any, opts?: any): Promise<any>;
export declare const LEDGER_KINDS: Record<string, { subject: "id" | "file"; actions: string[]; veto: boolean }>;
export declare function baselineHash(items: { file: string; sha256: string }[]): string;
export declare function witnessKey(ledger: any): string;
export declare function kindActions(kind: string): string[];
export declare const PROPOSAL_MAX_MS: number;
export declare function checkAppend(ledger: any, entry: any, ctx: any): Promise<{ ok: boolean; problems: string[] }>;
export declare function witnessProblems(ledger: any, seen: { seq: number; hash: string } | null): string[];
export declare function trustedApprovals(trust: { records: any[] }, project: string, ctx: { owner?: string; ownerKeys?: string[]; repo?: string }): Promise<{ project: string; known: boolean; concepts: string | null; shariah: any; persian: any; problems: string[] }>;
export declare const trustNamespace: (project: string) => string;
export declare const TRUST_VERSION: string;
export declare function keyFingerprint(publicKeyB64: string): string;
export declare function sshFingerprint(line: string): string | null;
export declare function sshEd25519Raw(line: string): string | null;
export declare function parseSshSig(armored: string): { rawKey?: string; namespace?: string; hashAlg?: string; signature?: string; error?: string };
export declare function verifySshSig(armored: string, message: string, namespace: string, ownerKeys: string[]): Promise<{ ok: boolean; problem?: string; key?: string }>;
export declare function ownerKeysFromGithub(owner: string, fetchFn?: typeof fetch): Promise<string[]>;
export declare function trustBody(record: any): string;
export declare function recordHash(record: any): string;
export declare function verifyTrustRecord(record: any, ctx: { owner?: string; ownerKeys?: string[]; project: string; repo?: string }): Promise<{ ok: boolean; problems: string[]; approvals: any }>;
export declare function pinProblems(pin: unknown, opts?: { needVerifier?: boolean }): string[];
export declare const WITNESS_SQL: string;
export declare function witnessedHead(db: any, ledgerId: string): Promise<{ seq: number; hash: string } | null>;
export declare const LEDGER_ID: RegExp;
export declare function serverNow(db: any): Promise<string | null>;
export declare function recordTrustWitness(db: any, record: any, ctx: { owner?: string; ownerKeys?: string[]; repo?: string; project: string }): Promise<{ ok: boolean; problems: string[]; now: string | null }>;
export declare function checkTrustWitness(db: any, record: any, ctx: { project: string }): Promise<{ ok: boolean; problems: string[]; now: string | null }>;
export declare function checkWitness(db: any, ledger: any, ctx?: { expect?: any }): Promise<{ ok: boolean; problems: string[] }>;
export declare function recordWitness(db: any, ledger: any, ctx?: { expect?: any; bootstrap?: any[]; now?: number; at?: string }): Promise<{ ok: boolean; problems: string[] }>;
export declare function witnessEndpoint(db: any, opts: { resolve: (id: string) => Promise<any> | any; resolveTrust?: (project: string) => Promise<any> | any; authorize: (r: Request) => boolean | Promise<boolean>; maxBytes?: number }): (r: Request) => Promise<Response>;
export declare function witnessViaEndpoint(fetchFn: typeof fetch, url: string, token: string | null, ledger: any): Promise<{ ok: boolean; problems: string[] }>;
export declare function verifyRequest(body: { project: string; kind: "shariah" | "persian" | "uploads"; sha: string; nonce: string }, ctx: { repo: string; owner: string; ownerKeys: string[]; db: any; source: any; signKey: CryptoKey | Uint8Array; floor?: any }): Promise<{ ok: boolean; problems: string[]; now: string | null; verdict?: any; signature?: string }>;
export declare function verifierEndpoint(opts: { context: (r: Request) => Promise<any> | any; maxBytes?: number; readJson?: (r: Request, o: { maxBytes: number }) => Promise<any> }): (r: Request) => Promise<Response>;
export declare function remoteVerify(fetchFn: typeof fetch, pinned: { url: string; publicKey: string }, token: string | null, request: any, bind: any): Promise<{ ok: boolean; problems: string[]; now: string | null }>;
export declare function verdictBody(v: any): string;
export declare function signVerdict(v: any, privateKey: CryptoKey | Uint8Array): Promise<{ verdict: any; signature: string }>;
export declare function verifyVerdict(signed: any, publicKey: string, bind: any): Promise<string[]>;
export declare function newNonce(): string;
export declare const WITNESS_KEY: RegExp;
export declare function bootstrapSql(record: any): string;
export declare function readBodyBounded(request: Request, maxBytes: number): Promise<{ text?: string; error?: number }>;
export declare function witnessJudge(ledger: any, seen: { seq: number; hash: string } | null, opts?: { required?: boolean }): { code: "missing" | "behind" | "fork"; message: string } | null;
export declare function scopeHash(cfg: { sources?: any[]; exclude?: any[] }, path?: string): string;
