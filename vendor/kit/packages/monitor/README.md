# @saasreport/monitor

Synthetic journeys for a kit site, run every morning in a headless browser (Cloudflare Browser Rendering).
A Durable Object (`MonitorRunner`) owns the browser session (kept alive between runs) and is the lock, so a
manual run and the cron never overlap. Each journey is retried once (flake policy): only two consecutive
failures count. Results go to the monitor's OWN D1 (`MONITOR_DB`: `monitor_runs`, `monitor_deliveries`) and are served as `GET /status` (the site proxies it as `GET /api/status`) (contract `contracts/status.schema.json`, kit.monitor-status.v1); failures are alerted via
`@saasreport/channels` (email and/or a private Telegram/Bale chat). License: Apache-2.0.

## Worker

```js
// monitor/src/index.js
import config from "../kit.config.js";
import { createMonitor } from "@saasreport/monitor";

const monitor = createMonitor(config);
export default monitor.worker;                 // { scheduled, fetch }
export const MonitorRunner = monitor.MonitorRunner;
```

- cron → runs every journey (`trigger = 'cron'`); a no-op when `features.monitor === false`.
- `POST /run` with `Authorization: Bearer <MONITOR_TOKEN>` → runs now and returns the results as JSON.
- `POST /run?mode=drill` (same token) → an alert drill: the same run, plus a message marked "ALERT DRILL — not an incident" through every route (recorded with kind `drill`), whatever the health and whatever today's canary did, so the answer's `drill` (`{ <route>: { ok, error } }`, the drill message's own outcome per route) proves each route delivers now; `routes` stays the run's verdict over every message, so a canary that did not deliver still fails the run. Any other `mode` is refused (400). A cron or a plain `POST /run` never sends it; the daily canary (once per route per UTC day) is unchanged. The delivery kinds (`canary`, `drill`, `alert`, `route-failure`, `deadman-failure`) are fixed in `contracts/delivery.schema.json`; the runner refuses any other. **Rollout order:** a status document can now carry `trigger: "drill"`, which a watcher on an older kit rejects as outside its contract. Vendor this kit into a site, and deploy its monitor and its watcher together, before the first drill runs.
- `GET /status` → the status document.

The site Worker never binds the monitor's D1 (a watched Worker that could write the monitor's rows could forge its own "passing").
It reaches the monitor Worker over a service binding, and `@saasreport/cloudflare` serves `GET /api/status` from it (503 with a reason
code when the binding is missing or the monitor does not answer):

```toml
# the SITE's wrangler.toml
[[services]]
binding = "MONITOR"           # config.monitor.statusBinding to rename it
service = "<project>-monitor"
```

The document (`contracts/status.schema.json`) carries reason codes (`not-configured`, `timeout`, `rejected`, `provider-error`,
`unreachable`, `failed`), never a provider's error text: that stays in `monitor_deliveries.error` for the owner. The canary goes
through every route once per UTC day (a route that already delivered today's canary is not sent another; a failed one is retried).

## wrangler.toml

```toml
name = "my-site-monitor"
main = "src/index.js"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true          # only POST /run (token) and GET /status are served
preview_urls = false

[browser]
binding = "BROWSER"

# One instance runs every check: it owns the browser session and is the lock.
[[durable_objects.bindings]]
name = "RUNNER"
class_name = "MonitorRunner"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MonitorRunner"]

# The MONITOR's own database: never the one it watches (kit check resilience: monitor-own-database).
[[d1_databases]]
binding = "MONITOR_DB"
database_name = "my-site-monitor"
database_id = "<id>"

# Optional: email alerts through a comms/mail worker.
[[services]]
binding = "COMMS"
service = "my-comms-worker"

[vars]
SITE = "https://example.org"       # optional; defaults to config.site.url (use it to monitor a staging copy)
# Written from the wrangler configs and resilience.json, verified by `kit check resilience` (never edited apart):
MONITOR_ROUTES = "email,telegram"            # the routes resilience.json declares for this monitor
MONITOR_DB_ID = "<this monitor's D1 id>"     # by id, never by binding object
MONITOR_WATCHED_DB_IDS = "<site D1 id>,<comms D1 id>"
MONITOR_DEADMAN_PROVIDER = "healthchecks.io" # or other, or github-actions (then the scheduled watcher is the dead-man)
MONITOR_STALE_AFTER_MIN = "1560"
# Recipients are NEVER committed: they are secrets (below). A route that would not deliver makes the monitor refuse to run.
# MONITOR_TELEGRAM_CHAT_ID = "-100…" # private ops chat for Telegram alerts (with monitor.alerts.telegram)

[triggers]
# Run after the site's daily publish. Cron is UTC: 02:45 UTC = 06:15 at UTC+03:30 (config.monitor.at).
crons = ["45 2 * * *"]

[observability]
enabled = true
```

Secrets (names derived from the routes; `kit resilience secrets --monitor <id>` verifies them at deploy): `MONITOR_TOKEN` (for `POST /run`),
each route's own (`MONITOR_NOTIFY_TO`; `MONITOR_TELEGRAM_CHAT_ID` + `TELEGRAM_BOT_TOKEN`; ...), and `MONITOR_DEADMAN_URL` for a ping provider
(docs/RESILIENCE.md), plus `TELEGRAM_BOT_TOKEN` / `BALE_BOT_TOKEN`
when alerting to a chat.

Migration: apply `migrations/0001_monitor_runs.sql`, `0002_monitor_alert_state.sql` and `0003_monitor_deliveries.sql` to the monitor's own D1 database
(`wrangler d1 execute my-site-monitor --remote --file node_modules/@saasreport/monitor/migrations/0001_monitor_runs.sql`, or copy it
into the site's `migrations/`).

Manual run: `curl -X POST -H "authorization: Bearer $MONITOR_TOKEN" https://my-site-monitor.<account>.workers.dev/run`.

## Journeys

Builtin journeys are derived from `config.features`, `config.series`, `config.shows` and `config.site.url`:

| name | when | what it checks |
| --- | --- | --- |
| `landing` | always | `/` loads with an `h1`, the sections of enabled features (`#podcasts`, `#glossary`, `#calendar`), lazy widgets render after scrolling like a visitor (term of the day), no console errors |
| `glossary` | `features.glossary` | `/glossary/` has categories, searching today's term (from `/api/glossary/today`, or `monitor.glossary.query`) filters the list, the term page has the right `h1` and `DefinedTerm` JSON-LD |
| `podcasts` | `features.podcasts` and a series with `podcast` | every show's section on `/podcasts/`; per series: latest episode from `/api/podcasts?series=…`, duration ≤ `maxSeconds`, MP3 answers a `Range` request with 206 and a sane size, episode page has a transcript |
| `publishing` | any series | series due today (site timezone and calendar system, after their `at` time): glossary series → `/api/glossary/today` has a term (and an episode if it has a podcast); podcast series → an episode published today (or with slug `slugPattern`, e.g. `"week-{date}"`); `post` series with a slug pattern → `/blog/<slug>` |
| `calendar` | `features.calendar` | `/api/calendar/today` (and `monitor.calendar.checks`) answer, `/calendar/` has a date picker |
| `feeds` | always | blog feed and every show feed are RSS with items, `sitemap.xml` (with `/glossary/`), `llms.txt`, `robots.txt` (lists the sitemap) |

Custom journeys and selection:

```js
monitor: {
  at: "06:15",
  journeys: [
    "landing", "feeds",                                     // strings select builtins (default: all that apply)
    { name: "pricing", path: "/pricing", selectors: ["h1", "[data-plan]"] },          // browser check
    { name: "health", path: "/api/health", json: (d) => d.ok || "health not ok" },    // plain fetch
    { name: "search", run: async ({ page, get, json, expect }) => { /* … */ return "note"; } },
  ],
  skip: ["calendar"],
  retries: 1, timeoutMs: 30000, keepAliveMs: 600000, viewport: { width: 1280, height: 900 },
  ignoreConsole: ["favicon"],                               // console errors matching these are ignored
  selectors: { glossaryToday: "[data-glossary-today]", show: "#{show}", datePicker: "my-date-picker" },
  paths: { podcastsApi: "/api/podcasts?series={series}&limit={limit}", calendarApi: ["/api/calendar/today"] },
  glossary: { categories: 12, query: "…", slug: "…", term: "…" },
  podcasts: { minBytes: 50000 },
  publishing: { slugs: { weekly: "week-{date}" } },
  landing: { counts: { ".widget .chip": 14 } },             // elements that must be on the landing page, exactly n
  alerts: { email: { template: "ops.alert", params: (alert) => ({ /* an existing template's own fields */ }) }, telegram: true },
}
```

Default selectors (the kit's HTML): `h1`; sections `#podcasts`, `#glossary`, `#calendar`; `[data-glossary-today]` /
`[data-glossary-empty]` (landing widget), `[data-gsearch]`, `[data-gterm]`, `[data-gcat]` (glossary index),
`#{show}` (show sections on `/podcasts/`), `[data-transcript]` (episode page), and any custom element whose name
ends with `-date-picker`. All are overridable via `monitor.selectors`, all paths via `monitor.paths`.

A journey receives `{ site, config, now, today, page(url) → {p, errors}, get(path, init), json(path), expect(cond, msg) }`;
`p` is a puppeteer page; returning a string records it as the journey's notes.

## Alerts

On a failed run the runner calls `sendAlert()` from `@saasreport/channels` with
`{ subject: "<site>: n of m monitor journeys failed", lines: ["journey: error"], url: "<site>/api/status" }`.
Email goes to `MONITOR_NOTIFY_TO` with `channels.email.templates.alert` (or `monitor.alerts.email.template`);
Telegram/Bale go to `MONITOR_TELEGRAM_CHAT_ID` / `MONITOR_BALE_CHAT_ID`, never to the public announcement channel.
Nothing configured, or every channel rejecting the message → the run records `alert_status = failed`, returns the reason and pings the dead-man
URL with `/fail`: it is never `console.error` only. After every run the monitor GETs `MONITOR_DEADMAN_URL` (`/fail` when its own alert or record failed);
an independent watcher (`kit resilience watch` on a schedule, or a ping service) reports the absence. `monitor.staleAfterMin` and `monitor.fetchTimeoutMs` have no default in code: `resilience.json` declares them (`stale_after_min`, `fetch_timeout_ms`), the wrangler vars carry them (`kit resilience check` proves they are equal) and an unset value refuses the run. A status older than the limit is `stale`; without a valid limit it is `unknown` with reason `not-configured`, never a made-up one. Every outbound call (dead-man ping, each route) has a deadline, `monitor.fetchTimeoutMs` (env `MONITOR_FETCH_TIMEOUT_MS`), so a hung URL cannot hold the run. A declared route nobody has tried is `never-attempted` in the status and fails the watcher.

## Tests

`node --test packages/monitor/test/*.test.mjs` (flake policy, `summarize`, journey derivation, due-today logic,
journeys against a fake site, status, worker auth, runner with fake browser/D1/channels).

## Multi-locale sites

With `site.locales`, every builtin journey also runs for each other locale as `<journey>@<locale>` (e.g. `feeds@ar`), with that
locale's config and every site path under its prefix (`/ar/glossary/`). Custom journeys run once, as written.
