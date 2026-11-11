// kit.config.js — everything project-specific: names, texts, colours, hosts, voices, what publishes when.
// Persian (RTL) with the Solar Hijri (Jalali) calendar and the official Iranian holidays.
// Validated by defineConfig() (run `npx kit check`). Reference: docs/ARCHITECTURE.md in the kit repository.
import { defineConfig } from "@saasreport/core";

export default defineConfig({
  site: {
    name: "سایت نمونه کیت",
    url: "https://example.org",               // your production origin (used in feeds, sitemaps, canonical links)
    locale: "fa-IR",                          // → dir rtl, Persian digits
    timezone: "Asia/Tehran",
    description: "یک سایت نمونه با کیت: موضوع هفته، گزارش ماه و هر روز یک واژه، به‌صورت نوشته و پادکست کوتاه.",
    org: { name: "سازمان نمونه", sameAs: [] },
  },
  brand: {
    colors: { accent: "#0F766E", ink: "#141414", bg: "#FAFAF8" },
    fonts: { body: "Vazirmatn, Tahoma, sans-serif", href: "https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;700;900&display=swap" },
  },
  calendar: { system: "jalali", weekend: "bank", holidays: "iran" },  // bank: Friday; government/market: Thursday + Friday
  hosts: {                                                            // first = host, second = expert
    host: { name: "سارا", role: "میزبان" },
    expert: { name: "امید", role: "کارشناس" },
  },
  tts: { provider: "gemini", voices: { host: "Kore", expert: "Puck" }, speakers: { host: "Sara", expert: "Omid" } },
  shows: {
    weekly: { title: "دو دقیقه پول", description: "هر هفته یک موضوع، در حدود دو دقیقه.", category: "Business" },
    daily: { title: "یک واژه در روز", description: "هر روز یک واژه مالی، در حدود یک دقیقه.", feed: "/podcasts/daily/feed.xml", category: "Business" },
  },
  series: [
    // The sample content covers only these windows (start/end); remove `end` once every slot has content.
    { id: "weekly", title: "موضوع هفته", kind: "topic", every: "week", on: "sat", at: "06:00", start: "2026-09-26", end: "2026-10-09",
      slug: "week-{date}", podcast: { show: "weekly", maxSeconds: 150, slug: "week-{ref}" } },
    { id: "monthly", title: "گزارش ماه", kind: "report", every: "month", on: 1, at: "06:00", start: "2026-09-23", end: "2026-11-21",
      slug: "month-{month}" },
    { id: "daily", title: "واژه روز", kind: "term", every: "day", at: "06:00", start: "2026-09-28", end: "2026-10-03",
      rotation: "round-robin", slug: "term-{slug}", podcast: { show: "daily", maxSeconds: 80, slug: "term-{ref}" } },
  ],
});
