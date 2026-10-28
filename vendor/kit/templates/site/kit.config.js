// kit.config.js — everything project-specific: names, texts, colours, hosts, voices, what publishes when.
// Validated by defineConfig() (run `npx kit check`). Reference: docs/ARCHITECTURE.md in the kit repository.
import { defineConfig } from "@saasreport/core";

export default defineConfig({
  site: {
    name: "Example Money Notes",
    url: "https://example.org",               // your production origin (used in feeds, sitemaps, canonical links)
    locale: "en-US",                          // dir (ltr/rtl) and calendar defaults follow the locale
    timezone: "UTC",                          // series `at` times and "today" are in this zone
    description: "A sample kit site: a weekly topic, a monthly report and a term a day, as posts and short podcasts.",
    org: { name: "Example Org", sameAs: [] },
  },
  brand: {
    colors: { accent: "#2F5BEA", ink: "#141414", bg: "#FAFAF8" },   // emitted as CSS custom properties after kit.css
  },
  calendar: { system: "gregorian", weekend: [0, 6] },                // 0 = Sunday … 6 = Saturday
  hosts: {                                                           // first = host, second = expert
    host: { name: "Alex", role: "host" },
    expert: { name: "Sam", role: "expert" },
  },
  tts: { provider: "gemini", voices: { host: "Kore", expert: "Puck" } },  // secret GEMINI_API_KEY; without it no episode is queued
  shows: {
    weekly: { title: "Money in Two Minutes", description: "One topic a week, in about two minutes.", category: "Business" },
    daily: { title: "One Term a Day", description: "One finance term a day, in about a minute.", feed: "/podcasts/daily/feed.xml", category: "Business" },
  },
  series: [
    // The sample content covers only these windows (start/end); remove `end` once every slot has content.
    { id: "weekly", title: "Weekly topic", kind: "topic", every: "week", on: "mon", at: "06:00", start: "2026-09-28", end: "2026-10-11",
      slug: "week-{date}", podcast: { show: "weekly", maxSeconds: 150, slug: "week-{ref}" } },
    { id: "monthly", title: "Monthly report", kind: "report", every: "month", on: 1, at: "06:00", start: "2026-10-01", end: "2026-11-30",
      slug: "month-{month}" },
    { id: "daily", title: "Term of the day", kind: "term", every: "day", at: "06:00", start: "2026-09-28", end: "2026-10-03",
      rotation: "round-robin", slug: "term-{slug}", podcast: { show: "daily", maxSeconds: 80, slug: "term-{ref}" } },
  ],
  features: { calendar: false },   // every feature is on by default; the calendar API and picker are Jalali/Iran-specific
});
