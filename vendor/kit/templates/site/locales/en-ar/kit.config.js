// kit.config.js — a bilingual site: English at /, Arabic at /ar/ (site.locales; the first locale is the default).
// Any value can be localized as { en: …, ar: … }; content/index.js holds one pack per locale.
// Validated by defineConfig() (run `npx kit check`, which checks every locale). Reference: docs/ARCHITECTURE.md in the kit repository.
import { defineConfig } from "@saasreport/core";

export default defineConfig({
  site: {
    locales: ["en", "ar"],                    // en at /, ar at /ar/ (pages, feeds, sitemap with hreflang, one llms.txt)
    name: { en: "Example Money Notes", ar: "ملاحظات مالية نموذجية" },
    url: "https://example.org",               // your production origin (used in feeds, sitemaps, canonical links)
    timezone: "UTC",                          // series `at` times and "today" are in this zone
    description: {
      en: "A sample kit site in two languages: a weekly topic, a monthly report and a term a day, as posts and short podcasts.",
      ar: "موقع نموذجي بلغتين: موضوع كل أسبوع، وتقرير كل شهر، ومصطلح كل يوم، في منشورات وحلقات بودكاست قصيرة.",
    },
    org: { name: { en: "Example Org", ar: "منظمة نموذجية" }, sameAs: [] },
  },
  brand: {
    colors: { accent: "#2F5BEA", ink: "#141414", bg: "#FAFAF8" },   // emitted as CSS custom properties after kit.css
  },
  calendar: { system: "gregorian", weekend: [0, 6] },                // 0 = Sunday … 6 = Saturday
  hosts: {                                                           // first = host, second = expert
    host: { name: { en: "Alex", ar: "سلمى" }, role: { en: "host", ar: "المقدمة" } },
    expert: { name: { en: "Sam", ar: "سامي" }, role: { en: "expert", ar: "الخبير" } },
  },
  // Gemini prebuilt voices per locale (secret GEMINI_API_KEY; without it no episode is queued). PLACEHOLDERS: Gemini TTS
  // reads Arabic with any prebuilt voice; listen and pick the pair that suits your show.
  tts: { provider: "gemini", voices: { en: { host: "Kore", expert: "Puck" }, ar: { host: "Despina", expert: "Algenib" } } },
  shows: {                                                           // one show per locale: /podcasts/…/feed.xml and /ar/podcasts/…/feed.xml
    weekly: { title: { en: "Money in Two Minutes", ar: "المال في دقيقتين" }, description: { en: "One topic a week, in about two minutes.", ar: "موضوع كل أسبوع في دقيقتين تقريبًا." }, category: "Business" },
    daily: { title: { en: "One Term a Day", ar: "مصطلح كل يوم" }, description: { en: "One finance term a day, in about a minute.", ar: "مصطلح مالي كل يوم في دقيقة تقريبًا." }, feed: "/podcasts/daily/feed.xml", category: "Business" },
  },
  series: [
    // The sample content covers only these windows (start/end); remove `end` once every slot has content in every locale.
    { id: "weekly", title: { en: "Weekly topic", ar: "موضوع الأسبوع" }, kind: "topic", every: "week", on: "mon", at: "06:00", start: "2026-09-28", end: "2026-10-11",
      slug: "week-{date}", podcast: { show: "weekly", maxSeconds: 150, slug: "week-{ref}" } },
    { id: "monthly", title: { en: "Monthly report", ar: "التقرير الشهري" }, kind: "report", every: "month", on: 1, at: "06:00", start: "2026-10-01", end: "2026-11-30",
      slug: "month-{month}" },
    { id: "daily", title: { en: "Term of the day", ar: "مصطلح اليوم" }, kind: "term", every: "day", at: "06:00", start: "2026-09-28", end: "2026-10-03",
      rotation: "round-robin", slug: "term-{slug}", podcast: { show: "daily", maxSeconds: 80, slug: "term-{ref}" } },
  ],
  features: { calendar: false },   // every feature is on by default; the calendar API and picker are Jalali/Iran-specific
});
