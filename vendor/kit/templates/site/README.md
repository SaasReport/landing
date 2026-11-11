# My kit site

A self-hosted publishing site on Cloudflare, made with kit: a weekly topic
(blog post + two-minute podcast), a monthly report and a glossary term a day (one-minute podcast), published on schedule by
a daily cron, with feeds, a sitemap, `llms.txt`, reactions and sharing.

Everything in `content/` is **sample content** (generic finance examples). Replace it with your own.

## How it fits together

![How it fits together (kit.templates.site.readme.1)](../../docs/diagrams/blocks/kit.templates.site.readme.1.png)

<details><summary>Mermaid source (kit.templates.site.readme.1)</summary>

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontFamily":"Inter, Arial, sans-serif","fontSize":"15px","textColor":"#0B0B0B","stateLabelColor":"#0B0B0B","transitionLabelColor":"#0B0B0B","background":"#F7F8FA","primaryColor":"#FFFFFF","primaryTextColor":"#0B0B0B","primaryBorderColor":"#0B0B0B","lineColor":"#5A5A5A","secondaryColor":"#EEF0F4","tertiaryColor":"#F7F8FA","clusterBkg":"#EEF0F4","clusterBorder":"#B8B8B8","edgeLabelBackground":"#F7F8FA","titleColor":"#0B0B0B","actorBkg":"#0B0B0B","actorBorder":"#0B0B0B","actorTextColor":"#FFFFFF","actorLineColor":"#B8B8B8","signalColor":"#0B0B0B","signalTextColor":"#0B0B0B","labelBoxBkgColor":"#F7F8FA","labelBoxBorderColor":"#B8B8B8","noteBkgColor":"#E0F7FA","noteBorderColor":"#00ACC1","sequenceNumberColor":"#FFFFFF","stateBkg":"#FFFFFF","stateBorder":"#0B0B0B","transitionColor":"#5A5A5A","specialStateColor":"#1F3A93"}}}%%
%% kit:diagram {"id":"kit.templates.site.readme.1","title":"How it fits together","project":"kit","kind":"architecture","summary":"How the starter template fits together: its files, the Cloudflare account and speech.","lineage":{"derives_from":[],"supersedes":[],"version":"1"},"relates_to":[{"id":"kit.docs.architecture.3","relation":"sibling"}],"depicts":[{"kind":"other","ref":"the starter template","path":"templates/site"}],"reviewed":"2026-10-06"}
flowchart LR
  subgraph Repo["This directory"]
    cfg("kit.config.js site, brand, hosts, shows, series")
    content("content/ weekly, monthly, glossary")
    worker("src/worker.js createKit(config, content)")
    pub("public/ index.html + kit/ assets")
    wr("wrangler.toml D1, R2, AI, Workflow, cron")
  end
  subgraph CF["Your Cloudflare account"]
    W("Site Worker")
    D1[("D1: posts, episodes, reactions")]
    R2[("R2: podcast MP3s")]
    WF("PodcastWorkflow")
    CR(["Daily cron"])
  end
  TTS("Speech: Gemini, Piper or a Gradio Space")
  cfg & content --> worker
  cfg & content -->|kit check, kit plan| agenda("agenda.md")
  worker & wr & pub -->|kit deploy| W
  CR --> W
  W <--> D1
  W -->|queue episode| WF
  WF --> TTS
  WF --> R2
  classDef accent fill:#1F3A93,stroke:#1F3A93,color:#FFFFFF,stroke-width:2px
  classDef muted fill:#FFFFFF,stroke:#B8B8B8,color:#5A5A5A,stroke-dasharray:4 3
  class worker accent
  class TTS muted
```

</details>

| file | what it is |
| --- | --- |
| `kit.config.js` | the site: name, URL, locale, brand colours, hosts and voices, shows, and the series that publish (what, when, slugs) |
| `content/` | the content pack: `weekly.js` (one topic per Monday), `monthly.js` (one theme per month), `glossary.js` (categories and terms) |
| `src/worker.js` | the whole Worker, five lines: `createKit(config, content)` |
| `public/` | the landing page and `public/kit/` (client CSS/JS, written by `kit init` and refreshed by `kit deploy`) |
| `wrangler.toml` | Cloudflare bindings: D1 `DB`, R2 `PODCASTS`, Workers AI `AI`, Workflow `PODCAST_WF`, the daily cron, static assets |

## Setup

1. **Install**: `npm install` (Node 20 or newer).
2. **Configure**: edit `kit.config.js` (at least `site.name`, `site.url`, `brand`, `hosts`, `shows`) and replace the sample
   content in `content/`. The sample covers short windows (`start` / `end` on each series); remove `end` once every slot has content.
3. **Check**: `npx kit check` validates the config and every content item (lengths, speakability, alternating speakers, no
   figures in definitions, related terms exist). It exits 1 on any problem.
4. **Plan**: `npx kit plan` writes `agenda.md`, a dry run of everything the next year publishes, with every episode script
   built and timed. `npx kit render weekly 2026-09-28` prints one episode script.
5. **Run locally**: `cp .dev.vars.example .dev.vars`, `npx kit migrate` (local D1), `npx wrangler dev`, then open
   http://localhost:8787. With `npx wrangler dev --test-scheduled`, `curl "http://localhost:8787/cdn-cgi/handler/scheduled?time=<ms>"` runs the daily cron for that moment.
6. **Set up Cloudflare** (once):
   ```sh
   npx wrangler d1 create my-site                 # put the database_id into wrangler.toml
   npx wrangler r2 bucket create my-site-podcasts
   npx wrangler secret put ADMIN_TOKEN            # admin API (kit publish / kit status)
   npx wrangler secret put IP_SALT                # hashing visitor ids for reactions
   npx wrangler secret put GEMINI_API_KEY         # speech; without it no episode is queued
   ```
7. **Migrate**: `npx kit migrate --remote` (applies the D1 migrations shipped with `@saasreport/cloudflare`).
8. **Deploy**: `npx kit deploy` (check, refresh `public/kit/`, `wrangler deploy`). Add `--dry-run` to see the steps first.

After that the cron publishes on its own. Queue or re-render an episode by hand with
`KIT_ADMIN_TOKEN=… npx kit publish weekly 2026-09-28 [--force]` and follow it with `npx kit status [slug]`.

## Persian (RTL, Jalali)

`npx kit init my-site --locale fa` creates the same site in Persian: right-to-left pages, the Solar Hijri calendar with the
official Iranian holidays and business days, weekly topics on Saturdays and a date picker on the landing page.

## Two languages

`npx kit init my-site --locales en,ar` adds `locales/en-ar` over this starter: `site.locales: ["en", "ar"]`, values as
`{ en, ar }`, Gemini voices per locale (placeholders), content keyed per locale (`content/ar/` holds the Arabic sample) and
`public/ar/index.html`. English is served at `/`, Arabic at `/ar/` (blog, podcasts, glossary, feeds; one sitemap with
hreflang and one `llms.txt`).
