/**
 * British English for spoken scripts (owner, 2026-10-06: two downstream sites podcasts are British English, accent and spelling).
 * usSpellings(text) → the American spellings found, each with the British form. The list is maintained here (add a pair when a
 * script slips through); it only holds words that are wrong in British English in every sense, so it has no false positives on
 * "program" (a computer program), "license" (the verb), "check" or "practice" (the noun).
 */
const PAIRS = {
  // -ise
  organize: "organise", organization: "organisation", recognize: "recognise", authorize: "authorise", authorization: "authorisation",
  standardize: "standardise", standardization: "standardisation", customize: "customise", customization: "customisation",
  finalize: "finalise", formalize: "formalise", digitize: "digitise", digitization: "digitisation", monetize: "monetise",
  optimize: "optimise", optimization: "optimisation", prioritize: "prioritise", minimize: "minimise", maximize: "maximise",
  utilize: "utilise", utilization: "utilisation", realize: "realise", realization: "realisation", summarize: "summarise",
  capitalize: "capitalise", capitalization: "capitalisation", centralize: "centralise", decentralize: "decentralise",
  decentralization: "decentralisation", harmonize: "harmonise", harmonization: "harmonisation", categorize: "categorise",
  characterize: "characterise", legitimize: "legitimise", materialize: "materialise", normalize: "normalise", penalize: "penalise",
  specialize: "specialise", stabilize: "stabilise", synchronize: "synchronise", tokenize: "tokenise", tokenization: "tokenisation",
  securitize: "securitise", securitization: "securitisation", liquidize: "liquidise", globalize: "globalise", globalization: "globalisation",
  modernize: "modernise", operationalize: "operationalise", visualize: "visualise", itemize: "itemise", amortize: "amortise",
  amortization: "amortisation", immunize: "immunise", emphasize: "emphasise", apologize: "apologise", criticize: "criticise",
  generalize: "generalise", localize: "localise", personalize: "personalise", rationalize: "rationalise", subsidize: "subsidise",
  sensitize: "sensitise", incentivize: "incentivise", socialize: "socialise", internalize: "internalise",
  // -yse
  analyze: "analyse", analyzed: "analysed", analyzes: "analyses", analyzing: "analysing", paralyze: "paralyse", catalyze: "catalyse",
  // -our
  color: "colour", colors: "colours", behavior: "behaviour", behaviors: "behaviours", favor: "favour", favorable: "favourable", favorite: "favourite",
  honor: "honour", labor: "labour", neighbor: "neighbour", neighbors: "neighbours", harbor: "harbour", humor: "humour", rumor: "rumour", vigor: "vigour",
  // -re
  center: "centre", centers: "centres", centered: "centred", theater: "theatre", fiber: "fibre", liter: "litre", caliber: "calibre",
  // -ence
  defense: "defence", offense: "offence", pretense: "pretence",
  // doubled consonants and others
  canceled: "cancelled", canceling: "cancelling", labeled: "labelled", labeling: "labelling", modeling: "modelling", modeled: "modelled",
  traveler: "traveller", travelers: "travellers", traveled: "travelled", traveling: "travelling", counselor: "counsellor", fueled: "fuelled",
  fulfill: "fulfil", fulfillment: "fulfilment", enrollment: "enrolment", installment: "instalment", installments: "instalments", skillful: "skilful",
  judgment: "judgement", acknowledgment: "acknowledgement", catalog: "catalogue", dialog: "dialogue", analog: "analogue", gray: "grey", aluminum: "aluminium",
  tire: "tyre", plow: "plough", mold: "mould", pajamas: "pyjamas", skeptic: "sceptic", skeptical: "sceptical", artifact: "artefact", maneuver: "manoeuvre",
  mom: "mum", cozy: "cosy", donut: "doughnut", jewelry: "jewellery", sulfur: "sulphur", curb: "kerb",
};
// every -ize verb's forms (-ized, -izes, -izing) and -ization's plural follow from the pair, and so do their un- forms
const US = { ...PAIRS, unauthorized: "unauthorised", unrecognized: "unrecognised", unorganized: "unorganised" };
for (const [us, gb] of Object.entries(PAIRS)) {
  if (/(?:ize|yze)$/.test(us)) Object.assign(US, { [`${us}d`]: `${gb}d`, [`${us}s`]: `${gb}s`, [`${us.slice(0, -1)}ing`]: `${gb.slice(0, -1)}ing` }, US);
  if (us.endsWith("ization")) US[`${us}s`] ??= `${gb}s`;
}
// "licence" (noun) vs "license" (verb): the noun spelling is checked by a phrase list (a licence, the licence, licence fee, no licence, ...)
const LICENSE_NOUN = /\b(?:a|an|the|this|that|our|your|their|its|no|any|each|every|per|open|software|commercial|banking|operating|driving|valid|full|restricted|new|such)\s+license(s)?\b/gi;

/**
 * The parts of a text a spelling pass never touches: code (``` fences and `code spans`: an identifier, a status value
 * like `canceled`, a file name), URLs, and the exceptions a project lists (names, titles, protocol values spelled the
 * American way by their owners: one list per project, spelling.exceptions.json, shared by its site and podcast checks).
 * Each is replaced by a placeholder; restore() puts them back exactly.
 */
/**
 * The exceptions that hold everywhere: an entry scoped by `files` (an HTTP reason phrase in one script) belongs to
 * those files' text only, so content with no file of its own (a podcast's spoken lines) never gets it.
 */
export const unscoped = (exceptions = []) => exceptions.filter((e) => !e?.files);

export const exceptionRe = (e) => new RegExp(`(?<![A-Za-z])${String(e.phrase ?? e).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?(?![A-Za-z])`, "gi");

function protect(text, exceptions = []) {
  const kept = [];
  // the placeholder keeps the held text's line breaks, so positions in the protected text map to the same lines
  const hold = (m) => { kept.push(m); return `\u0000${kept.length - 1}${"\n".repeat((m.match(/\n/g) || []).length)}\u0000`; };
  let t = String(text ?? "").replace(/```[\s\S]*?```|`[^`\n]+`/g, hold).replace(/https?:\/\/[^\s"'<>)]+/g, hold);
  // an exception holds its plural too ("authorization server" covers "authorization servers")
  for (const e of exceptions) t = t.replace(exceptionRe(e), hold);
  return { text: t, restore: (x) => x.replace(/\u0000(\d+)\n*\u0000/g, (_, i) => kept[+i]) };
}

/** American spellings in a text: [{ us, gb, index, line }] (line: 1-based, in the text as given). Code, URLs and the exceptions are skipped. */
export function usSpellings(text, { exceptions = [] } = {}) {
  const out = [];
  const t = protect(text, exceptions).text;
  const lineAt = (i) => (t.slice(0, i).match(/\n/g) || []).length + 1;
  // a word joined by _ is an identifier (authorization_details), never a spelling
  for (const m of t.matchAll(/[A-Za-z]+(?:_[A-Za-z0-9]+)*/g)) { const w = m[0].toLowerCase(); if (!w.includes("_") && US[w]) out.push({ us: w, gb: US[w], index: m.index, line: lineAt(m.index) }); }
  for (const m of t.matchAll(LICENSE_NOUN)) out.push({ us: m[0].split(/\s+/).pop().toLowerCase(), gb: m[1] ? "licences" : "licence", context: m[0], index: m.index, line: lineAt(m.index) });
  return out.sort((a, b) => a.index - b.index).map(({ index, ...x }) => x);
}
/** Whether the word list is internally consistent (every British form differs from the American one). */
export const SPELLING_PAIRS = Object.keys(US).length;

const cap = (from, to) => (from === from.toUpperCase() && from.length > 1 ? to.toUpperCase() : from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);

/**
 * Script generation in British English: every American spelling of the list becomes its British form (case kept), the noun
 * "license" becomes "licence", and phrases a project lists as exceptions (a spec's own title, an API status value, a file name)
 * are left exactly as written, and so is code (`canceled` in backticks, fenced blocks) and every URL. Pure and idempotent; applied by episodeFromItem when config.tts.spelling.variant is "en-GB".
 */
export function britishSpelling(text, { exceptions = [] } = {}) {
  const { text: held, restore } = protect(text, exceptions);
  let t = held.replace(LICENSE_NOUN, (m) => m.replace(/license(s?)$/i, (x, pl) => cap(x, "licence") + (pl ? "s" : "")));
  t = t.replace(/[A-Za-z]+(?:_[A-Za-z0-9]+)*/g, (w) => (!w.includes("_") && US[w.toLowerCase()] ? cap(w, US[w.toLowerCase()]) : w));
  return restore(t);
}
