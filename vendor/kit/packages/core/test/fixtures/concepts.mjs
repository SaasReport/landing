// A small, valid concept series for the tests of concepts.js and the CLI (en-GB, a Shariah ledger or none).
export const config = (over = {}) => ({
  $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/concepts-config.schema.json",
  minConcepts: 5, verify: { texts: "texts" },
  series: { id: "contracts-in-a-minute", show: "concepts", title: "Contracts in a Minute", at: "06:00", start: "2026-11-01", maxSeconds: 80, marginSeconds: 8 },
  locale: "en-GB", titleLocales: ["en-GB"], catalogue: "content/concepts.catalogue.json", schedule: "content/concepts.schedule.json",
  speakers: { host: "amina", expert: "yusuf" },
  links: { glossary: "/glossary/{slug}/", widget: "/lab/#{scenario}" },
  format: { unit: "words", body: { min: 40, max: 130 }, total: { max: 190 }, lineMax: 240, cps: 17.4, measured: "Measured on the three published daily episodes: 183 words in 58 to 63 seconds, 182 words a minute." },
  strings: {
    intro: [["host", "Hello! {show}, episode {number}: {title}."]],
    outro: [["host", "The sources are on the page. Our voices were made with AI; see you tomorrow!"]],
    title: "{show}, episode {number}: {title}",
    glue: {
      why: ["Why does that matter?", "So why should anyone care?", "And why is that important?"],
      example: ["Can you give an example?", "What does that look like in practice?", "Show me with a case."],
      takeaway: ["In one line?", "So what is the takeaway?", "Sum it up for me."],
      views: ["Do scholars all agree?", "Is there disagreement?", "Is that the only view?"],
    },
    article: { why: "Why it matters.", example: "Example.", takeaway: "Takeaway.", views: "Positions.", sources: "Sources", asOf: "Facts as of {date}.", glossary: "Glossary: [{title}]({href}).", widget: "Try it: [{label}]({href}).", disclaimer: "Education, not a ruling." },
  },
  lint: { forbid: [{ pattern: "all scholars agree", reason: "no single position is presented as universal" }] },
  gate: { accuracy: { minVerifiedPrefix: 2, unverified: "after-prefix" } },
  order: { strategy: "theme-round-robin" },
  runwayDays: 5,
  ...over,
});

const words = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(" ");
export const source = (n = 1) => ({ document: `Standard number ${n}`, publisher: "A Standard Setter", kind: "primary", url: `https://example.org/standards/${n}`, section: `para ${n}`, quote: `The quote of standard ${n}, long enough to count.`, retrieved: "2026-10-07", sha256: `${n}`.padStart(64, "a") });

export function concept(id, theme, over = {}) {
  return {
    id, theme, title: { "en-GB": `Title of ${id}` }, definition: { "en-GB": `One sentence that defines ${id}.` }, difficulty: "intro", related: [],
    sources: [source(id.length)],
    accuracy: { status: "verified", checked: "2026-10-07", by: "agent, session test" },
    episode: { hook: `What is ${id}, really?`, definition: `${words(14, "definition")}.`, why: `${words(14, "why")}.`, example: `${words(14, "example")}.`, takeaway: `${words(7, "takeaway")}.` },
    ...over,
  };
}

export const catalogue = (concepts) => ({
  $schema: "https://github.com/SaasReport/kit/blob/main/packages/core/schemas/concept-catalogue.schema.json",
  series: "contracts-in-a-minute", locale: "en-GB", asOf: "2026-10-07",
  themes: [{ id: "sales", title: { "en-GB": "Sales" } }, { id: "leases", title: { "en-GB": "Leases" } }, { id: "risk", title: { "en-GB": "Risk" } }],
  concepts: concepts || [
    concept("murabaha", "sales"), concept("salam", "sales", { difficulty: "intermediate" }), concept("istisna", "sales", { difficulty: "advanced", prerequisites: ["salam"], related: ["salam"] }),
    concept("ijara", "leases"), concept("sukuk-ijara", "leases", { difficulty: "advanced", prerequisites: ["ijara"] }),
    concept("tawarruq", "risk", { contested: true, views: [{ label: "Position A", position: "Permitted when the sale is real and not arranged in advance." }, { label: "Position B", position: "Prohibited when organised as a prearranged cash-raising device." }], episode: { hook: "Is tawarruq accepted everywhere?", definition: `${words(14, "definition")}.`, why: `${words(14, "why")}.`, example: `${words(14, "example")}.`, takeaway: `${words(7, "takeaway")}.`, views: `${words(14, "views")}.` } }),
    concept("gharar", "risk", { accuracy: { status: "unverified", checked: "2026-10-07", reason: "The AAOIFI text is behind a paywall and could not be read." } }),
  ],
});
