/** @saasreport/site — the site theme: landing, inner pages, demo engines and page scripts from tokens, locale packs, content, strings and data. */
export type Hex = `#${string}`;
export interface Tokens {
  color: { accent: Hex; accentPress: Hex; accentOnDark: Hex; accentBright: Hex; accentTint: Hex; ink: Hex; rail: Hex; railDark: Hex;
    bg: Hex; surface: Hex; dashBg: Hex; sink: Hex; line: Hex; line2: Hex; muted: Hex; dim: Hex; ok: Hex; warn: Hex; err: Hex;
    onInk: Hex; onInkMuted: Hex; onInkDim: Hex; onInkFaint: Hex; inkRaised: Hex; inkTrack: Hex; black: Hex; chartBase1: Hex; chartBase2: Hex; chartBase3: Hex; chartBase4: Hex; chartBase5: Hex; chartBase6: Hex; onDarkOk: Hex; onDarkWarn: Hex; onDarkErr: Hex;
    /** Derived roles (derivedColors) unless the project sets them; each is held to WCAG AA on the surfaces it lands on (TEXT_ON). */
    accentEm?: Hex; accentText?: Hex; dimOnLight?: Hex; dimOnDark?: Hex;
    /** Derived roles of the colour canon (docs/COLOUR.md): surfaces, text on an accent surface, non-text roles (3:1) and the chart series. */
    inkDeep?: Hex; inkHover?: Hex; onAccent?: Hex; pillBorder?: Hex; focus?: Hex; focusOnDark?: Hex; control?: Hex; controlOnDark?: Hex; disabled?: Hex;
    chart1?: Hex; chart2?: Hex; chart3?: Hex; chart4?: Hex; chart5?: Hex; chart6?: Hex;
    onOk?: Hex; onWarn?: Hex; onErr?: Hex; onMuted?: Hex; onChart1?: Hex; onChart2?: Hex; onChart3?: Hex; onChart4?: Hex; onChart5?: Hex; onChart6?: Hex };
  radius: { btn: string; card: string; lg: string };
  font: { sans: string; mono: string; faces: { family: string; weight: number; src: string; format?: string }[]; preload: string[] };
  logo: Record<"nav" | "footer" | "icon", { src: string; width: number; height: number }>;
  images: { og: { src: string; width: number; height: number; type?: string }; podcastCover: { src: string; width: number; height: number } };
  icons: { rel: string; href: string; sizes?: string; type?: string }[];
  manifest?: string;
  css?: { banners?: Record<string, string>; notes?: Record<string, string> };
}
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface LocalePack {
  code: string; lang: string; dir: "rtl" | "ltr"; hreflang: string; og: string; intl: string; name: string;
  digits: "persian" | "arabic" | "latin"; counter: string; calendar: "jalali" | "gregorian" | "hijri";
  number: { decimal: string; group: string; percent: string }; arrow: { next: string; back: string; crumb: string };
  /** Seven weekday names from Sunday; the runtime's `weekdays` start on the calendar profile's first day. */
  weekdays: string[]; months: Partial<Record<"jalali" | "gregorian" | "hijri", string[]>>; hijriSuffix?: string;
  strings: Record<string, string | Record<string, string>>;
}
export interface Locale extends LocalePack {
  /** Weekday names from the first day of the week (from the project's calendar profile). */
  weekdays: string[]; weekStart: number; hijri: "hijri-umalqura" | "hijri-civil";
  /** Intl tags for the browser: "fa-IR", "fa-IR-u-ca-persian", "fa-IR-u-ca-persian-nu-latn" for fa. */
  numberIntl: string; dateIntl: string; dateIntlLatn: string; digitChars: string;
  toDigits(v: unknown): string;
  number(n: number, o?: { decimals?: number }): string;
  percent(n: number, o?: { decimals?: number }): string;
  date(d: number | string, o?: { calendar?: "jalali" | "gregorian" | "hijri" }): string;
  t(key: string, vars?: Record<string, unknown>): string;
}

/** An action: a link (href) or a modal opener (modal). */
export interface Action { label: string; href?: string; modal?: string; style?: "primary" | "ghost" | "light" | "line" | "dark"; size?: "sm" | "lg"; block?: boolean; icon?: string; iconSize?: "sm"; class?: string; attrs?: Record<string, unknown> }
export interface Section { type: string; id?: string; comment?: string; surface?: "paper" | "deep"; head?: { eyebrow?: string; dot?: boolean; title?: string; lead?: string | string[] }; [k: string]: unknown }
export interface Landing {
  meta: { title: string; description: string; ogTitle?: string; ogDescription?: string; ogImageAlt?: string; robots?: string; alternates?: { type: string; title: string; href: string }[] };
  seo?: { org?: { name?: string; alternateName?: string | string[]; logo?: { src: string; width: number; height: number }; description?: string; knowsAbout?: string[]; sameAs?: string[] }; website?: { name?: string }; faq?: boolean };
  comments?: Partial<Record<"icons" | "nav" | "footer" | "modals" | "success", string>>;
  nav: { links: { label: string; href?: string; modal?: string }[]; cta: Action[]; drawer: { links: unknown[]; action?: Action } };
  sections: Section[];
  footer: { logoAlt: string; contact?: Action; columns: { title: string; links: { label: string; href?: string; modal?: string }[] }[]; legal: string[] };
  modals?: Record<string, unknown>[];
}
export interface SiteProject {
  name: string | Record<string, string>;
  url: string;
  locales: (string | { code: string; path?: string; overrides?: DeepPartial<LocalePack>; pack?: LocalePack })[];
  tokens?: DeepPartial<Tokens>;
  content: Record<string, Landing>;
  out?: string;
  css?: string[];
  styles?: string[];
  scripts?: (string | { src: string; module?: boolean; defer?: boolean })[];
  icons?: Record<string, string>;
  /** @saasreport/calendar config: systems, primary, market profiles (they set the Hijri variant and the week start). */
  calendar?: { systems?: string[]; primary?: string; profiles?: string[]; digits?: string; weekStart?: number; system?: string; holidays?: string };
  /** Time zone of the scripts' clocks and dates (default "UTC"). */
  timeZone?: string;
  /** Names the scripts use: window.<global>Notify, window.<global>LabData, "<key>-lab-v1", "<key>:notify". */
  namespace?: { global?: string; key?: string };
  /** Client scripts to generate, with their data and strings per locale. */
  assets?: Record<string, AssetConfig>;
  /** Inner pages, each built once per locale its content covers. */
  pages?: PageConfig[];
  /** The inner pages' chrome: favicons, font preload, and per locale the bar label, home crumb and footer line. */
  pageChrome?: { icons?: { rel: string; href: string; sizes?: string; type?: string }[]; preload?: string[]; strings?: Record<string, { nav?: string; home?: string; footer?: string }> };
  /** Write sitemap.<code>.xml per locale. */
  sitemap?: boolean;
  /** Markdown twins of every indexable page (default on): false turns them off; exclude skips paths; llms writes llms.txt + llms-full.txt (static-only sites). */
  markdown?: false | true | { exclude?: string[]; llms?: true | { about?: string; intro?: string; optional?: { title: string; url: string; description?: string }[] } };
}

/** A generated script: "terminal.js", "lab.js", "lab-data.js", "notify.js", "totop.js" or a page's script. */
export interface AssetConfig {
  /** terminal.js only: the views in tour order; kit views by id, project views as { id, file } (a template). */
  views?: (string | { id: string; file: string })[];
  data?: Record<string, unknown>;
  strings?: Record<string, Record<string, unknown>>;
  banner?: string;
  /** Replace the kit's template with the project's own file. */
  template?: string;
}
export interface PageConfig {
  type: "terminal" | "lab" | "academy" | "partners" | "status" | "brand" | "sectors" | "directory" | "notices";
  path: string;
  content: Record<string, Record<string, unknown>>;
  template?: string;
  generator?: string;
  data?: unknown; taxonomy?: unknown; glossary?: unknown; sectors?: unknown; changes?: unknown;
  json?: { schema?: string; nameKey?: string };
  script?: { banner?: string; data?: Record<string, unknown> };
  /** notices: the project's legal notices (@saasreport/comms/notices), the blocks this page shows, and the legal entity. */
  notices?: { audiences?: string[]; jurisdictions?: string[]; default?: NoticeSelection; values?: Record<string, unknown>; status?: Record<string, string>; copy?: Record<string, unknown> };
  select?: NoticeSelection;
  entity?: { name?: unknown; registration?: unknown; address?: unknown };
  drafts?: boolean;
  placeholders?: "omit" | "show";
}
export interface NoticeSelection { audiences?: string[]; jurisdictions?: string[] }

export function buildSite(project: SiteProject, o?: { root?: string; write?: boolean; outDir?: string }): { files: Record<string, string>; out: string; locales: { code: string; path: string }[]; sitemap: { locale: string; loc: string; alternates: { hreflang: string; url: string }[] }[]; twins: MarkdownTwin[] };
export interface MarkdownTwin { locale: string; path: string; url: string; md: string; title: string; description: string; markdown: string }
export const TWINS_SCHEMA: "kit.md-twins.v1";
export const TWINS_FILE: "md-twins.json";
export function htmlToMarkdown(html: string, o?: { base?: string }): string;
export function pageMarkdown(html: string, o?: { url?: string; site?: string }): { title: string; description: string; lang: string; markdown: string };
export function twinPath(rel: string): string;
export function twinLink(href: string, title?: string): string;
export function linkTwin(html: string, href: string): string;
export function llmsIndex(site: { name: string; about?: string; intro?: string; optional?: { title: string; url: string; description?: string }[] }, twins: MarkdownTwin[]): string;
export function llmsFullText(site: { name: string; about?: string; intro?: string; optional?: { title: string; url: string; description?: string }[] }, twins: MarkdownTwin[]): string;
export function compareSite(files: Record<string, string>, out: string): { file: string; status: "same" | "differs" | "missing" }[];
export function defineSite<T extends SiteProject>(project: T): T;
export function checkProject(project: SiteProject): string[];
export function checkLanding(content: Landing, where?: string): string[];
export const REQUIRED: Record<string, string[]>;
export function createLocale(spec: string | LocalePack, overrides?: DeepPartial<LocalePack>, o?: { calendar?: SiteProject["calendar"] }): Locale;
export function checkLocale(pack: LocalePack, where?: string): string[];
export const LOCALES: Record<"fa" | "en" | "ar", LocalePack>;
export const DIGITS: Record<"persian" | "arabic" | "latin", string>;
export const CALENDARS: string[];
export function fill(s: string, vars?: Record<string, unknown>): string;
export const DEFAULT_TOKENS: Tokens;
export function resolveTokens(tokens?: DeepPartial<Tokens>, base?: Tokens): Tokens;
export function checkTokens(t: Tokens, where?: string): string[];
export function fontFaces(t: Tokens): string;
export function rgb(hex: string): string;
export function renderCss(template: string, o: { file: string; tokens: Tokens; locale: Locale; name: string }): string;
export function readTheme(file: string): string;
export function placeholders(template: string): string[];
export const THEME_CSS: string[];
/** Theme files that live in another kit package (rendered with the same tokens): file name → absolute path. */
export const EXTRA_THEME: Record<string, string>;
export const THEME_DIR: string;
export function renderPage(page: unknown): string;
export function seoGraph(page: unknown): object;
export function plain(s: string): string;
export const SECTIONS: Record<string, (s: Section, c: unknown) => string[]>;
export const ICONS: Record<string, string>;
export function renderTemplate(src: string, ctx: Record<string, unknown>, file?: string): string;
/** A problem found by validateSchema: the JSON Pointer of the value and what is wrong with it. */
export interface SchemaProblem { path: string; message: string }
/** Problems with a value against a JSON Schema (the subset the kit's schemas use), [] when it is valid. */
export function validateSchema(value: unknown, schema: Record<string, unknown> | boolean): SchemaProblem[];
/** Throw an Error that lists every problem; returns the value when it is valid. */
export function assertSchema<T>(value: T, schema: Record<string, unknown> | boolean, where?: string): T;
/** JSON Schemas of asset data a project gives ("terminal.js#notify": the notify view's scenarios). */
export const ASSET_SCHEMAS: Record<string, Record<string, unknown>>;
export function templateKeys(src: string): string[];
export const FILTERS: Record<string, (v: unknown, arg?: string) => unknown>;
export const ASSETS: Record<string, { file?: string; parts?: { file: string; view?: string; when?: string[] }[] }>;
export const TERMINAL_VIEWS: string[];
export const TERMINAL_PARTS: { file: string; view?: string; when?: string[] }[];
export const CAST_ROLES: string[];
export const LAB_MISSIONS: string[];
export function assetSource(name: string, cfg?: AssetConfig, root?: string): string;
export function renderAsset(name: string, cfg: AssetConfig, base: Record<string, unknown>, o?: { root?: string; code?: string }): string;
export function checkAssets(assets?: Record<string, AssetConfig>, codes?: string[]): string[];
export const PAGE_TYPES: Record<string, { template?: string; scripts: string[]; script?: string }>;
export function renderSectors(page: PageConfig, ctx: Record<string, unknown>): Record<string, string>;
export function checkSectors(sectors: unknown[], groups: unknown[], o?: { views?: string[]; terms?: Record<string, string>; where?: string }): string[];
export function renderDirectory(page: PageConfig, ctx: Record<string, unknown>): Record<string, string>;
export function checkDirectory(entries: unknown[], tax: { tiers: unknown[]; categories: unknown[]; tags: unknown[] }, sectors?: unknown[], o?: { maxRole?: number }): string[];
/** The colour roles a directory category may use (chart1 to chart6, accent, ok, warn, err): a category colour is a role, never a hex value. */
export declare const CATEGORY_ROLES: readonly string[];
/** The schema id every directory.json carries (kit.directory.v1): fixed, never taken from content. */
export declare const DIRECTORY_SCHEMA_ID: "kit.directory.v1";
export function normalize(s: string): string;

// Surfaces of a product site (docs/SITE.md, "Surfaces of a product site").
export type ContentBlock = { t: string; [k: string]: unknown };
export interface ContentPage { path: string; title: string; description?: string; ogTitle?: string; ogImage?: string; robots?: string; bar?: { href: string; label: string }[]; crumbs?: [string, string][]; ld?: { type?: string; extra?: Record<string, unknown>; nodes?: Record<string, unknown>[] }; graph?: unknown[]; hero: { eyebrow?: string; title: string; lead?: string; actions?: { href: string; label: string; style?: string }[]; extra?: string }; note?: string; sections?: { id?: string; blocks: ContentBlock[]; wide?: boolean }[]; band?: { title: string; actions: { href: string; label: string; style?: string }[] }; styles?: string[]; scripts?: string[]; bodyClass?: string }
export interface OpenApiOperation { method: string; path: string; id: string; summary: string; description: string; tag: string; params: { name: string; in: string; required: boolean; type: string; description: string }[]; body: { name: string; type: string; required: boolean; description: string }[]; bodyRequired: boolean; responses: { code: string; description: string }[]; security: string[]; deprecated: boolean }
export interface AppsSurface { name: string; host: string; auth: string; signIn: { provider: "clerk"; frontendApi: string; publishableKey: string } | null; groups?: [string, RegExp][]; views: { id: string; path: string; title: string; endpoints?: { path: string; methods: string[]; doc?: string }[]; children?: { id: string; title: string }[]; legacy?: string }[]; actions?: { label: string; post: string }[]; backend?: string; robots?: string }
export const CONTENT_BLOCKS: string[];
export function renderContent(page: PageConfig, ctx: Record<string, unknown>): Record<string, string>;
export function renderBlocks(blocks: ContentBlock[], o?: { renderers?: Record<string, (b: ContentBlock, ctx?: unknown) => string>; depth?: number; ctx?: unknown }): string;
export function contentBody(p: ContentPage, o?: Record<string, unknown>): string;
export function heroHtml(h: ContentPage["hero"]): string;
export function bandHtml(b: NonNullable<ContentPage["band"]>): string;
export function cardHtml(c: { href?: string; eyebrow?: string; group?: string; title: string; text?: string; list?: string[]; go?: string }, tag?: string): string;
export function checkContent(pages: ContentPage[], o?: { base?: string; renderers?: Record<string, unknown>; where?: string }): string[];
export function renderReference(page: PageConfig, ctx: Record<string, unknown>): Record<string, string>;
export function normalizeSpec(doc: Record<string, unknown>, file: string): { id: string; file: string; title: string; version: string; description: string; servers: string[]; ops: OpenApiOperation[] };
export function checkReference(specs: { file: string; doc: unknown; raw?: string }[], where?: string): string[];
export function referenceIndexJson(specs: unknown[], o: { schema?: string; source?: { label?: string; url?: string }; base: string }): string;
export function specId(file: string): string;
export function opAnchor(o: { method: string; path: string }): string;
export function renderApps(page: PageConfig, ctx: Record<string, unknown>): Record<string, string>;
export function checkApps(surface: AppsSurface, where?: string): string[];
export const APPS_SCRIPT: string;
export const APPS_STRINGS: Record<string, string>;
export const STATUSBOARD_STRINGS: Record<string, string>;
export const STATUSBOARD_SOURCES: { components: string; monitor: string; build: string };
export function innerPage(ctx: Record<string, unknown>, o: Record<string, unknown>): string;
export function webPageLd(o: { type?: string; name: string; description?: string; url: string; ctx: Record<string, unknown>; extra?: Record<string, unknown> }): Record<string, unknown>;
export function crumbsLd(items: [string, string][]): Record<string, unknown>;
export function plainText(html: string): string;
export const SURFACE_STYLES: string[];
export function renderNotices(page: PageConfig, ctx: Record<string, unknown>): Record<string, string>;
export function checkNoticesPage(page: PageConfig): string[];
export function writeTwins(dir: string, o: { url: string; name?: string; exclude?: string[]; locale?: string; llms?: true | { about?: string; intro?: string; optional?: { title: string; url: string; description?: string }[] } | null }): MarkdownTwin[];

// ---- contrast: roles per surface (tokens.js) ----
/** A wash: a token colour at an opacity, painted over the listed surfaces. The theme reads the opacity as {{wash.<name>}}. */
export interface Wash { colour: keyof Tokens["color"]; alpha: number; over: (keyof Tokens["color"])[] }
export declare const WASHES: Record<"accent" | "accentDeep" | "ok" | "warn" | "err" | "ink", Wash>;
/** Where each text colour lands: token names, "wash:<name>" (that wash over each of its surfaces). */
export declare const TEXT_ON: Record<string, string[]>;
/** @deprecated the pairs are computed per project (contrastPairs); kept as the role → surfaces map. */
export declare const CONTRAST_PAIRS: Record<string, string[]>;
/** WCAG 2 contrast ratio of two #RRGGBB colours (1 to 21). */
export declare function contrast(a: Hex, b: Hex): number;
/** `a` over `b` at opacity `alpha`, as #RRGGBB. */
export declare function mix(a: Hex, b: Hex, alpha: number): Hex;
/** `from` moved towards `to` until it reaches `min`:1 against every colour of `against`. */
export declare function ensureContrast(from: Hex, against: Hex[], min: number, to: Hex): Hex;
/** The colours behind one TEXT_ON surface name (a wash expands to one per surface under it). */
/** Every place a surface name stands for, resolved or not: hex is undefined and `token` names the missing colour role when it resolves to nothing. */
export declare function surfaceSlots(color: Partial<Tokens["color"]>, name: string): { name: string; hex: Hex | undefined; token: string | undefined }[];
export declare function surfaceColours(color: Tokens["color"], name: string): { name: string; hex: Hex }[];
/** Every surface each role lands on, as colours. */
export declare function surfaces(color: Tokens["color"]): Record<string, { name: string; hex: Hex }[]>;
/** The derived roles (accentText, dimOnLight, dimOnDark, onAccent, focus, control, disabled, chart1 to chart6, inkDeep, inkHover): the project's values, else computed to AA (3:1 for non-text) on their surfaces. */
export declare function derivedColors(color: Tokens["color"]): Record<"accentEm" | "accentText" | "dimOnLight" | "dimOnDark" | "onAccent" | "pillBorder" | "inkDeep" | "inkHover" | "focus" | "focusOnDark" | "control" | "controlOnDark" | "disabled" | "chart1" | "chart2" | "chart3" | "chart4" | "chart5" | "chart6" | "onOk" | "onWarn" | "onErr" | "onMuted" | "onChart1" | "onChart2" | "onChart3" | "onChart4" | "onChart5" | "onChart6", Hex>;
/** The colour roles of resolved tokens (tokens and derived colours) as { name: "#RRGGBB" }. */
export declare function colorRoles(color: Tokens["color"]): Record<string, Hex>;
/** { name: "var(--c-name)" }: how templates paint with a role. */
export declare function colorRefs(color: Tokens["color"]): Record<string, string>;
/** The :root declarations of the colour roles, one per line. */
export declare function colorVars(color: Tokens["color"]): string;
/** Text on a solid fill: the on-ink colour where it reads (4.5:1), else ink, whichever reads better: the one rule behind onAccent and every tone's on-role. */
export declare function fillOn(color: { onInk: Hex; ink: Hex }, bg: Hex): Hex;
/** The inline style of a solid tone: the fill (--c) and the text colour derived for it (--on-c), e.g. `--c:var(--c-chart-2);--on-c:var(--c-on-chart-2)`; throws for a name without a derived text role. */
export declare function toneStyle(colorHex: Record<string, Hex>, role: string): string;
/** The colours of the Worker's server-rendered pages (kit.css roles) from tokens: brand.colors: workerColors(tokens.color). */
export declare function workerColors(color: Tokens["color"]): Record<string, Hex>;
/** accentOnDark → "--c-accent-on-dark". */
export declare function roleVar(name: string): string;
/** The non-text roles and the surfaces each lands on (3:1). */
export declare const UI_ON: Record<string, string[]>;
/** Categorical chart colours before the 3:1 adjustment. */
export declare const CHART_BASE: readonly Hex[];
/** The registry of tone roles: every solid fill a text can sit on → the role of the text on it (@saasreport/core/colour). */
export declare const TONES: Readonly<Record<string, string>>;
/** The fill roles, in registry order (the keys of TONES). */
export declare const FILL_ROLES: readonly string[];
/** The fills a directory category may be painted with. */
export declare const CATEGORY_ROLES: readonly string[];
/** The surfaces a text lands on, as theme roles. */
export declare const SURFACE_ROLES: readonly string[];
/** Problems of the chart series under colour-vision simulation. */
export declare function chartProblems(color: Tokens["color"], where?: string): string[];
/** Lab distance between two colours as seen under "normal", "protan", "deutan" or "tritan" vision. */
export declare function colourDistance(a: Hex, b: Hex, vision?: "normal" | "protan" | "deutan" | "tritan"): number;
/** Every [role, surface, minimum, what, surface colour] pair of a palette. */
/** Every pair a theme is held to: [text role, surface, minimum, what, surface hex, surface token]. THROWS (Error with `gaps`) when a role or surface does not resolve: fail-closed, never a pair that silently disappears. */
export declare function contrastPairs(color: Partial<Tokens["color"]>): [string, string, number, string, Hex, string][];
/** What contrastPairs cannot judge: one entry per missing colour and pair; empty when every role and surface resolves. */
export declare function contrastGaps(color: Partial<Tokens["color"]>): { token: string; why: string }[];
/** The pairs below WCAG AA, as messages (checkTokens and checkProject report them; the build fails). */
export declare function checkContrast(tokens: Tokens, where?: string): string[];

// ---- runtime exports declared by name (packages/cli/test/types.test.mjs keeps this list complete); the JSDoc in
// the source documents each; the parameters are typed loosely until each gets its precise type ----
export declare const PREFERRED_CSS: string;
export declare const PREFERRED_PLACEMENTS: readonly string[];
export declare const PREFERRED_SOURCE_SCHEMA: Readonly<Record<string, any>>;
export declare const PREFERRED_SOURCE_URL: string;
export declare const REGISTRY_CSS: string;
export declare const REGISTRY_SCHEMA: Readonly<Record<string, any>>;
export declare const REGISTRY_STRINGS: Readonly<Record<string, any>>;
export declare const REGISTRY_VERSION: string;
export declare const SEARCH_INDEX: string;
export declare const SEARCH_INDEX_SCHEMA: any;
export declare const SEARCH_CONFIG_SCHEMA: any;
export declare const TAXONOMY_SCHEMA: Readonly<Record<string, any>>;
export declare function baseContext(project: any, tokens: any, loc: any): any;
export declare function buildRegistry(arg0?: any): any;
export declare function checkMenu(menu: any, reg: any): any;
export declare function checkPreferredSource(cfg: any, codes?: any): any;
export declare function checkRegistry(reg: any): any;
export declare function checkShell(outDir: any, arg1?: any): any;
export declare function checkWidgetsPage(page: any, codes?: any): any;
export declare function contrastProbe(page: any): Promise<any>;
export declare function crumbsHtml(page: any, reg: any, t: any): any;
export declare function crumbsLdNode(page: any, reg: any, origin: any): any;
export declare function decorateHtml(html: any, page: any, reg: any, arg3?: any): any;
export declare function decorateSite(outDir: any, reg: any, opts?: any): any;
export declare function fileOfUrl(outDir: any, url: any): any;
export declare function fixedFlicker(page: any, arg1?: any): Promise<any>;
export declare function footHtml(page: any, reg: any, t: any): any;
export declare function headerSignature(html: any): any;
export declare function hubHtml(page: any, reg: any, t: any): any;
export declare function hubMembers(reg: any, hub: any): any;
export declare function labelKey(s: any): any;
export declare function menuFor(project: any, code: any): any;
export declare function menuLinks(menu: any): any;
export declare function navReach(outDir: any, arg1?: any): any;
export declare function pageChrome(arg0?: any): any;
export declare function pageLd(arg0?: any): any;
export declare function paintedContrast(fg: any, layers: any): any;
export declare function parseHtml(html: any): any;
export declare function preferredDomain(cfg: any, url: any): any;
export declare function preferredHref(domain: any): any;
export declare function preferredSourceCard(cfg: any, arg1?: any): any;
export declare function projectAssets(project: any, locales: any): any;
export declare function projectLocales(project: any): any;
export declare function registryByUrl(reg: any): any;
export declare function registryLlms(reg: any, arg1?: any): any;
export declare function registryMenu(reg: any, arg1?: any): any;
export declare function registrySitemap(reg: any, arg1: any): any;
export declare function renderDirectoryJson(arg0: any): any;
export declare function renderDirectoryPage(arg0: any): any;
export declare function renderTemplatePage(def: any, page: any, ctx: any): any;
export declare function renderWidgetsPage(page: any, ctx: any): any;
export declare function renderWorkbenchPage(page: any, ctx: any): any;
export declare function checkWorkbenchPage(page: any, codes?: any): any;
export declare function checkSearchIndex(index: any): string[];
export declare function searchOptions(project: any, arg1?: any): any;
export declare function searchIndex(outDir: any, arg1?: any): any;
export declare function searchTerms(s: any): any;
export declare function shellMarkup(arg0?: any): any;
export declare function shellProbe(page: any, arg1: any): Promise<any>;
export declare function shortLabel(title: any, strip?: any): any;
export declare function trademarker(arg0?: any): any;
export declare function writeSearchIndex(outDir: any, opts: any): any;
