// The gate for the ReDoS class: attacker bytes are never matched by a regular expression with a quantifier. Quantified regexes
// backtrack (nested, overlapping or adjacent quantifiers are quadratic or exponential); the upload code reads its input with the
// linear scanners of lex.js / xml.js / css.js and the text and PDF scanners built on them. This test fails on any regex in
// packages/uploads/src with a quantifier, on any RegExp( constructor, and it times every parser entry point on the pathological
// repeats the reviews used, under a CPU budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { findings, jsFiles, read } from "./helpers/js-ast.mjs";
import { sniff, matchesDeclared } from "../src/sniff.js";
import { normaliseFilename } from "../src/filename.js";
import { triage } from "../src/triage/index.js";
import { TYPES } from "../src/sniff.js";
import { parseXml } from "../src/xml.js";
import { cssExternal } from "../src/css.js";
import { readZip } from "../src/zip.js";
import { contentDisposition } from "../src/serve.js";
import { cat, enc, pdf, zip, ooxml, png } from "./fixtures.mjs";
import { measure } from "../src/work.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * The gate reads JavaScript with a real parser (acorn), not with patterns: regex literals, every reference to RegExp (new, call, an
 * alias, Reflect.construct, globalThis.RegExp, computed access to a global) and the string methods that turn an argument into a
 * pattern (match, matchAll, search) or may be handed a RegExp (replace, replaceAll, split with anything but a string) are all found.
 *
 * packages/uploads/src: NOTHING quantified, nothing built from a string, no registry. The other code that parses attacker input
 * (request bodies, URLs, webhook headers, a TTS server's reply, mail and decide Workers) may keep a regex only when it is listed
 * here with the reason it is linear or never sees attacker bytes: a registry of reviewed scanners, matched on file and pattern.
 */
const STRICT = ["packages/uploads/src"];
const ATTACKER_INPUT = [
  "packages/cloudflare/src/forms-intake.js", "packages/cloudflare/src/body.js", "packages/cloudflare/src/webhooks.js", "packages/cloudflare/src/csp.js",
  "packages/core/src/safe-fetch.js", "packages/channels/src/webhooks.js", "packages/channels/src/adapters.js",
  "packages/comms/workers", "packages/decide/deploy/saasreport-decide/src", "packages/podcast/src/providers/gradio.js",
];
const LINEAR = JSON.parse(readFileSync(new URL("./regex-linear.json", import.meta.url), "utf8")).entries.map((e) => [e.file, e.pattern, e.why, e.in ?? null]);   // a schema-validated data file (kit.regex-linear.v1), not code
const linearListed = (file, what, fn) => LINEAR.some(([f, p, , inFn]) => f === file && p === what && (inFn === null || inFn === fn));

/** What a file breaks: quantified regex literals, any RegExp reference, computed global access, string-pattern calls. */
function violations(file, src, { strict }) {
  const out = [];
  for (const f of findings(src)) {
    const what = f.kind === "regex" ? f.detail.pattern : f.kind === "regexp-reference" ? "RegExp" : null;
    if (f.kind === "regex" && !f.detail.quantified) continue;
    if (!strict && what !== null && linearListed(file, what, f.fn)) continue;
    out.push(`${file}:${f.line} ${f.kind} ${JSON.stringify(f.detail)}`);
  }
  return out;
}

test("the gate's eyes: a real parser finds every way to build or run a pattern", () => {
  const kinds = (src) => findings(src).map((f) => `${f.kind}${f.kind === "regex" ? (f.detail.quantified ? ":q" : "") : ""}`);
  assert.deepEqual(kinds("if (x) /a+b/.test(s);"), ["regex:q"]);
  assert.deepEqual(kinds("function f(){}\n/a+/.test(s);"), ["regex:q"]);
  assert.deepEqual(kinds("async () => await /x+/.exec(s);"), ["regex:q"]);
  assert.deepEqual(kinds("function* g(){ yield /x+/.exec(s); }"), ["regex:q"]);
  assert.deepEqual(kinds("x = a\n/c/g; y = 2 / 3 / 4;"), []);   // division, as JavaScript reads it
  assert.deepEqual(kinds("x = `${ {a:1}.a }`; y = /q+/;"), ["regex:q"]);
  assert.deepEqual(kinds("y = /[a]+/v;"), ["regex:q"]);
  assert.deepEqual(kinds("x = /\\(?a/;"), ["regex:q"]);
  assert.deepEqual(kinds("x = /(?:a|b)/;"), ["regex"]);
  assert.deepEqual(kinds("s.match('(a+)+$');"), ["string-pattern"]);
  assert.deepEqual(kinds("s.search('a*b');"), ["string-pattern"]);
  assert.deepEqual(kinds("s.matchAll(new String('a+'));"), ["string-pattern"]);
  assert.deepEqual(kinds("const SEP = (0, /\\s+/); s.split(SEP);"), ["regex:q", "pattern-argument"]);
  assert.deepEqual(kinds("const R = RegExp; new R('a+');"), ["regexp-reference"]);
  assert.deepEqual(kinds("new RegExp ('a+');"), ["regexp-reference"]);
  assert.deepEqual(kinds("Reflect.construct(RegExp, ['a+']);"), ["regexp-reference"]);
  assert.deepEqual(kinds("globalThis.RegExp('a');"), ["regexp-reference"]);
  assert.deepEqual(kinds("globalThis['Reg' + 'Exp']('a');"), ["computed-method", "global-access"]);
  assert.deepEqual(kinds("window['RegExp']('a');"), ["regexp-reference"]);
  assert.deepEqual(kinds("const { RegExp: R } = globalThis; new R('a');"), ["regexp-reference"]);
  assert.ok(kinds("const { RegExp } = globalThis;").length > 0 && kinds("const { RegExp } = globalThis;").every((k) => k === "regexp-reference"));
  assert.deepEqual(kinds("s.replace('a', 'b'); s.split(','); s.split(`x${y}`); s.replaceAll('a', 'b');"), []);
  assert.deepEqual(kinds("s.replace(rx, 'b');"), ["pattern-argument"]);
  assert.deepEqual(kinds("a / b / c; x = '/a+/'; // /z+/"), []);
  // L4: the ways round the method-call check
  assert.deepEqual(kinds("s['match']('(a+)+$');"), ["string-pattern"]);
  assert.deepEqual(kinds("s[`search`]('a*b');"), ["computed-method"]);
  assert.ok(kinds("s.replace.call(s, rx, 'b');").includes("pattern-method-reference"));
  assert.ok(kinds("String.prototype.match.call(s, r);").includes("pattern-method-reference"));
  assert.ok(kinds("const m = s.match; m.call(s, r);").includes("pattern-method-reference"));
  assert.ok(kinds("s.split.apply(s, [r]);").includes("pattern-method-reference"));
  assert.ok(kinds("const f = s.matchAll.bind(s);").includes("pattern-method-reference"));
  assert.ok(kinds("s[name](r);").includes("computed-method"));
  assert.deepEqual(kinds("eval('/a+/')"), ["dynamic-code"]);
  assert.deepEqual(kinds("new Function('return /a+/')"), ["dynamic-code"]);
  assert.deepEqual(kinds("Function('x', 'y')"), ["dynamic-code"]);
  assert.ok(kinds("(() => {}).constructor('return 1')()").includes("dynamic-code"));
  assert.deepEqual(kinds("x.eval; ({ Function: 1 }); s.matchAll('x');").sort(), ["string-pattern"]);
});

test("packages/uploads/src: no quantified regex, no RegExp in any form, no string used as a pattern, and no registry to hide behind", () => {
  const files = jsFiles(SRC);
  assert.ok(files.length >= 25, `only ${files.length} source files found`);
  const bad = files.flatMap((f) => violations(f.slice(ROOT.length), read(f), { strict: true }));
  assert.deepEqual(bad, []);
  assert.ok(STRICT.length === 1 && !LINEAR.some(([f]) => f.startsWith("packages/uploads/")), "uploads has no registry entries");
});

test("every other file that parses attacker input: a quantified regex or RegExp only when it is on the reviewed linear list, and the list has no stale entries", () => {
  const bad = [], seen = new Set();
  for (const entry of ATTACKER_INPUT) {
    const files = jsFiles(ROOT + entry);
    assert.ok(files.length >= 1, entry);
    for (const f of files) {
      const rel = f.slice(ROOT.length);
      const src = read(f);
      bad.push(...violations(rel, src, { strict: false }));
      for (const x of findings(src)) { const w = x.kind === "regex" ? x.detail.pattern : x.kind === "regexp-reference" ? "RegExp" : null; if (w !== null) seen.add(`${rel}|${w}|${x.fn}`); }
    }
  }
  assert.deepEqual(bad, []);
  const stale = LINEAR.filter(([f, p, , inFn]) => ![...seen].some((k) => (inFn === null ? k.startsWith(`${f}|${p}|`) : k === `${f}|${p}|${inFn}`))).map(([f, p, , inFn]) => `${f} ${p} ${inFn ?? ""}`);
  assert.deepEqual(stale, [], "an entry whose regex is gone must leave the list");
  for (const [, , why] of LINEAR) assert.ok(why.length > 10);
  const csp = LINEAR.find(([f, p]) => f.endsWith("csp.js") && p === "RegExp");
  assert.equal(csp[3], "check", "L-4: the csp.js RegExp entry covers one function, not the file");
});

/* ---------- fuzz work: every entry point, pathological repeats, a work counter ---------- */
const REPEATS = {
  spaces: " ", angle: "<", pipe: "|", "dot space": ". ", "function ": "function ", comment: "<!---->", "open comment": "<!--", "tag": "<a ", "closing": "</a ", cdata: "<![CDATA[", pi: "<?", doctype: "<!DOCTYPE", entity: "&#", "entity name": "&amp", quote: "'", dquote: '"', "url(": "url( ", "a|": "a|", "slash": "/ ", "backslash": "\\", "equals": "= ", "var ": "var ", "R": "1 0 R ", obj: "1 0 obj ", "startxref": "startxref ", eof: "%%EOF", "stream": "stream\n", name: "/N#4", "PK": "PK\x03\x04", "MZ": "MZ", "colon": ":", "nul": "\0", "zwj": "‍", "bidi": "‮", "newline": "\n", "tab comma": "\t,", "equals sign": "=cmd|'/c'!A", "hash": "#!/", "html": "<html ", "on": " onload=", "xml": "<?xml ", "svg": "<svg ", "at": "@import ", "esc": "\\69 "};
const SIZE = 150_000;   // characters of repeat per input: linear code takes single milliseconds, quadratic code seconds

const take = (unit, n = SIZE) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const part = (name, xml) => zip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name, data: xml }]);

/** Entry points, each fed the repeat in the shape its parser reads. */
const ENTRIES = {
  "sniff(raw bytes)": (s) => sniff(enc(s)),
  "sniff(after a header)": (s) => sniff(enc(`<svg>${s}`)),
  "sniff(png + glued)": (s) => sniff(cat(png(), enc(s))),
  "normaliseFilename": (s) => normaliseFilename(s),
  "matchesDeclared": (s) => matchesDeclared({ contentType: "image/png", filename: `a.${s}.png` }, TYPES.png),
  "triage(svg)": (s) => triage(enc(`<svg xmlns="http://www.w3.org/2000/svg">${s}</svg>`), TYPES.svg),
  "triage(svg, raw)": (s) => triage(enc(s), TYPES.svg),
  "triage(svg attribute)": (s) => triage(enc(`<svg a="${s}" style="${s}"/>`), TYPES.svg),
  "triage(pdf in objects)": (s) => triage(pdf([`<< /Type /Catalog /Pages 2 0 R /X ${s} >>`, "<< /Type /Pages /Kids [] /Count 0 >>"]), TYPES.pdf),
  "triage(pdf, raw)": (s) => triage(enc(`%PDF-1.7\n${s}`), TYPES.pdf),
  "triage(pdf tail)": (s) => triage(cat(pdf(), enc(s)), TYPES.pdf),
  "triage(zip names)": (s) => triage(zip([{ name: `${s}.txt`, data: "x" }]), TYPES.zip),
  "triage(docx rels)": (s) => triage(part("word/_rels/document.xml.rels", s), TYPES.docx),
  "triage(docx document)": (s) => triage(part("word/document.xml", `<w:document>${s}</w:document>`), TYPES.docx),
  "triage(xlsx sheet)": (s) => triage(part("xl/worksheets/sheet1.xml", `<worksheet><f>${s}</f></worksheet>`), TYPES.xlsx),
  "triage(pptx slide)": (s) => triage(part("ppt/slides/slide1.xml", `<p:sld a="${s}"/>`), TYPES.pptx),
  "triage(docx html part)": (s) => triage(part("word/a.html", s), TYPES.docx),
  "triage(text)": (s) => triage(enc(s), TYPES.text),
  "triage(json)": (s) => triage(enc(s), TYPES.json),
  "parseXml": (s) => parseXml(s),
  "cssExternal": (s) => cssExternal(s),
  "readZip": (s) => readZip(enc(s)),
  "contentDisposition": (s) => contentDisposition(s),
};

/**
 * The linearity proof is a work counter (src/work.js: the characters, bytes and entries a parser examined), not a clock, so it runs everywhere and a
 * loaded machine cannot decide it: doubling the input must at most double the work (2.2 allows the constant parts). Quadratic code is about 4x.
 */
const SIZES = { default: [40_000, 80_000], "triage(zip names)": [20_000, 40_000] };   // a zip entry name is at most 65535 bytes: both sizes stay below it, so the input is never clipped
for (const [entry, run] of Object.entries(ENTRIES)) {
  const [N1, N2] = SIZES[entry] || SIZES.default, SLACK = 3000;
  test(`fuzz work: ${entry} does linear work on ${Object.keys(REPEATS).length} pathological repeats (steps(2n) <= 2.2 x steps(n)), and is instrumented on every one`, async () => {
    const grown = [], uncounted = [];
    for (const [label, unit] of Object.entries(REPEATS)) {
      // no catch: these parsers answer hostile input with a verdict, never an exception, so any throw is a crash and fails the test
      const steps = async (n) => (await measure(() => run(take(unit, n)))).steps;
      const a = await steps(N1), b = await steps(N2);
      if (!(a > 0)) uncounted.push(label);
      if (b > 2.2 * a + SLACK) grown.push(`${label}: ${a} -> ${b} steps`);
    }
    assert.deepEqual(grown, [], `${entry} is not linear on: ${grown.join("; ")}`);
    assert.deepEqual(uncounted, [], `${entry} counted no work on: ${uncounted.join(", ")}: it is not instrumented for that input (src/work.js), so nothing is proven`);
  });
}
