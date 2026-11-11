# @saasreport/podcast

Short two-host podcast episodes, rendered and published on Cloudflare:

- **episodes**: `episodeFromItem(config, series, item, { number })` turns a content item (topic or term) into
  `{ slug, kind, series, number, title, summary, lines }`, with the intro and outro taken from config strings.
- **TTS providers**: `gemini` (Google Gemini TTS, multi-speaker), `piper` (Ed25519-signed HTTP service) and `gradio`
  (a Hugging Face ZeroGPU Space), all behind `synthesize(env, lines, { config })`.
- **audio**: PCM → MP3 (`@breezystack/lamejs`, pure JS), ID3v2.3 tags, byte concatenation, line start estimates.
- **workflow**: `createPodcastWorkflow({ config, content, storage })` returns a Cloudflare `WorkflowEntrypoint` class that runs
  script → tts-0…n → assemble → publish. An episode longer than its series' `maxSeconds` gets status `review` instead of being published.
- **article scripts** (optional): `articleScript(env, config, post)` has a Workers AI model rewrite a blog post as a conversation.
  A draft is rejected if it says a number that the post does not contain.

Everything project-specific (names, show titles, voices, texts) comes from the kit config. The pure parts run in Node.

## Config it reads

```js
// kit.config.js (excerpt)
export default defineConfig({
  site: { name: "SaasReport", url: "https://saasreport.ai", locale: "fa-IR" },
  hosts: {
    host:   { name: "نیلوفر", role: "میزبان", voice: "amir" },   // voice: default (piper) voice
    expert: { name: "کاوه",  role: "کارشناس", voice: "ganji" },
  },
  tts: {
    provider: "gemini",                         // "gemini" | "piper" | "gradio"; env.TTS_PROVIDER overrides
    model: "gemini-3.8-flash-tts",              // 3.8 models: one part per line; older: transcript + style prompt
    voices: { host: "Sulafat", expert: "Orus" },  // provider voices by config.hosts key
    speakers: { host: "Niloofar", expert: "Kaveh" }, // Gemini transcript labels (Latin is safest)
    style: "This is a relaxed, casual chat between … {hostLabel} … {expertLabel} … in everyday spoken Tehrani Persian.",
    // optional: url, env: { geminiKey, signingKey, hfToken, url, provider, model }, chunk: { lines, chars },
    //           signatureHeaders: { timestamp, signature }, terms (extra spoken forms for speakable), kbps,
    //           article: { models, minLines, maxLines, maxChars, series }
  },
  series: [
    { id: "weekly", kind: "topic", every: "week", …, podcast: { show: "weekly", maxSeconds: 150, slug: "week-{ref}" } },
    { id: "daily",  kind: "term",  every: "day",  …, podcast: { show: "daily",  maxSeconds: 80,  slug: "term-{ref}" } },
  ],
  shows: {
    weekly: { title: "دو دقیقه مالی، پادکست ایران اوپن فاینانس", short: "دو دقیقه مالی" },  // short: said in the intro
    daily:  { title: "یک دقیقه با ایران اوپن فاینانس" },
  },
  strings: { podcast: { /* overrides of the defaults below */ } },
});
```

Secrets and vars come from `env`. These are the default names, and you can rename them with `tts.env`:

| provider | needs |
| --- | --- |
| gemini | `GEMINI_API_KEY` (model: `tts.model` or `GEMINI_TTS_MODEL`) |
| piper | `TTS_URL` (or `tts.url`), `TTS_SIGNING_KEY` (Ed25519 PKCS#8, base64), optional `HF_TOKEN` |
| gradio | `TTS_URL` (or `tts.url`), `HF_TOKEN` |

## Episodes

```js
import { episodeFromItem } from "@saasreport/podcast";

const weekly = config.series.find((s) => s.id === "weekly");
const ep = episodeFromItem(config, weekly, item, { calendarBit });
// → { slug: "week-2026-10-03", kind: "topic", series: "weekly", title, summary, lines: [{speaker: "host", text}, …], maxSeconds: 150, … }

const term = episodeFromItem(config, "daily", termItem, { number: 12, categories });
// fa: title "یک دقیقه با ایران اوپن فاینانس، قسمت ۱۲: آیبان"
```

- Talk lines in content use `"host"` / `"expert"` (or a `config.hosts` key directly). They are mapped to `config.hosts` keys in
  order, and consecutive lines by the same speaker are merged into one turn (`mergeTurns` from `@saasreport/speech`).
- `calendarBit({ config, series, item }) → { lines, summary } | null` adds a short segment after the talk. It runs for weekly
  topic series, or for any series where `podcast.calendar` is `true`. `@saasreport/cloudflare` passes the calendar-based one.
- Default strings exist for `fa` and `en` (`PODCAST_STRINGS`). Placeholders are `{show} {site} {number} {term} {title} {summary}
  {short} {category} {host} {expert} {calendar}`. Numbers are written in the locale's digits.

```js
strings: { podcast: {
  term: { title: "{show} #{number}: {term}", outro: [["host", "Full definition at {site}. See you tomorrow!"]] },
} }
```

## TTS

```js
import { synthesize, chunkFor } from "@saasreport/podcast";

for (const [i, idx] of chunkFor(config, env, ep.lines).entries()) {
  const { bytes, durationMs, starts } = await synthesize(env, idx.map((j) => ep.lines[j]), { config, first: i === 0 });
}
```

Before synthesis, every line goes through `speakable(text, { locale, terms })` from `@saasreport/speech`.

## Workflow

```js
// in @saasreport/cloudflare, or in your own worker
import { createPodcastWorkflow } from "@saasreport/podcast";   // "workerd" export condition → WorkflowEntrypoint subclass
export const PodcastWorkflow = createPodcastWorkflow({
  config,
  content,       // optional: { [seriesId]: items[] } or async (row, env) => lines; used when an episode has no script_json
  storage: { db: "DB", bucket: "PODCASTS", ai: "AI", prefix: "podcasts/" },   // defaults
  calendarBit,   // optional, used when rebuilding a script from content
});
// env.PODCAST_WF.create({ params: { slug } })
```

The workflow uses D1 table `podcast_episodes` (`slug, series, number, kind, title, summary, source_type, source_ref, script_json,
script_model, status, audio_key, audio_bytes, duration_ms, workflow_id, error, published_at, created_at, updated_at`) and `posts`
for article episodes. Audio is stored in R2 at `podcasts/<slug>.mp3`, with temporary chunks under `podcasts/tmp/<slug>/`.
Status moves through `queued → scripting → rendering → published | review | failed`. Numbers are assigned per series on the first
publish. The ID3 tag uses the episode title, the site name as artist, the show title as album, and the summary as comment.

In Node (tests, tooling), pass a base class: `createPodcastWorkflow({ config, Base: class { constructor(env) { this.env = env; } } })`,
or use `runEpisode({ env, event, step, config })` directly. `@saasreport/podcast/workflow` always imports `cloudflare:workers`.

## Article episodes

```js
import { articleEpisode, articleScript } from "@saasreport/podcast";
const row = articleEpisode(config, post);           // lines: null → the workflow scripts it
const r = await articleScript(env, config, post);   // { model, lines } | { error }  (tts.article.models, in order)
```

## Tests

```sh
node --test packages/podcast/test/*.test.mjs
```

License: Apache-2.0.

## Locales

Episode strings in fa, en and ar. Voices per locale: `tts.voices: { en: { host: "Kore", expert: "Puck" }, ar: { host: "Despina",
expert: "Algenib" } }` (Gemini prebuilt voices; the template's are placeholders) or `hosts.<key>.voice: { en, ar }`. The speech
normaliser follows the config's locale (Arabic digits, dates, currencies and acronyms before TTS). On a multi-locale site
`createPodcastWorkflow({ …, locales: { ar: { config, content } } })` runs an event with `payload.locale` on that locale's config.
