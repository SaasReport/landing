# @saasreport/channels

Announces blog posts, events and podcast episodes on:

| channel | transport | needs |
| --- | --- | --- |
| `telegram` | Bot API `sendMessage` (or `sendPhoto` / `sendAudio` with `media: true`), inline URL button | bot token + chat id |
| `bale` | the same Bot API, base URL configurable (default `https://tapi.bale.ai`) | bot token + chat id |
| `email` | `POST` to a **service binding** (a comms/mail worker) | binding + recipients + template ids |
| `webhook` | `POST` JSON, optional HMAC-SHA256 signature | URL (+ secret) |

Every channel is **dormant** until its secrets/bindings are present: nothing is sent and no row is touched.
Each item is announced **once**: state lives in the row's `channel_state` / `channel_ref` columns in D1.
Runs in Workers and Node ≥ 20 (no dependencies). License: Apache-2.0.

## Setup

### 1. Config (`kit.config.js`)

```js
channels: {
  telegram: { chatIdEnv: "TELEGRAM_CHAT_ID" },            // token from env TELEGRAM_BOT_TOKEN (tokenEnv to rename)
  bale: { chatIdEnv: "BALE_CHAT_ID", apiBase: "https://tapi.bale.ai" },
  email: {
    serviceBinding: "COMMS",                              // env binding name
    endpoint: "https://comms/v1/comms/dispatch",          // URL passed to binding.fetch (host is ignored by bindings)
    toEnv: "ANNOUNCE_EMAIL_TO",                           // comma-separated, or `to: [...]`
    templates: { post: "site.post.v1", event: "site.event.v1", episode: "site.episode.v1", alert: "site.ops-alert.v1" },
  },
  webhook: { urlEnv: "CHANNEL_WEBHOOK_URL", secretEnv: "CHANNEL_WEBHOOK_SECRET" },
  hashtags: ["my_site"],        // default: the site name as a hashtag; false disables
  paths: { post: "/blog/{slug}", event: "/events/{slug}", episode: "/podcasts/{slug}" },
  maxPerRun: 3,                 // rows announced per table per run
  freshDays: 7,                 // older pending rows are marked 'skipped' (no back-catalogue flood)
},
```

`true` enables a channel with the default env names below.

### 2. Secrets and bindings (`wrangler.toml` / `wrangler secret put`)

| name | kind | used by |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | secret | telegram (the bot must be an admin of the channel) |
| `TELEGRAM_CHAT_ID` | var | telegram, e.g. `@my_channel` or `-100…` |
| `BALE_BOT_TOKEN`, `BALE_CHAT_ID` | secret, var | bale |
| `COMMS` | `[[services]]` binding | email |
| `ANNOUNCE_EMAIL_TO` | var | email announcements |
| `CHANNEL_WEBHOOK_URL`, `CHANNEL_WEBHOOK_SECRET` | var, secret | webhook |
| `MONITOR_NOTIFY_TO`, `MONITOR_TELEGRAM_CHAT_ID`, `MONITOR_BALE_CHAT_ID` | var | alerts (see below) |

```toml
[[services]]
binding = "COMMS"
service = "my-comms-worker"
```

### 3. D1 columns

Each announced table needs `slug` (unique) and:

```sql
channel_state TEXT NOT NULL DEFAULT 'pending' CHECK (channel_state IN ('pending','sent','skipped','failed')),
channel_ref   TEXT
```

(`@saasreport/cloudflare`'s migrations create them for `posts`, `events` and `podcast_episodes`.)

### 4. Cron

Call it from the site worker's daily cron (the `@saasreport/cloudflare` cron does this after publishing):

```js
import { announce, announcePending } from "@saasreport/channels";
// explicit rows:
await announce(env, config, { table: "posts", rows });          // kind inferred: posts→post, events→event, podcast_episodes→episode
// or read pending rows of every enabled feature (legacy queries, override with channels.queries[table]):
await announcePending(env, config);
```

## Idempotency

`announce()` claims each row with `UPDATE … SET channel_state = 'sent' WHERE slug = ? AND channel_state = 'pending'`
**before** sending. Only the run whose update changed the row sends it, so overlapping cron runs and retries never
post twice (at-most-once). Then:

- delivered on at least one channel → `channel_ref` = message id (or JSON `{channel: ref}` with several channels);
- failed on every channel → `channel_state = 'failed'` (reset to `pending` to retry);
- no channel had anything to send (e.g. no email template for that kind) → `skipped`;
- older than `freshDays` → `skipped`; more than `maxPerRun` → left `pending` for the next run.

The report: `{ configured, sent, skipped, failed, deferred, duplicate, errors: [{slug, channel, error}] }`.

## Messages

`postMessage(config, row)`, `eventMessage(config, row, when?)`, `episodeMessage(config, row)` return
`{ kind, title, subject, text (Telegram HTML), plain, button: {label, url}, photo?, audio?, params }`.
Texts are templates with `{placeholders}` (values are HTML-escaped); fa and en defaults are picked from
`site.locale` and overridden by `config.strings.channels`:

```js
strings: { channels: {
  post: "<b>{title}</b>\n\n{summary}\n\n{tags}",
  episode: "<b>Podcast: {title}</b>\n🎧 {minutes}\n\n{summary}\n\n{tags}",
  event: "<b>Event: {title}</b>\n🗓 {when}\n📍 {where}\n\n{summary}\n\n{tags}",
  postButton: "Read the post", episodeButton: "Listen", eventButton: "Register",
  minutes: "{n} min", online: "Online", tbd: "To be announced",
  tags: { episode: "podcast", event: "event" }, kinds: { article: "article", howto: "howto" },
} }
```

Event times are formatted in `site.timezone`, `site.locale` and `calendar.system` (Jalali: `@saasreport/calendar`'s arithmetic in the locale's Intl layout, never ICU's Persian calendar).

## Email payload contract

The email adapter calls `env[serviceBinding].fetch(endpoint, { method: "POST", body })` with:

```json
{ "template_id": "site.post.v1", "to": ["a@example.org"], "idempotency_key": "posts:<slug>",
  "params": { "subject": "…", "title": "…", "text": "plain text", "url": "https://…", "button": "…",
              "summary": "…", "tags": "…", "when": "…", "where": "…", "minutes": "…", "site_name": "…" } }
```

Any 2xx is success; the response's `id` (or `dispatch_id`/`message_id`) becomes the ref. The comms worker
should de-duplicate on `idempotency_key`. Alerts use the `alert` template with params
`{ subject, reference, url, lines_text, lines_html, site_name }`.

## Webhook contract

`POST <url>` JSON `{ kind, title, subject, text, plain, url, photo, audio, params, idempotency_key }` with headers
`idempotency-key` and, when a secret is set, `x-kit-signature: sha256=<hex HMAC-SHA256 of the body>`.

## Alerts

`sendAlert(env, config, { subject, lines, url, reference })` sends operational alerts (used by `@saasreport/monitor`)
to **private** destinations only: it inherits tokens, API bases and the email binding from `config.channels`,
but never the public chat id or announcement recipients. Destinations come from `config.monitor.alerts`
(default `{ email: true }`):

```js
monitor: { alerts: { email: true /* MONITOR_NOTIFY_TO */, telegram: true /* MONITOR_TELEGRAM_CHAT_ID */ } }
```

## Tests

`node --test packages/channels/test/*.test.mjs` (message builders, adapters, announce idempotency on a fake D1, alerts).

## Signed webhooks (`@saasreport/channels/webhooks`)

`signWebhook`, `verifyWebhook`, `webhookEvent`, `twoLayerEvents`, `deliverWebhook`, `backoffDelay`. Headers:
`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<key id>,<base64 HMAC-SHA256 of "id.timestamp.body">` (one per
active key, so keys rotate without downtime). Receivers check the key id, a 300 s window and, with `seen(id)`, replays.
Envelope `kit.webhook-event.v1`: a relayed upstream event carries the provider payload as received; the normalised event
carries the project's model and `caused_by`. The webhook adapter adds these headers when `keyId` (env
`CHANNEL_WEBHOOK_KEY_ID`) is set, next to the legacy `x-kit-signature`. Test fixtures: `test/fixtures/`.

![webhooks-two-layer](../../docs/diagrams/webhooks-two-layer.png)
