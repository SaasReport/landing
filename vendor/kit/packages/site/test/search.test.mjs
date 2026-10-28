// The global search (assets/shell.js, src/shell.js): the matching engine (fold, typo, highlight) run in Node, the version 2
// index every build writes (schema, sections, facets, synonyms), the search config, and the markup for assistive technology.
// The same engine in a real browser, typed with real keys, is `kit site search-qa` (packages/cli/test/search-qa.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { buildSite, checkProject, checkSearchIndex, checkShell, searchIndex, searchOptions, shellMarkup, SEARCH_INDEX, SEARCH_INDEX_SCHEMA } from "../src/index.js";
import { fold as serverFold } from "../src/shell.js";
import sample from "../../../examples/site-sample/site.config.js";
import { tempDir, fileTempDir } from "../../core/test/support/temp.mjs";

const root = new URL("../../../examples/site-sample/", import.meta.url).pathname;
const build = (out, project) => { const r = buildSite(project, { root, outDir: out, write: true }); return { out, files: r.files, idx: JSON.parse(readFileSync(join(out, SEARCH_INDEX), "utf8")) }; };

// the client script as the browser gets it, in a sandbox with no page: it publishes globalThis.KitSearch and stops
const { files } = build(fileTempDir("kit-search-"), sample);
const sandbox = { document: { querySelector: () => null, querySelectorAll: () => [] }, navigator: { platform: "" } };
vm.runInNewContext(files["shell.js"], sandbox, { filename: "shell.js" });
const K = sandbox.KitSearch;
const J = (x) => JSON.parse(JSON.stringify(x));   // the sandbox has its own Array: compare plain data

test("the client's fold is the index's fold: one rule, written twice, proven equal", () => {
  for (const s of ["Regulation™", "علي", "كتاب", "صكوك ۱۴۰۵", "سال ١٤٠٥", "بانک‌های ایران", "ﷲ", "Café", "مؤسسة"]) assert.equal(K.fold(s), serverFold(s), s);
});

test("near: one edit away, words of 5+ letters only, never the word itself", () => {
  const vocab = ["regulation", "murabaha", "sukuk", "بانک", "بانکداری", "پرداخت", "settlement"];
  const near = (w, v = vocab) => J(K.near(w, v));
  assert.deepEqual(near("regulaton"), ["regulation"]);       // a letter missing
  assert.deepEqual(near("murabha"), ["murabaha"]);           // a letter missing
  assert.deepEqual(near("regulatoin"), ["regulation"]);      // two swapped
  assert.deepEqual(near("settlemant"), ["settlement"]);      // a letter wrong
  assert.equal(near("بانکک")[0], "بانک");                    // a letter added (Persian)
  assert.deepEqual(near("پردداخت"), ["پرداخت"]);
  assert.deepEqual(near("sukuc"), ["sukuk"], "five letters is the shortest word that is forgiven");
  assert.deepEqual(near("bank", ["banc", "bonk"]), [], "under 5 letters: no guessing");
  assert.deepEqual(near("regulation"), [], "the word itself is not a correction");
});

test("near is bounded: a big vocabulary is read once, word by word, and at most five come back", () => {
  const words = Array.from({ length: 20000 }, (_, i) => `term${i.toString(36)}x`);
  let read = 0;   // a work counter, not a clock: one pass over the vocabulary whatever the runner's load
  const vocab = { *[Symbol.iterator]() { for (const w of words) { read++; yield w; } } };
  const r = K.near("termabcx", vocab);
  assert.equal(read, words.length, "every word is read exactly once: no second pass, no pairwise comparison");
  assert.ok(r.length <= 5);
});

test("mark: the matched text in <mark>, found after folding and put back at the original offsets", () => {
  assert.equal(K.mark("Open Finance", ["finance"]), "Open <mark>Finance</mark>");
  assert.equal(K.mark("بانک‌های ایران", ["بانکهای"]), "<mark>بانک‌های</mark> ایران", "a ZWNJ inside the word is inside the match");
  assert.equal(K.mark("بانک‌های ایران", ["بانکها"]), "<mark>بانک‌ها</mark>ی ایران", "a part of a word marks that part");
  assert.equal(K.mark("علي رضا", ["علی"]), "<mark>علي</mark> رضا", "Arabic yeh matches Persian yeh");
  assert.equal(K.mark("كتاب خوب", ["کتاب"]), "<mark>كتاب</mark> خوب", "Arabic kaf matches Persian kaf");
  assert.equal(K.mark("سال ۱۴۰۵ خورشیدی", ["1405"]), "سال <mark>۱۴۰۵</mark> خورشیدی", "Persian digits match Latin digits");
  assert.equal(K.mark("سال 1405", K.words("۱۴۰۵")), "سال <mark>1405</mark>", "the terms are the folded words of the query");
  assert.equal(K.mark("Sukuk and sukuk", ["sukuk"]), "<mark>Sukuk</mark> and <mark>sukuk</mark>", "case, every occurrence");
  assert.equal(K.mark("a & b", ["b"]), "a &amp; <mark>b</mark>");
  assert.equal(K.mark("nothing", ["zzz"]), "nothing");
  assert.equal(K.mark("abc", []), "abc");
  assert.equal(K.mark("Café crème", ["cafe"]), "<mark>Café</mark> crème", "accents fold");
});

test("mark escapes the page's text: markup in a title is text, never markup", () => {
  const evil = `<img src=x onerror="alert(1)"> sukuk & "quotes" 'single'`;
  const html = K.mark(evil, ["sukuk"]);
  assert.ok(!/<img/.test(html), html);
  assert.equal(html, `&lt;img src=x onerror=&quot;alert(1)&quot;&gt; <mark>sukuk</mark> &amp; &quot;quotes&quot; &#39;single&#39;`);
  assert.equal(K.mark(`<b>x</b>`, ["x"]), "&lt;b&gt;<mark>x</mark>&lt;/b&gt;");
});

test("mark joins overlapping and adjacent matches, and never splits a character", () => {
  assert.equal(K.mark("open banking", ["open", "banking"]), "<mark>open</mark> <mark>banking</mark>");
  assert.equal(K.mark("abcdef", ["abc", "bcd"]), "<mark>abcd</mark>ef");
  assert.equal(K.mark("😀 sukuk", ["sukuk"]), "😀 <mark>sukuk</mark>");
});

test("find: every word of the query, a substring or one edit away, with the words to mark", () => {
  const texts = ["پرداخت به تأمین‌کننده", "مقایسه پیشنهادهای وام", "ایجاد امانت", "Open banking settlement"];
  assert.deepEqual(J(K.find("پرداخت", texts).map((r) => r.i)), [0]);
  assert.deepEqual(J(K.find("تامین", texts).map((r) => r.i)), [0], "the hamza is folded away: تامین finds تأمین");
  assert.deepEqual(J(K.find("تأمین کننده", texts).map((r) => r.i)), [0], "ZWNJ is a space in the text and absent in the query: both words are found");
  assert.deepEqual(J(K.find("settlemant", texts).map((r) => [r.i, r.terms])), [[3, ["settlement"]]]);
  assert.deepEqual(J(K.find("وام پیشنهاد", texts).map((r) => r.i)), [1]);
  assert.deepEqual(J(K.find("x", texts)), [], "one letter is not a word");
});

test("the index is version 2 for every site: sections from the pages, valid against the schema", (t) => {
  const { idx } = build(tempDir(t, "kit-search-"), sample);
  assert.equal(idx.v, 2);
  assert.deepEqual(checkSearchIndex(idx), []);
  assert.deepEqual(idx.sections.map((s) => s[0]), ["home", "academy", "directory", "lab", "legal", "sectors", "terminal"]);
  assert.equal(idx.meta.length, idx.pages.length);
  assert.deepEqual(idx.facets, []);
  assert.deepEqual(idx.synonyms, []);
  const home = idx.pages.findIndex((p) => p[0] === "/");
  assert.equal(idx.meta[home][0], 0);
  assert.equal(idx.meta[home][1], 20, "the home page weighs most");
});

test("the language prefix is not a section, and a section's label is its own page's, with the site name taken off", (t) => {
  const dir = tempDir(t, "kit-idx-");
  const put = (rel, html) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), html); };
  const page = (t) => `<!doctype html><title>${t}</title><meta name="description" content="d ${t}"><main><h1>${t}</h1><p>body of ${t}</p></main>`;
  put("index.html", page("Acme Home")); put("academy/index.html", page("Academy Acme™ | paths")); put("academy/a/index.html", page("Lesson a")); put("ar/index.html", page("Acme Home ar")); put("ar/academy/index.html", page("Academy ar"));
  const idx = searchIndex(dir, { localePaths: ["/", "/ar/"], homeLabel: "Home", strip: ["\\s*(?:Acme)™?\\s*"] });
  assert.deepEqual(idx.sections, [["home", "Home"], ["academy", "Academy"]]);
  const of = (url) => idx.sections[idx.meta[idx.pages.findIndex((p) => p[0] === url)][0]][0];
  assert.deepEqual([of("/"), of("/academy/"), of("/academy/a/"), of("/ar/"), of("/ar/academy/")], ["home", "academy", "academy", "home", "academy"], "ar/academy is in academy, not in a section called ar");
});

test("the project's search config: sections by rule, facets by rule, synonyms; all in the index and the schema", (t) => {
  const cfg = {
    sections: [{ id: "learn", label: "Learn", paths: ["/academy/**", "/lab/**"] }],
    facets: [{ id: "topic", label: "Topic", values: [{ id: "tools", label: "Tools", synonyms: ["utilities"], match: { paths: ["/lab/**", "/terminal/**"] } }, { id: "unused", label: "Unused", match: { words: ["zzzz-nothing"] } }] }],
    synonyms: [["sukuk", "islamic bonds", "صکوک"]],
  };
  assert.deepEqual(checkProject({ ...sample, search: cfg }), []);
  const { idx } = build(tempDir(t, "kit-search-"), { ...sample, search: cfg });
  assert.deepEqual(checkSearchIndex(idx), []);
  assert.deepEqual(idx.sections.map((s) => s[0]).slice(0, 1), ["learn"], "a section by rule comes first");
  assert.equal(idx.sections.find((s) => s[0] === "learn")[1], "Learn");
  assert.equal(idx.facets.length, 1);
  assert.deepEqual(idx.facets[0].values.map((v) => v.slice(0, 3)), [["tools", "Tools", 0], ["unused", "Unused", 1]]);
  assert.deepEqual(idx.facets[0].values[0][3], ["utilities"]);
  assert.deepEqual(idx.synonyms, cfg.synonyms);
  const lab = idx.pages.findIndex((p) => p[0] === "/lab/"), term = idx.pages.findIndex((p) => p[0] === "/terminal/"), home = idx.pages.findIndex((p) => p[0] === "/");
  assert.deepEqual(idx.meta[lab][2], [0]); assert.deepEqual(idx.meta[term][2], [0]); assert.deepEqual(idx.meta[home][2], []);
  assert.equal(idx.sections[idx.meta[lab][0]][0], "learn");
});

test("a bad search config is refused, with the path", () => {
  for (const [bad, where] of [[{ synonyms: [["one"]] }, "search/synonyms/0"], [{ sections: [{ id: "A b", label: "x", paths: ["/a/"] }] }, "search/sections/0/id"], [{ facets: [{ id: "f", label: "F", values: [{ id: "v", label: "V", match: {} }] }] }, "search/facets/0/values/0/match"], [{ extra: 1 }, "search"]]) {
    const p = checkProject({ ...sample, search: bad });
    assert.ok(p.some((x) => x.startsWith(where)), `${where}: ${p.join(" | ")}`);
  }
});

test("checkSearchIndex names what a schema cannot: a missing meta row, a section or facet out of range, a page out of range", (t) => {
  const { idx } = build(tempDir(t, "kit-search-"), sample);
  const bad = (f) => { const c = structuredClone(idx); f(c); return checkSearchIndex(c); };
  assert.ok(bad((c) => c.meta.pop()).some((p) => /meta has/.test(p)));
  assert.ok(bad((c) => { c.meta[0][0] = 99; }).some((p) => /section 99/.test(p)));
  assert.ok(bad((c) => { c.meta[0][2] = [3]; }).some((p) => /facet value/.test(p)));
  assert.ok(bad((c) => { c.terms.zzz = [999]; }).some((p) => /page beyond/.test(p)));
  assert.ok(bad((c) => { c.v = 1; }).length, "version 1 is not version 2");
  assert.ok(bad((c) => { c.sections.push(["home", "again"]); }).some((p) => /share an id/.test(p)));
  assert.equal(SEARCH_INDEX_SCHEMA.title, "kit.search-index.v2");
});

test("checkShell refuses a version 1 index: kit site build writes version 2", (t) => {
  const { out } = build(tempDir(t, "kit-search-"), sample);
  assert.deepEqual(checkShell(out).problems, []);
  writeFileSync(join(out, SEARCH_INDEX), JSON.stringify({ v: 1, pages: [["/", "Home", "", ""]], terms: {} }));
  assert.ok(checkShell(out).problems.some((p) => /is version 1, not 2/.test(p)));
});

test("searchOptions: the language prefixes and the site's own names come from the project", () => {
  const o = searchOptions({ ...sample, trademark: { names: ["Example (Open)"], mark: "™" }, search: { synonyms: [["a1", "b1"]] } }, { localePaths: ["/", "/ar/"], homeLabel: "Home" });
  assert.deepEqual(o.localePaths, ["/", "/ar/"]);
  assert.equal(o.homeLabel, "Home");
  assert.deepEqual(o.synonyms, [["a1", "b1"]]);
  assert.ok(new RegExp(o.strip[0], "gu").test("Example (Open)™"), "names are escaped, not patterns");
});

test("the dialog is a combobox over a listbox of options, with a live count, a hint, the corrected-word note and the strings of its locale", () => {
  const { panels } = shellMarkup({ menu: [], t: (k) => ({ searchHint: "H!", searchCount: "{n} found", searchFixed: "for {to} not {from}" })[k] || k });
  assert.match(panels, /<input type="search"[^>]*role="combobox"[^>]*aria-autocomplete="list"[^>]*aria-expanded="false"[^>]*aria-controls="kshell-results"/);
  assert.match(panels, /<ol class="kshell__results" id="kshell-results" role="listbox"/);
  assert.match(panels, /<div class="kshell__sr" role="status" aria-live="polite" data-kit-count>/);
  assert.match(panels, /<p class="kshell__note" data-kit-note hidden>/);
  assert.match(panels, /data-kit-hint="H!" data-kit-found="\{n\} found" data-kit-fixed="for \{to\} not \{from\}"/);
});

test("the dialog's attributes cannot be taken for a page script's: no data-count (the landing's counters write into it), data-hint or data-fixed", () => {
  const { panels } = shellMarkup({ menu: [], t: (k) => k });
  const tag = panels.match(/<div class="kshell__search"[^>]*>/)[0];
  for (const bad of ["data-count=", "data-hint=", "data-fixed="]) assert.ok(!tag.includes(bad), bad);
  assert.match(tag, /data-all="[^"]+"/);
});

test("the shell script yields Ctrl/K to a page that took it, on window and bubbling, so the page's own handler always runs first", () => {
  const src = files["shell.js"];
  assert.match(src, /window\.addEventListener\("keydown"[\s\S]*?e\.key === "k"[\s\S]*?if \(e\.defaultPrevented\) return;/);
  assert.doesNotMatch(src, /document\.addEventListener\("keydown", \(e\) => \{\s*const typing/, "no second owner of the shortcut on document");
});

test("every locale pack has the search strings, with {n}, {from} and {to} where they are used", async () => {
  for (const code of ["fa", "en", "ar"]) {
    const { default: pack } = await import(`../src/locales/${code}.js`);
    const t = pack.t ? (k) => pack.t(k) : (k) => pack.strings?.[k];
    const s = (k) => (pack.strings || pack)[k] ?? t(k);
    for (const k of ["searchHint", "searchCount", "searchFixed", "searchAll", "searchFilter"]) assert.ok(s(k), `${code}.${k}`);
    assert.match(s("searchCount"), /\{n\}/, code);
    assert.match(s("searchFixed"), /\{from\}/, code); assert.match(s("searchFixed"), /\{to\}/, code);
  }
});
