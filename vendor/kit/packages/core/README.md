# @saasreport/core

The pure building blocks of a kit publishing site: config validation, content contracts, the publishing planner,
calendar-driven reports, the agenda dry run, Markdown, SEO/discovery, RSS and podcast feeds, add-to-calendar links and i18n.
No I/O; runs in Workers, Node ≥ 20 and browsers. Depends on `@saasreport/calendar` and `@saasreport/speech`. License: Apache-2.0.

## Config

```js
// kit.config.js
import { defineConfig } from "@saasreport/core";
export default defineConfig({
  site: { name: "Acme Finance", url: "https://acme.example", locale: "fa-IR", timezone: "Asia/Tehran", description: "…", logo: "/logo.png",
          org: { name: "Acme", sameAs: ["https://t.me/acme"] } },
  calendar: { system: "jalali", weekend: "bank" },            // gregorian + weekend: [0, 6] for most other sites
  hosts: { host: { name: "Sara", voice: "a" }, expert: { name: "Ali", voice: "b" } }, // first key = host, second = expert
  speech: { terms: [["ACME", "اِکمی"]] },                     // project Latin terms for the fa speech pack
  shows: { weekly: { title: "Two minutes", feed: "/podcasts/feed.xml", cover: "/cover.png", category: "Business > Investing" } },
  series: [
    { id: "weekly", kind: "topic", every: "week", on: "sat", at: "06:00", source: () => import("./content/weekly/index.js"),
      slug: "week-{date}", podcast: { show: "weekly", maxSeconds: 150 } },
    { id: "monthly", kind: "report", every: "month", on: 1, slug: "month-{month}", source: () => import("./content/monthly.js") },
    { id: "daily", kind: "term", every: "day", start: "2026-09-30", rotation: "round-robin", slug: "term-{slug}",
      source: () => import("./content/glossary/index.js"), podcast: { show: "daily", maxSeconds: 80 } },
  ],
});
```

`defineConfig` fills defaults and throws a `KitConfigError` whose message (and `.problems`) lists **every** problem at once.
Defaults worth knowing:

| key | default |
| --- | --- |
| `site.locale` / `dir` / `timezone` | `en-US` / from locale (`rtl` for fa, ar, he, …) / `Asia/Tehran` for fa, else `UTC` |
| `calendar.system` | `jalali` for fa, else `gregorian` |
| `calendar.weekend` | `"bank"` (Friday) for jalali, `[0, 6]` otherwise. Arrays use **JS weekday numbers** (0 = Sunday … 6 = Saturday) |
| `calendar.holidays` | `"iran"` for jalali (official + predicted lunar holidays from `@saasreport/calendar`), else `"none"` |
| `calendar.profiles` | iran: `bank`, `government`, `market` (business-day counts in reports); else one `business` profile |
| `calendar.settlement` | `1` (T+1 column in weekly tables; `0` hides it) |
| `calendar.weekMerge` | `false`; `true` merges profiles with the same weekend into one line of the week summary ("A and B") |
| `series[].at` / `slug` | `"06:00"` local / `"{id}-{date}"` (topic), `"{id}-{month}"` (report), `"{id}-{slug}"` (term); vars: id, date, month, slug, number |
| `series[].on` | weekly: `"sat"` (jalali) or `"mon"`; monthly: `1` (`-1` = last day) |
| `series[].empty` | `"skip"` (topic), `"tables"` (report: publish calendar tables even without a theme) |
| `series[].postKind` | the series kind; a string or `(entry) => kind` for the stored post kind (e.g. `article`, `snapshot`) |
| `series[].tables` | `"week"` for weekly series, `"month"` for monthly reports, else `false` |
| `series[].contract` | `DEFAULT_CONTRACTS[kind]` merged with `contracts[kind]` and the series' own; `false` disables limits |
| `features.*` | all `true` |
| `paths` | `/blog/`, `/podcasts/`, `/glossary/`, `/events/`, `/calendar/`, `/status/` |

Report strings worth overriding for an existing site: `weekAudio`, `weekFooter` (a closing line, empty by default), `eventSep`
(between events in the day-by-day table), `listSep`, `colStatus`, `calendarEngine`, `firstBusiness`, `lastBusiness`, `monthPlanIntro`, `monthSummary`.

Unknown nested keys (e.g. `tts.*`, `series[].podcast.*` such as `podcast.calendarBit`, `shows.*.short`, `strings.podcast`) are kept for other packages.

## Content and contracts

```js
import { loadContent, checkContent } from "@saasreport/core";
const content = await loadContent(config);   // resolves every series' source()
checkContent(config, content);               // [] or ["weekly 2026-10-03: article is 512 chars (700-1800)", …]
```

- topic: `{ date, title, summary, tags, related?, article, talk: [["host" | "expert", text], …] }` — `date` must be a slot of the series.
- report: `{ month: "YYYY-MM" (in the calendar system), title, intro }`.
- term: `{ slug, term, en?, category, short, definition, related, talk }`; the series content is `{ categories: [{ key, name }], terms }`.
- `checkTopic`, `checkReport`, `checkTerm(item, { config, series, categories })`: lengths, alternation of the first two hosts,
  speakability (via `@saasreport/speech` in the site locale with `speech.terms`), no figures in definitions (except `T+n`, `ISO nnnn`).

## Planner

```js
import { planner, buildPost } from "@saasreport/core";
const plan = planner(config, content);
plan.due("2026-10-03");   // [{ series: "weekly", kind: "topic", slug: "week-2026-10-03", item, publishAt: "2026-10-03T02:30:00.000Z", day, date, key },
                          //  { series: "daily", kind: "term", slug: "term-…", number: 4, category, … }]
plan.range("2026-09-30", "2026-10-31"); plan.slotsOn(day) /* incl. empty slots */; plan.find("daily", "term-slug"); plan.dayOf("daily", "slug");
buildPost(plan, entry);   // { slug, title, summary, body_md, tags, published_at, … } — topic article + week tables, monthly report, …
```

Days are day numbers (days since 1970-01-01, UTC) or ISO/Jalali date strings. Weekly, monthly (Jalali or Gregorian months) and
daily slots; term series rotate round-robin across categories (each category's 1st term, then each one's 2nd, …) and number
their slots from `start` (`number` = 1, 2, …). `publishAt` is the series' local `at` in `site.timezone`, as ISO UTC (DST-aware).

## Reports and agenda

```js
import { calendarTables, weekReport, monthReport, agenda } from "@saasreport/core";
calendarTables(config, { from: "2026-03-21", to: "2026-03-27" }); // day-by-day status, business-day counts per profile, holidays, T+n
weekReport(config, "2026-10-03", { topic, podcastUrl });          // { title, summary, body_md, tags }
monthReport(config, "1405-08", { theme, topics });
const { markdown, problems, stats } = agenda(config, content, { from: "2026-09-30", days: 371, episode: (series, entry) => lines });
```

All texts come from the strings table: `STRINGS.fa` / `STRINGS.en` defaults overridden by `config.strings` (`t(config, "episode", { n: 3 })`).

## Web helpers

```js
import { renderMarkdown, toPlain, org, website, graph, crumbs, sitemap, robots, llmsTxt, llmsFull, rss, podcastRss, calendarLinks, eventIcs } from "@saasreport/core";
renderMarkdown(md, { origin: config.site.url });            // safe HTML + headings
graph(org(config), website(config), crumbs(config, [["Blog", "/blog/"]]));
sitemap(["/", { loc: "/blog/a", lastmod }], { base: config.site.url }); robots(config);
llmsTxt(config, [{ title: "Docs", links: [{ title: "Blog", url: "/blog/", description: "…" }] }]);
rss(config, posts); await podcastRss(config, "weekly", episodes, { ownerEmail });  // iTunes + Podcasting 2.0 (podcast:guid = UUIDv5 of the feed URL)
calendarLinks({ title, start, end, allDay, timezone }); eventIcs(config, event);
```

Also: `i18n` (`digits`, `toFaDigits`, `toLatinDigits`, `strings`, `t`, `dirFor`), `dates` (`toDay`, `zonedToUtc`, `localDay`, `monthKey`,
`dayLabel`, …), `ids` (`slugify`, `isSlug`). Types: `src/index.d.ts`.

## Tests
`node --test packages/core/test/*.test.mjs`. `test/parity.test.mjs` replays the first consumer's schedule from `/.legacy`
(when present) and checks the same counts as its legacy agenda: 53 weekly, 12 monthly and 371 daily items from 2026-09-30.

## Multi-locale sites

`site: { locales: ["en", "ar"], name: { en: "…", ar: "…" } }` publishes the default locale at `/` and the others at
`/<locale>/`. Any config value can be localised as `{ en, ar }` (it falls back to the default locale); `series[].locales`
limits a series. `defineConfig` validates each locale as its own config (problems prefixed `[ar]`):

```js
import { configFor, contentFor, eachLocale } from "@saasreport/core";
const ar = configFor(config, "ar");          // site.url …/ar, site.base "/ar", site.root, dir rtl, speech ar
const pack = contentFor(config, content, "ar");
for (const { locale, config: c, content: p } of eachLocale(config, content)) planner(c, p);
```

Content comes keyed per locale (`{ en: { weekly: […] }, ar: { … } }`, canonical) or with localised fields; `checkContent`
and `agenda` cover every locale. SEO: `hreflangs(config, path)`, `sitemap()` entries with `alternates`, `llmsTxtLocales()`;
podcast feeds of a multi-locale site add `<itunes:language>`. A config without `site.locales` (or with one) is unchanged.

## Series tooling (review gate, citations)

Config-driven helpers for seasons of dated episodes (article + talk), moved from SaasReport:

```js
import { seriesTools } from "@saasreport/core";
const t = seriesTools({ config, speakers: { n: "host", k: "expert" } });   // config.sources.official: the official domains
t.checkAll(defs);            // contract per item + consecutive weeks, unique slugs + citation shape
t.publishable(def);          // requireReview: reviewed items; autoPublishCited: also officially cited ones
t.contentItems(def);         // the content-pack shape; endOf(def), slugFor(def) for the series config
```

`citations({ officialDomains })` gives `hasOfficialHost`, `originalUrl` (Wayback links), `checkCitations`, `officiallyCited`.
Nothing is hardcoded: the domain list is `sources: { official: [...] }` in kit.config.js.

## Calendar config

`calendar` takes the original shape (`{ system, weekend, holidays, profiles: { key: weekend } }`, unchanged) or
the market shape of `@saasreport/calendar/config` (`{ systems, primary, profiles: ["sa", "ae"], digits }`), resolved with
`resolveCalendarConfig`: its fields are merged in (`markets`, `profile`, `systems`, …) and `system`, `weekend`, `holidays` and
`profiles` keep the meaning the reports read.
