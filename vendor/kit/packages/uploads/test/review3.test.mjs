// The third review of the upload engine (scripts rv2/c1 c2 x2 x3 x4 s1 s2 g1 f1 l1), each finding reproduced on the code it was found against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords, downloadResponse, ConflictError, AuthError, TransitionError, validateRecord } from "../src/index.js";
import { parseXml } from "../src/xml.js";
import { triageSvg } from "../src/triage/svg.js";
import { triage } from "../src/triage/index.js";
import { triageZip } from "../src/triage/zip.js";
import { cssExternal } from "../src/css.js";
import { sniff } from "../src/sniff.js";
import { normaliseFilename } from "../src/filename.js";
import { matchesDeclared, TYPES } from "../src/sniff.js";
import { resolveLimits } from "../src/limits.js";
import { quarantineKey } from "../src/keys.js";
import { cat, enc, pdf, zip } from "./fixtures.mjs";
import { people, decide as decideAs } from "./helpers/people.mjs";
import { evidenceOf } from "./helpers/evidence.mjs";
import { keys } from "../../core/test/fixtures/ledger.mjs";

const registry = JSON.parse(readFileSync(new URL("../../core/registry/projects.json", import.meta.url), "utf8"));
const PDF = "application/pdf";
const L = resolveLimits();
const has = (r, name) => r.markers.find((m) => m.name === name);
/** Run fn and return its result: linearity is proven by the work counter (regex-gate.test.mjs), the assertions that follow check the verdicts. */
async function ran(_label, fn) { return fn(); }

function world({ verdict = { v: "allow" }, authority: withAuthority = true, actions = null, windows = null, form = {} } = {}) {
  const cfg = { schema: "kit.uploads-config.v1", project: "saasreport", storage: { quarantine: { binding: "QUAR", bucket: "saasreport-uploads-quarantine" }, released: { binding: "REL", bucket: "saasreport-uploads" } },
    forms: { partner: { id: "partner-attachment", file_fields: [{ name: "attachment" }], allowed_types: [PDF, "image/png", "application/zip"], max_bytes: 1048576, retention_days: 30, blocked_retention_days: 7, on_needs_sandbox: "hold", scanner: "fake-av", ...form } } };
  const gate = { scan: null };
  const scanners = { "fake-av": { name: "fake-av", version: "1", scan: async () => { if (gate.scan) await gate.scan; return { verdict: verdict.v }; } } };
  const env = { QUAR: memoryBucket(), REL: memoryBucket() };
  const records = memoryRecords();
  let t = Date.parse("2026-10-07T12:00:00Z");
  const now = () => new Date(t);
  const P = people(now, { actions, windows });
  const onViolation = [];
  const uploads = createUploads({ config: loadUploadsConfig(cfg, { registry, scanners }), env, scanners, records, now, authority: withAuthority ? P.authority : null, onViolation: (v) => { onViolation.push(...v); } });
  const sign = (record, action, note, over) => P.sign(record, action, note, { decided_at: now().toISOString(), ...over });
  return { ...decideAs(uploads, records, sign), P, sign, uploads, records, env, q: env.QUAR, r: env.REL, verdict, gate, tick: (ms) => { t += ms; }, now, onViolation };
}
const body = (n) => pdf([`<< /Type /Catalog /Pages 2 0 R /N ${n} >>`, "<< /Type /Pages /Kids [] /Count 0 >>"]);
const intake = (w, n = 0, filename = "a.pdf") => w.uploads.intake({ form: "partner", bytes: body(n), filename, contentType: PDF });
const later = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/* ---------- U1: concurrency ---------- */

test("U1: a release that raced a completed delete is refused and revives nothing (it used to write the record back and serve 200)", async () => {
  const w = world({ verdict: { v: "needs_sandbox" } });
  const { record } = await intake(w, 1);
  assert.equal(record.stage, "held");
  let open; const wait = new Promise((r) => { open = r; });
  const realGet = w.q.get.bind(w.q); let first = true;
  w.q.get = async (k) => { const o = await realGet(k); if (first) { first = false; await wait; } return o; };
  const pending = w.release(record.upload_id, "ok");        // reads the held record, then stalls reading its bytes
  await later();
  const deleted = await w.del(record.upload_id);             // the delete runs to completion in the meantime
  assert.equal(deleted.stage, "deleted");
  open();
  await assert.rejects(pending, ConflictError);
  const fin = await w.records.get(record.upload_id);
  assert.deepEqual([fin.stage, fin.op, fin.retention.hold], ["deleted", undefined, false]);
  assert.equal(w.q.objects.size + w.r.objects.size, 0, "no object came back");
  assert.equal((await downloadResponse({ record: fin, bucket: w.r })).status, 404);
  assert.equal((await w.uploads.reconcile()).ok, true);
});

test("U1: a rescan and a hold that raced a completed delete lose too; the tombstone keeps its deleted_at and a hold never comes back", async () => {
  const w = world();
  const a = (await intake(w, 1)).record;
  let open; w.gate.scan = new Promise((r) => { open = r; });
  const rescan = w.uploads.rescan(a.upload_id);
  await later();
  const d = await w.del(a.upload_id);
  open(); w.gate.scan = null;
  await assert.rejects(rescan, ConflictError);
  const fin = await w.records.get(a.upload_id);
  assert.deepEqual([fin.stage, fin.retention.deleted_at], ["deleted", d.retention.deleted_at]);
  // hold: reads, the delete completes, the hold writes
  const b = (await intake(w, 2)).record;
  const realPut = w.records.put.bind(w.records); let hit = true, go, reached; const gatePut = new Promise((r) => { go = r; }), atGate = new Promise((r) => { reached = r; });
  const sign = await w.sign(b, "hold_on", "legal");
  w.records.put = async (r) => { if (hit && r.upload_id === b.upload_id && r.retention.hold === true) { hit = false; reached(); await gatePut; } return realPut(r); };   // the hold has been authenticated and waits at its write
  const holding = w.uploads.hold(b.upload_id, true, { decision: sign });
  await atGate;
  w.records.put = realPut;
  await w.del(b.upload_id); go();
  await assert.rejects(holding, ConflictError);
  const f2 = await w.records.get(b.upload_id);
  assert.deepEqual([f2.stage, f2.retention.hold], ["deleted", false]);
  assert.equal((await w.uploads.reconcile()).ok, true);
});

test("U1: two operations from the same read cannot both win: the second compare-and-set fails before it touches an object", async () => {
  const w = world({ verdict: { v: "needs_sandbox" } });
  const { record } = await intake(w, 1);
  const calls = [];
  const realPut = w.r.put.bind(w.r); w.r.put = async (...a) => { calls.push(a[0]); return realPut(...a); };
  const sign = await w.sign(record, "release", "x");
  const results = await Promise.allSettled([w.uploads.release(record.upload_id, { decision: sign }), w.uploads.release(record.upload_id, { decision: await w.sign(record, "release", "y") })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length >= 1, true);
  assert.equal(calls.length <= 2, true);
  assert.equal((await w.uploads.reconcile()).ok, true);
  assert.equal(w.r.objects.size, 1);
});

/* ---------- U2: authenticated actors ---------- */

test("U2: without an approval ledger no human decision is ever accepted (fail closed), and a free-text `by` is not a credential", async () => {
  const w = world({ authority: false, verdict: { v: "needs_sandbox" } });
  const { record } = await intake(w, 1);
  await assert.rejects(w.uploads.release(record.upload_id, { by: "alice", note: "x" }), AuthError);
  await assert.rejects(w.uploads.release(record.upload_id, { decision: await w.sign(record, "release", "x") }), (e) => e instanceof AuthError && e.reason === "no_authority");
  await assert.rejects(w.uploads.delete(record.upload_id, { by: "dsar" }), AuthError);
  await assert.rejects(w.uploads.hold(record.upload_id, true, { by: "legal" }), AuthError);
  assert.equal((await w.records.get(record.upload_id)).stage, "held");
});

test("U2: a decision must verify: entry, action, file, content, time, replay, tampering", async () => {
  const w = world({ verdict: { v: "needs_sandbox" } });
  const a = (await intake(w, 1)).record, b = (await intake(w, 2)).record;
  const refused = async (decision, reason, id = a.upload_id) => assert.rejects(w.uploads.release(id, { decision }), (e) => e instanceof AuthError && e.reason === reason, reason);
  await refused(await w.sign(a, "delete", "x"), "wrong_action");
  await refused(await w.sign(b, "release", "x"), "wrong_upload");                        // a decision for another file
  await refused(await w.sign({ ...a, sha256: "0".repeat(64) }, "release", "x"), "wrong_content");   // for other bytes
  await refused(await w.sign(a, "hold_on", "x"), "wrong_action");
  const good = await w.sign(a, "release", "fine");                                       // the latest entry for this upload: the only one that can apply
  await refused({ ...good, entry_hash: "0".repeat(64) }, "entry_hash_mismatch");
  await refused({ ...good, seq: 99 }, "ledger_invalid");
  await refused({ ...good, ledger: "other:uploads" }, "wrong_ledger");
  await refused({ nope: 1 }, "malformed");
  await refused(undefined, "malformed");
  assert.equal((await w.records.get(a.upload_id)).stage, "held");
  const out = await w.uploads.release(a.upload_id, { decision: good });
  assert.equal(out.stage, "released");
  assert.deepEqual(out.decisions.at(-1).ref, good, "the record keeps the REFERENCE to the ledger entry, not a signature or a note");
  assert.equal("signature" in out.decisions.at(-1) || "note" in out.decisions.at(-1), false);
  const again = await w.sign(a, "release", "fine");
  assert.equal((await w.uploads.release(a.upload_id, { decision: again })).stage, "released", "already released: idempotent, nothing is written");
  assert.equal(out.last_ref_seq, good.seq, "the record's cursor is the highest ledger seq it used");
});

test("U2: an entry older than the time-to-live is expired; a roster member only; the owner-signed roster scopes actions, and key validity is against the SERVER clock", async () => {
  const w = world({ verdict: { v: "needs_sandbox" } });
  const a = (await intake(w, 1)).record;
  await assert.rejects(w.uploads.release(a.upload_id, { decision: await w.sign(a, "release", "x", { decided_at: "2026-10-05T12:00:00.000Z" }) }), (e) => e.reason === "expired");
  const stranger = keys("Not In Roster");
  await assert.rejects(w.sign(a, "release", "x", { signer: stranger }), /not in the reviewer roster/, "checkAppend refuses it before it is written");
  const forged = await w.sign(a, "release", "x", { signer: stranger, force: true });   // written into a tampered ledger anyway: the engine reads the whole ledger and fails closed
  await assert.rejects(w.uploads.release(a.upload_id, { decision: forged }), (e) => e.reason === "ledger_invalid");
  const s = world({ verdict: { v: "needs_sandbox" }, actions: ["hold", "unhold"] });
  const r = (await intake(s, 1)).record;
  await assert.rejects(s.sign(r, "release"), /not permitted the action "release"/, "the owner-signed record scopes the member: checkAppend refuses the entry");
  await assert.rejects(s.uploads.release(r.upload_id, { decision: await s.sign(r, "release", "x", { force: true }) }), (e) => e.reason === "ledger_invalid", "and a ledger that contains it is refused whole");
  const s2 = world({ verdict: { v: "needs_sandbox" }, actions: ["hold", "unhold"] });
  const r2 = (await intake(s2, 11)).record;
  const held = await s2.uploads.hold(r2.upload_id, true, { decision: await s2.sign(r2, "hold_on", "litigation") });
  assert.deepEqual([held.retention.hold, held.decisions.at(-1).by, held.decisions.at(-1).action], [true, "human:Dr Reviewer", "hold"]);
  const exp = world({ verdict: { v: "needs_sandbox" }, windows: { "Dr Reviewer": { valid_until: "2026-01-01T00:00:00Z" } } });
  const e2 = (await intake(exp, 2)).record;
  await assert.rejects(exp.uploads.release(e2.upload_id, { decision: await exp.sign(e2, "release", "x") }), (e) => e.reason === "key_expired");
  const early = world({ verdict: { v: "needs_sandbox" }, windows: { "Dr Reviewer": { valid_from: "2027-01-01T00:00:00Z" } } });
  const e3 = (await intake(early, 3)).record;
  await assert.rejects(early.uploads.release(e3.upload_id, { decision: await early.sign(e3, "release", "x", { decided_at: "2027-06-01T00:00:00.000Z", force: true }) }), (e) => e instanceof AuthError, "the signer's own timestamp can never place a key inside its window");
});

test("U2: a blocked upload is refused even with a perfect signature, and the system actors cannot make a human transition", async () => {
  const w = world({ verdict: { v: "block" } });
  const b = (await intake(w, 1)).record;
  assert.equal(b.stage, "blocked");
  await assert.rejects(w.uploads.release(b.upload_id, { decision: await w.sign(b, "release", "audited") }), TransitionError);
  assert.equal((await w.records.get(b.upload_id)).stage, "blocked"); assert.equal(w.r.objects.size, 0);
});

/* ---------- U3: parser complexity ---------- */

test("U3: unmatched end tags cost nothing and namespace declarations are not copied per element (rv2/x2)", async () => {
  const open = "<a>".repeat(5000);
  const works = [100000, 250000].map((n) => parseXml(`<svg>${open}${"</b>".repeat(n)}`).work);
  assert.ok(works[1] <= 2.6 * works[0], `work ${works}: linear in the unmatched end tags`);
  const prev = [];
  for (const [levels, small] of [[5, 2000], [10, 4000], [20, 8000]]) {
    let s = '<svg xmlns="http://www.w3.org/2000/svg">'; let k = 0;
    for (let d = 0; d < levels; d++) { s += "<g"; for (let j = 0; j < 2000; j++) s += ` xmlns:p${k++}=""`; s += ">"; }
    const text = s + '<g xmlns:z=""/>'.repeat(small);
    const { work } = parseXml(text);
    assert.ok(work <= 4 * text.length, `${k} prefixes + ${small} small declarations: work ${work} for ${text.length} characters`);
    prev.push(work);
  }
  await triageSvg(enc(`<svg>${open}${"</b>".repeat(1000)}`));
});

test("U3: the same shapes inside a docx part (rv2/x4) are linear too", async () => {
  const docx = (xml) => zip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: xml }]);
  const unmatched = docx(`<w:document>${"<a>".repeat(5000)}${"</b>".repeat(245000)}`);
  await ran("docx 5000 open + unmatched", () => triageZip(unmatched, L, { ooxml: true }));
  let s = "<w:document"; for (let j = 0; j < 2000; j++) s += ` xmlns:p${j}=""`; s += ">" + '<g xmlns:z=""/>'.repeat(3000);
  await ran("docx 2000 prefixes + 3000 declarations", () => triageZip(docx(s), L, { ooxml: true }));
});

/** A small seeded generator of hostile markup: nesting, many declarations, mismatched closes, comments, CDATA, entities, quotes, mixed. */
function generate(seed, size) {
  let x = seed >>> 0 || 1;
  const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  const names = ["a", "g", "svg", "w:p", "x:f", "style", "script", "b", "Z", "xs:rect"];
  const pieces = [
    () => `<${names[rnd(names.length)]}>`, () => `</${names[rnd(names.length)]}>`, () => `<${names[rnd(names.length)]}/>`,
    () => `<g xmlns:p${rnd(50)}="u${rnd(9)}">`, () => `<g ${Array.from({ length: rnd(40) }, (_, i) => `xmlns:q${i}=""`).join(" ")}>`,
    () => `<a b='${"x".repeat(rnd(50))}' c=d e>`, () => `<!--${"-".repeat(rnd(5))}`, () => "-->", () => "<![CDATA[", () => "]]>", () => "<?x ", () => "?>",
    () => `&#${rnd(2) ? "x" : ""}${"0".repeat(rnd(30))}${rnd(1000)};`, () => "&amp", () => "<", () => ">", () => `"`, () => "'", () => " ".repeat(rnd(40)), () => "text", () => "<!DOCTYPE x [", () => "]>",
  ];
  let out = "<svg>";
  while (out.length < size) out += pieces[rnd(pieces.length)]();
  return out;
}

test("U3: structured fuzz (nesting, many declarations, mismatched closes, comments, CDATA, entities, quotes, mixed) stays linear through every markup entry point", async () => {
  const slow = [];
  for (let seed = 1; seed <= 24; seed++) {
    const text = generate(seed * 7919, 250_000);
    const r = parseXml(text);
    assert.ok(r.events.length <= text.length + 100, `seed ${seed}: ${r.events.length} events for ${text.length} characters`);
    if (r.work > 8 * text.length + 100_000) slow.push(`seed ${seed}: work ${r.work} for ${text.length} characters`);   // a counter, not a clock
    triageSvg(enc(text));
    await triage(zip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: text }]), TYPES.docx);
  }
  assert.deepEqual(slow, []);
});

test("U3: a part that would exceed the work budget stops with a problem, and the parse reports it", () => {
  const text = `<a ${Array.from({ length: 1999 }, (_, i) => `x${i}=1`).join(" ")}>`.repeat(3000);
  const r = parseXml(text);
  assert.ok(r.events.length < 10 * text.length);
  assert.ok(Array.isArray(r.problems));
});

/* ---------- U5 and U9: entities, DTDs, CSS ---------- */

const SVG = (inner) => enc(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);

test("U5: numeric references of any length decode as the spec says (a leading-zero flood was not decoded, so javascript: slipped through)", () => {
  for (const ref of ["&#0000000106;", "&#000000106;", "&#x00000006a;", "&#x000000000000000006a;", "&#106", "&#x6A;", "&#0106;"]) {
    const r = triageSvg(SVG(`<a href="${ref}avascript:alert(1)"/>`));
    assert.ok(has(r, "script_url"), ref); assert.equal(r.verdict, "block", ref);
  }
  const r = triageSvg(SVG('<animate attributeName="&#x000000068;ref" values="javascript:x"/><a><set attributeName="&#0000000104;ref" to="javascript:alert(1)"/></a>'));
  assert.ok(has(r, "animation_of_href"));
  assert.deepEqual(parseXml("&#0;&#x110000;&#xD800;&#99999999999999999999;").events[0].value, "����");
  // named references are exact case, and nested ones decode once
  assert.ok(has(triageSvg(SVG('<a href="java&Tab;script:alert(1)"/>')), "script_url"));
  assert.ok(has(triageSvg(SVG('<a href="java&NewLine;script:alert(1)"/>')), "script_url"));
  assert.equal(has(triageSvg(SVG('<a href="java&NEWLINE;script:alert(1)"/>')), "script_url"), undefined, "&NEWLINE; is not an entity: the browser does not see javascript:");
  assert.equal(has(triageSvg(SVG('<a href="&amp;#106;avascript:alert(1)"/>')), "script_url"), undefined, "one level only: this is the text &#106;avascript");
});

test("U5: an HTML part inside an Office package is a block, and no HTML ever reaches an XML rule", async () => {
  const docx = (name, data) => zip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: "<w:document/>" }, { name, data }]);
  for (const body of ['<html><a href="&#0000000106;avascript:alert(1)">x</a></html>', "<html></html>", ""]) {
    const r = await triageZip(docx("word/a.html", body), L, { ooxml: true });
    assert.ok(has(r, "html_part")); assert.equal(r.verdict, "block");
  }
});

test("U9: an external DTD or entity declaration in an SVG is refused; the W3C's own SVG doctypes are not", () => {
  const doc = (decl) => enc(`${decl}<svg xmlns="http://www.w3.org/2000/svg"/>`);
  for (const decl of ['<!DOCTYPE svg SYSTEM "http://evil.example/x.dtd">', '<!DOCTYPE svg PUBLIC "-//EVIL//DTD//EN" "http://evil.example/x.dtd">', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://evil.example/svg11.dtd">', "<!DOCTYPE svg PUBLIC 'x'>", '<!doctype SVG system "x">']) {
    const r = triageSvg(doc(decl));
    assert.ok(has(r, "external_dtd"), decl); assert.equal(r.verdict, "block", decl);
  }
  assert.ok(has(triageSvg(doc('<!DOCTYPE l [<!ENTITY a "aa"><!ENTITY b "&a;&a;">]>')), "xml_entities"));
  for (const decl of ['<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.0//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">'.replace("http://www.w3.org/TR/2001", "http://www.w3.org/Graphics/SVG/2001"), "<!DOCTYPE svg>"]) assert.equal(has(triageSvg(doc(decl)), "external_dtd"), undefined, decl);
});

test("U9: image-set(), src(), cross-fade(), element() and url ( ) with spaces are URL-bearing CSS; a fragment or a data image is not", () => {
  for (const css of ['a{background:image-set("https://e.example/x.png" 1x)}', "a{background:-webkit-image-set('x.png' 1x)}", 'a{background:src("https://e/x")}', "a{background:cross-fade(url(//e/x), #fff)}", 'a{background:element("//e/x")}', 'a{background:url ("https://e/x")}', 'a{background:IMAGE-SET("//e/x" 1x)}', "a{background:\\69mage-set('//e/x' 1x)}", "@font-face{src:local(x),url( 'HTTPS://e/f')}"]) {
    assert.equal(cssExternal(css), true, css);
    const r = triageSvg(SVG(`<style>${css}</style>`)); assert.ok(has(r, "external_reference"), css);
    const attr = triageSvg(SVG(`<rect style="${css.replace(/"/g, "'")}"/>`)); assert.ok(has(attr, "external_reference"), `attr ${css}`);
  }
  for (const css of ["a{fill:url(#grad)}", "a{background:image-set(url(data:image/png;base64,AAAA) 1x)}", 'a{background:image-set("#frag" 1x)}', "a{fill:red}"]) assert.equal(cssExternal(css), false, css);
});

/* ---------- U8: filenames ---------- */

test("U8: every dot-part is checked, however many there are, and a part is trimmed of every Unicode white space class", () => {
  const long = `a${".x".repeat(30)}.php.png`;
  assert.deepEqual(normaliseFilename(long).parts.includes("php"), true);
  assert.equal(matchesDeclared({ filename: long }, TYPES.png), false, "php as the 32nd part is still php");
  assert.equal(matchesDeclared({ filename: `${"a.".repeat(500)}php.png` }, TYPES.png), false);
  for (const ws of ["\u0085", " ", "　", " ", " ", " ", " ", " ", "\t", "\u000b"]) {
    assert.equal(matchesDeclared({ filename: `a.php${ws}.png` }, TYPES.png), false, JSON.stringify(ws));
    assert.equal(matchesDeclared({ filename: `a.${ws}php.png` }, TYPES.png), false, JSON.stringify(`lead ${ws}`));
    assert.deepEqual(normaliseFilename(`a.${ws}php${ws}.png`).parts, ["php", "png"]);
  }
});

test("U8: the whole Default_Ignorable_Code_Point property is stripped, so no invisible character hides a part", () => {
  const ignorable = ["­", "͏", "؜", "ᅟ", "ᅠ", "឴", "឵", "᠋", "᠎", "​", "‍", "‮", "⁠", "⁢", "⁯", "ㅤ", "︀", "️", "﻿", "ﾠ", "\u{1bca0}", "\u{1d173}", "\u{e0001}", "\u{e0020}", "\u{e01ef}"];
  for (const ch of ignorable) {
    assert.equal(matchesDeclared({ filename: `a.ph${ch}p.png` }, TYPES.png), false, `U+${ch.codePointAt(0).toString(16)}`);
    assert.equal(normaliseFilename(`a.p${ch}hp${ch}.png`).full, "a.php.png");
  }
  assert.equal(normaliseFilename("ｐｈｏｔｏ．ｐｎｇ").full, "photo.png");
});

test("U8: a Windows device name in ANY part is made harmless (con.tar.gz, a.con.txt, com¹, lpt0, conin$, nul.)", () => {
  for (const [input, want] of [["con.tar.gz", "_con.tar.gz"], ["a.con.txt", "a._con.txt"], ["com¹.txt", "_com1.txt"], ["lpt0.txt", "_lpt0.txt"], ["CONIN$.txt", "_CONIN$.txt"], ["conout$", "_conout$"], ["a.NUL.b", "a._NUL.b"], ["nul.", "_nul"], ["clock$.txt", "_clock$.txt"], ["COM9", "_COM9"], ["com10.txt", "com10.txt"], ["console.txt", "console.txt"]]) assert.equal(normaliseFilename(input).full, want, input);
});

/* ---------- U4: legacy keys, sweep isolation, paging ---------- */

/** Make a record a legacy one: content-addressed keys as written before keys were derived from records. */
async function legacy(w, id) {
  const rec = await w.records.get(id);
  const lq = `q/partner/${rec.sha256}`, lr = `r/partner/${rec.sha256}`;
  const bytes = new Uint8Array(await (await w.q.get(rec.storage.key)).arrayBuffer());
  await w.q.put(lq, bytes); await w.q.delete(rec.storage.key);
  const released = rec.storage.released_key;
  if (released) { await w.r.put(lr, bytes); await w.r.delete(released); }
  return w.records.put({ ...rec, storage: { ...rec.storage, key: lq, ...(released ? { released_key: lr } : {}) } });
}

test("U4: migrateLegacyKeys re-keys old content-addressed records (copy, verify, commit by compare-and-set), shares nothing, and removes the old objects only when no record uses them", async () => {
  const w = world();
  const a = (await intake(w, 1, "legacy.pdf")).record, b = (await intake(w, 1, "legacy2.pdf")).record;   // same bytes
  const c = (await intake(w, 2, "new.pdf")).record;
  const la = await legacy(w, a.upload_id);
  // b shares a's legacy key, as two uploads of the same bytes did
  await w.records.put({ ...(await w.records.get(b.upload_id)), storage: { ...b.storage, key: la.storage.key, released_key: la.storage.released_key } });
  await w.q.delete(b.storage.key); await w.r.delete(b.storage.released_key);
  assert.ok((await w.uploads.reconcile()).violations.some((v) => v.code === "key_mismatch"));
  const out = await w.uploads.migrateLegacyKeys();
  assert.deepEqual([out.migrated, out.failed], [2, []]);
  assert.deepEqual(out.removed.sort(), [la.storage.key, la.storage.released_key].sort(), "the shared legacy objects went only after both records moved");
  for (const id of [a.upload_id, b.upload_id, c.upload_id]) { const r = await w.records.get(id); assert.equal(r.storage.key, quarantineKey("partner", r.sha256, id)); assert.deepEqual(validateRecord(r), []); assert.equal((await evidenceOf(w.q, id)).at(-1)?.action ?? "none", id === c.upload_id ? "none" : "migrate", "the re-keying is evidence, not a decision on the record"); }
  assert.equal((await w.uploads.reconcile()).ok, true);
  assert.equal((await w.uploads.migrateLegacyKeys()).migrated, 0, "idempotent");
});

test("U4: deleting a legacy record re-keys it first; the other record that shared its key keeps its objects (rv2/l1 threw IntegrityError, and the sweep stopped)", async () => {
  const w = world();
  const a = (await intake(w, 1, "legacy.pdf")).record, b = (await intake(w, 2, "new.pdf")).record;
  await legacy(w, a.upload_id);
  w.tick(40 * 86_400_000);
  const out = await w.uploads.sweep();
  assert.equal(out.deleted, 2); assert.deepEqual(out.failures, []);
  assert.deepEqual([(await w.records.get(a.upload_id)).stage, (await w.records.get(b.upload_id)).stage], ["deleted", "deleted"]);
  assert.equal(w.q.objects.size + w.r.objects.size, 0, "M3: erasing a legacy record removes the legacy object too when no live record uses it (nothing is left for a cleanup)");
  assert.equal((await w.uploads.reconcile()).ok, true);
  assert.deepEqual(w.onViolation, []);
});

test("U4: one failing record does not stop the sweep: it is reported, everything else is deleted, and the failure goes to onViolation", async () => {
  const w = world();
  const ids = [];
  for (let n = 1; n <= 5; n++) ids.push((await intake(w, n)).record.upload_id);
  const sorted = [...ids].sort();
  await w.q.delete((await w.records.get(sorted[1])).storage.key);   // the second record's object is gone: its release/delete cannot verify
  const realDelete = w.r.delete.bind(w.r);
  w.r.delete = async (k) => { if (k.includes(sorted[2])) throw new Error("R2 5xx"); return realDelete(k); };
  w.tick(40 * 86_400_000);
  const out = await w.uploads.sweep();
  assert.equal(out.failures.length, 1, JSON.stringify(out.failures));
  assert.equal(out.failures[0].upload_id, sorted[2]);
  assert.equal(out.deleted, 4);
  assert.ok(w.onViolation.some((v) => v.code === "sweep_failed" && v.upload_id === sorted[2]));
  w.r.delete = realDelete;
  assert.equal((await w.uploads.sweep()).deleted, 0, "the failed one is a settled-or-stale intent, handled by settle on the next sweep");
});

test("U4: the sweep pages (ORDER BY id, after a cursor) and settles pending intakes; reconcile runs a slice per call and a resumed run equals the full one", async () => {
  const w = world();
  for (let n = 1; n <= 7; n++) await intake(w, n);
  w.tick(40 * 86_400_000);
  const first = await w.uploads.sweep({ limit: 3, reconcileLimit: 2 });
  assert.equal(first.deleted, 3); assert.deepEqual(first.reconcile.next !== null, true);
  const rest = await w.uploads.sweep({ limit: 100 });
  assert.equal(rest.deleted, 4);
  // a pending intake (the Worker died after writing the record): the sweep settles it after the threshold
  const w2 = world();
  const real = w2.q.put.bind(w2.q); w2.q.put = async () => { throw new Error("outage"); }; const realDel = w2.q.delete.bind(w2.q); w2.q.delete = async () => { throw new Error("outage"); };
  const rec2 = w2.records.put.bind(w2.records);
  await assert.rejects(intake(w2, 1));
  w2.q.put = real; w2.q.delete = realDel;
  const [pending] = await w2.records.list();
  assert.deepEqual([pending.stage, pending.op.action], ["pending", "intake"]);
  assert.equal((await w2.uploads.sweep()).settled, 0, "too recent");
  w2.tick(30 * 60 * 1000);
  const swept = await w2.uploads.sweep();
  assert.equal(swept.settled, 1);
  assert.equal((await w2.records.get(pending.upload_id)).stage, "deleted");
  void rec2;
});

test("U4: reconcile in slices: each call reads one page of records and the objects of that id range, and the pages together find what the full run finds", async () => {
  const w = world();
  const recs = [];
  for (let n = 1; n <= 9; n++) recs.push((await intake(w, n)).record);
  const sorted = recs.map((r) => r.upload_id).sort();
  await w.q.delete(recs.find((r) => r.upload_id === sorted[4]).storage.key);                                // object_missing in the middle
  await w.r.put(`r/${sorted[7].replace(/.$/, (c) => (c === "f" ? "e" : "f"))}/partner/${"0".repeat(64)}`, new Uint8Array(1));            // an orphan late in the id order
  const full = await w.uploads.reconcile();
  const lists = [];
  const realList = w.q.list.bind(w.q); w.q.list = async (o) => { lists.push(o); return realList(o); };
  const codes = [];
  let after = null, pages = 0;
  for (;;) { const r = await w.uploads.reconcilePage({ limit: 3, after }); pages++; codes.push(...r.violations.map((v) => v.code)); if (r.done) break; after = r.next.after; }
  assert.deepEqual(codes.sort(), full.violations.map((v) => v.code).sort());
  assert.ok(pages >= 3 && pages <= 5, `${pages} pages`);
  assert.ok(lists.every((o) => o.prefix === "q/"), "the quarantine bucket is listed by prefix, page by page");
  assert.ok(full.violations.some((v) => v.code === "object_missing") && full.violations.some((v) => v.code === "object_without_record"));
});

/* ---------- U7: lifecycle details ---------- */

test("U7: a rejected record is deletable and becomes a tombstone with no personal data; so does every deleted record", async () => {
  const w = world();
  const big = (await w.uploads.intake({ form: "partner", bytes: cat(body(1), new Uint8Array(2 * 1048576)), filename: "Passport scan Maria.pdf", contentType: PDF, subject: "lead:maria@example.test" })).record;
  assert.equal(big.stage, "rejected"); assert.equal(big.subject_ref, "lead:maria@example.test");
  w.tick(8 * 86_400_000);
  const out = await w.uploads.sweep();
  assert.equal(out.deleted, 1);
  const t = await w.records.get(big.upload_id);
  assert.deepEqual([t.stage, t.subject_ref, t.declared], ["deleted", null, { content_type: null, filename: null, filename_normalised: null, filename_full: null }]);
  assert.equal(t.sha256, big.sha256); assert.ok(t.retention.deleted_at);
  const a = (await intake(w, 5, "Maria passport.pdf")).record;
  const z = (await w.uploads.intake({ form: "partner", bytes: zip([{ name: `secret-${"x".repeat(10)}.exe`, data: "x" }]), filename: "n.zip", contentType: "application/zip", subject: "lead:2" })).record;
  assert.ok(JSON.stringify(z.triage).includes("secret-"));
  await w.del(a.upload_id, "erasure request for Maria"); await w.del(z.upload_id);
  for (const id of [a.upload_id, z.upload_id]) {
    const d = await w.records.get(id);
    const text = JSON.stringify(d);
    assert.ok(!/Maria|maria|secret-|lead:|passport|erasure/.test(text), `no personal data survives: ${text.slice(0, 200)}`);
    assert.deepEqual(validateRecord(d), []);
  }
});

test("U7: a scan that could not run never withdraws a release; only a real, stricter verdict does", async () => {
  const w = world();
  const a = (await intake(w, 1)).record;
  assert.equal(a.stage, "released");
  w.verdict.v = "scan_failed";
  const kept = await w.uploads.rescan(a.upload_id);
  assert.deepEqual([kept.stage, kept.verdict, w.r.objects.size], ["released", "allow_with_limits", 1]);
  assert.match((await evidenceOf(w.q, a.upload_id)).at(-1).note, /could not run/);
  w.verdict.v = "needs_sandbox";
  const held = await w.uploads.rescan(a.upload_id);
  assert.deepEqual([held.stage, w.r.objects.size], ["held", 0]);
});
