/** Example configs (shape of defineConfig output) used across the tests. Names are made up. */
export const faConfig = {
  site: { name: "نمونه مالی", url: "https://example.org", locale: "fa-IR" },
  hosts: { host: { name: "مریم", role: "میزبان", voice: "amir" }, expert: { name: "بهرام", role: "کارشناس", voice: "ganji" } },
  tts: { provider: "gemini", model: "gemini-3.8-flash-tts", voices: { host: "Sulafat", expert: "Orus" } },
  series: [
    { id: "weekly", kind: "topic", every: "week", podcast: { show: "weekly", maxSeconds: 150, slug: "week-{ref}" } },
    { id: "daily", kind: "term", every: "day", podcast: { show: "daily", maxSeconds: 80, slug: "term-{ref}" } },
    { id: "monthly", kind: "report", every: "month" },
  ],
  shows: { weekly: { title: "دو دقیقه نمونه" }, daily: { title: "یک دقیقه با نمونه" } },
};

export const enConfig = {
  site: { name: "Example Finance", url: "https://example.com", locale: "en-US" },
  hosts: { ada: { name: "Ada", role: "host", voice: "en_f" }, bob: { name: "Bob", role: "expert", voice: "en_m" } },
  tts: { provider: "gemini", model: "gemini-2.5-flash-preview-tts", voices: { ada: "Kore", bob: "Puck" }, speakers: { ada: "Ada", bob: "Bob" } },
  series: [
    { id: "weekly", kind: "topic", every: "week", podcast: { show: "main", maxSeconds: 150 } },
    { id: "daily", kind: "term", every: "day", podcast: { show: "daily", maxSeconds: 80 } },
  ],
  shows: { main: { title: "Two Minutes of Money", short: "Two Minutes" }, daily: { title: "One Minute Glossary" } },
};

export const topicItem = {
  date: "2026-10-03", title: "Open APIs", summary: "Why open APIs matter.", tags: ["api"],
  talk: [["host", "What is an open API?"], ["expert", "A documented way in."], ["host", "Who uses it?"], ["expert", "Everyone who builds."]],
};
export const termItem = {
  slug: "iban", term: "IBAN", en: "IBAN", category: "payments", short: "International bank account number.",
  definition: "…", related: [], talk: [["host", "What's an IBAN?"], ["expert", "An account number format."]],
};
export const categories = [{ key: "payments", name: "Payments" }];

/** 16-bit mono PCM: tone segments separated by silences. */
export function tonePcm(rate, segments) {
  const total = segments.reduce((n, [ms]) => n + Math.round((rate * ms) / 1000), 0), pcm = new Int16Array(total);
  let o = 0;
  for (const [ms, loud] of segments) {
    const n = Math.round((rate * ms) / 1000);
    if (loud) for (let i = 0; i < n; i++) pcm[o + i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate));
    o += n;
  }
  return pcm;
}

/** A WAV file (RIFF, PCM 16-bit mono) around pcm. */
export function wav(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf), w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  pcm.forEach((s, i) => dv.setInt16(44 + i * 2, s, true));
  return new Uint8Array(buf);
}
export const b64 = (u8) => Buffer.from(u8).toString("base64");
