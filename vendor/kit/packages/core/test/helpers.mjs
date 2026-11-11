// Small synthetic content packs for tests (no real project content).
const fa = (n, s = "متن ساده ") => s.repeat(Math.ceil(n / s.length)).slice(0, n).trim() + ".";
const en = (n, s = "plain words ") => s.repeat(Math.ceil(n / s.length)).slice(0, n).trim() + ".";
export const talkFa = (lines, len) => Array.from({ length: lines }, (_, i) => [i % 2 ? "expert" : "host", fa(len)]);
export const talkEn = (lines, len) => Array.from({ length: lines }, (_, i) => [i % 2 ? "expert" : "host", en(len)]);
export const topicFa = (date, o = {}) => ({ date, title: `موضوع ${date}`, summary: "خلاصه کوتاه", tags: ["برچسب"], article: fa(900), talk: talkFa(8, 110), ...o });
export const topicEn = (date, o = {}) => ({ date, title: `Topic ${date}`, summary: "Short summary", tags: ["tag"], article: en(900), talk: talkEn(8, 110), ...o });
export const termFa = (slug, category, o = {}) => ({ slug, term: `واژه ${slug}`, en: slug, category, short: "تعریف کوتاه", definition: fa(300), related: [], talk: talkFa(4, 120), ...o });
export const termEn = (slug, category, o = {}) => ({ slug, term: `Term ${slug}`, category, short: "Short definition", definition: en(300), related: [], talk: talkEn(4, 120), ...o });

export const faConfig = (series) => ({
  site: { name: "نمونه", url: "https://demo.example", locale: "fa-IR", timezone: "Asia/Tehran" },
  shows: { weekly: { title: "هفتگی" }, daily: { title: "روزانه" } },
  series: series ?? [
    { id: "weekly", kind: "topic", every: "week", on: "sat", podcast: { show: "weekly", maxSeconds: 150 } },
    { id: "monthly", kind: "report", every: "month", on: 1 },
    { id: "daily", kind: "term", every: "day", start: "2026-09-30", podcast: { show: "daily", maxSeconds: 80 } },
  ],
});
export const enConfig = (series) => ({
  site: { name: "Demo", url: "https://demo.example/", locale: "en-US", timezone: "America/New_York", description: "A demo site." },
  shows: { weekly: { title: "Weekly", category: "Business > Investing", cover: "/cover.png" } },
  series: series ?? [
    { id: "weekly", kind: "topic", every: "week", on: "mon", at: "06:00", podcast: { show: "weekly", maxSeconds: 150 } },
    { id: "monthly", kind: "report", every: "month", on: 1, at: "07:30" },
    { id: "daily", kind: "term", every: "day", start: "2026-10-01", rotation: "round-robin" },
  ],
});
