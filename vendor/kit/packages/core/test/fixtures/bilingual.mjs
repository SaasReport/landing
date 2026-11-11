// A small bilingual site for tests: English at /, Arabic at /ar/ (no real project content).
// The config uses localized values ({ en, ar }); the content comes keyed per locale (bilingualContent) or with localized
// fields (bilingualContentFields), which must resolve to the same packs.

export const bilingualConfig = () => ({
  site: {
    locales: ["en", "ar"],
    name: { en: "Sample Finance", ar: "التمويل النموذجي" },
    url: "https://finance.example",
    timezone: "Asia/Riyadh",
    description: { en: "A bilingual sample site.", ar: "موقع نموذجي بلغتين." },
    org: { name: { en: "Sample Org", ar: "المنظمة النموذجية" } },
  },
  calendar: { system: "gregorian", weekend: [5, 6] },
  hosts: {
    host: { name: { en: "Lina", ar: "لينا" }, role: { en: "host", ar: "مقدمة" } },
    expert: { name: { en: "Omar", ar: "عمر" }, role: { en: "expert", ar: "خبير" } },
  },
  // Gemini prebuilt voices per locale (placeholders, like the template's).
  tts: { provider: "gemini", voices: { en: { host: "Kore", expert: "Charon" }, ar: { host: "Despina", expert: "Algenib" } } },
  shows: {
    weekly: { title: { en: "The Weekly", ar: "الأسبوعية" }, description: { en: "One topic a week.", ar: "موضوع كل أسبوع." }, feed: "/podcasts/weekly/feed.xml" },
    daily: { title: { en: "A Term a Day", ar: "مصطلح كل يوم" }, description: { en: "One term a day.", ar: "مصطلح واحد كل يوم." }, feed: "/podcasts/daily/feed.xml" },
  },
  contracts: { topic: { articleMin: 80, talkMin: 120, talkMax: 1200, linesMin: 4 }, term: { defMin: 40, talkMin: 60, talkMax: 700, linesMin: 2 } },
  series: [
    { id: "weekly", title: { en: "Weekly topic", ar: "موضوع الأسبوع" }, kind: "topic", every: "week", on: "sun", at: "06:00", start: "2026-10-04", end: "2026-10-11",
      slug: "week-{date}", podcast: { show: "weekly", maxSeconds: 150, slug: "week-{ref}" } },
    { id: "daily", title: { en: "Term of the day", ar: "مصطلح اليوم" }, kind: "term", every: "day", at: "06:00", start: "2026-10-04", end: "2026-10-05",
      rotation: "sequential", slug: "term-{slug}", podcast: { show: "daily", maxSeconds: 80, slug: "term-{ref}" } },
    // English only: a series can be limited to some locales.
    { id: "notes", locales: ["en"], kind: "topic", every: "week", on: "wed", at: "06:00", start: "2026-10-07", end: "2026-10-07", slug: "note-{date}" },
  ],
  features: { calendar: false },
});

const en = {
  weekly: [
    { date: "2026-10-04", title: "What sukuk are", summary: "Certificates of ownership in a real asset, not a loan.", tags: ["sukuk"],
      article: "Sukuk are certificates that represent a share in a real asset. Holders earn a return from that asset rather than interest, which is why they are used in Islamic finance.",
      talk: [["host", "Today we talk about sukuk and how they work."], ["expert", "A sukuk is a certificate of ownership in a real asset."],
        ["host", "So how is it different from a bond?"], ["expert", "A bond is a debt with interest; a sukuk pays a share of what the asset earns."]] },
    { date: "2026-10-11", title: "Takaful in brief", summary: "Mutual protection where members share the risk.", tags: ["takaful"],
      article: "Takaful is a form of insurance in which members contribute to a common fund and help each other. The operator manages the fund for a fee and does not own the risk.",
      talk: [["host", "This week: takaful, in about a minute."], ["expert", "Takaful is cooperative protection: members pay into one fund."],
        ["host", "Who carries the risk then?"], ["expert", "The members do, together; the operator only manages the fund for a fee."]] },
  ],
  daily: {
    categories: [{ key: "basics", name: "Basics" }],
    terms: [
      { slug: "sukuk", term: "Sukuk", en: "Sukuk", category: "basics", short: "Certificates of ownership in an asset.", definition: "Sukuk are certificates of equal value that represent shares in assets, with a return from those assets.", related: ["takaful"],
        talk: [["host", "What are sukuk?"], ["expert", "Certificates that give you a share of an asset and of what it earns."]] },
      { slug: "takaful", term: "Takaful", en: "Takaful", category: "basics", short: "Cooperative insurance.", definition: "Takaful is a cooperative scheme in which members share risks through a common fund managed for a fee.", related: [],
        talk: [["host", "And takaful?"], ["expert", "Members protect each other through one common fund, managed for a fee."]] },
    ],
  },
  notes: [{ date: "2026-10-07", title: "A note in English only", summary: "Only the English site publishes this series.", tags: ["note"],
    article: "This series exists only in English. The Arabic site does not plan it, does not check it and does not publish it on any day.", talk: null }],
};

const ar = {
  weekly: [
    { date: "2026-10-04", title: "ما هي الصكوك", summary: "شهادات ملكية في أصل حقيقي، لا قرض.", tags: ["الصكوك"],
      article: "الصكوك شهادات تمثل حصة في أصل حقيقي، ويحصل حاملها على عائد من هذا الأصل بدلًا من الفائدة، ولهذا تُستخدم في التمويل الإسلامي.",
      // Digits, a percentage and a Latin acronym: speakable once the ar normaliser spells them out.
      talk: [["host", "موضوعنا اليوم الصكوك وكيف تعمل."], ["expert", "الصك شهادة ملكية في أصل حقيقي، وقد نما سوقها 12% في 2025."],
        ["host", "وكيف يختلف عن السند؟"], ["expert", "السند دين بفائدة، أما الصك فيمنح حصة من عائد الأصل، ويمكن تداوله عبر API."]] },
    { date: "2026-10-11", title: "التكافل باختصار", summary: "حماية تعاونية يتقاسم فيها الأعضاء المخاطر.", tags: ["التكافل"],
      article: "التكافل صورة من التأمين يساهم فيها الأعضاء في صندوق مشترك ويتعاونون فيما بينهم، وتدير الجهة المشغلة الصندوق مقابل أجر ولا تملك المخاطر.",
      talk: [["host", "هذا الأسبوع: التكافل في دقيقة تقريبًا."], ["expert", "التكافل حماية تعاونية، يدفع فيها الأعضاء إلى صندوق واحد."],
        ["host", "ومن يتحمل المخاطر إذن؟"], ["expert", "الأعضاء معًا، والجهة المشغلة تدير الصندوق فقط مقابل أجر قدره 250 SAR."]] },
  ],
  daily: {
    categories: [{ key: "basics", name: "الأساسيات" }],
    terms: [
      { slug: "sukuk", term: "الصكوك", en: "Sukuk", category: "basics", short: "شهادات ملكية في أصل.", definition: "الصكوك شهادات متساوية القيمة تمثل حصصًا في أصول، ويأتي عائدها من تلك الأصول.", related: ["takaful"],
        talk: [["host", "ما هي الصكوك، باختصار؟"], ["expert", "شهادات تمنحك حصة من أصل حقيقي ومما يربحه هذا الأصل."]] },
      { slug: "takaful", term: "التكافل", en: "Takaful", category: "basics", short: "تأمين تعاوني.", definition: "التكافل نظام تعاوني يتقاسم فيه الأعضاء المخاطر عبر صندوق مشترك يُدار مقابل أجر.", related: [],
        talk: [["host", "وماذا عن التكافل؟"], ["expert", "يحمي الأعضاء بعضهم بعضًا عبر صندوق مشترك يُدار مقابل أجر."]] },
    ],
  },
};

/** Content keyed per locale (the canonical form). */
export const bilingualContent = () => structuredClone({ en, ar });

/** The same content with localized fields ({ en, ar } inside one pack). */
export function bilingualContentFields() {
  const both = (a, b) => ({ en: a, ar: b });
  return structuredClone({
    weekly: en.weekly.map((x, i) => {
      const y = ar.weekly[i];
      return { date: x.date, title: both(x.title, y.title), summary: both(x.summary, y.summary), tags: both(x.tags, y.tags), article: both(x.article, y.article), talk: both(x.talk, y.talk) };
    }),
    daily: {
      categories: [{ key: "basics", name: both("Basics", "الأساسيات") }],
      terms: en.daily.terms.map((x, i) => {
        const y = ar.daily.terms[i];
        return { slug: x.slug, term: both(x.term, y.term), en: x.en, category: x.category, short: both(x.short, y.short), definition: both(x.definition, y.definition), related: x.related, talk: both(x.talk, y.talk) };
      }),
    },
    notes: en.notes,
  });
}
