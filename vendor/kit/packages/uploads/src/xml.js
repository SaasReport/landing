/**
 * ONE linear tokenizer for every markup format the pipeline reads: SVG, the XML parts of Office Open XML, and the HTML parts that
 * Office packages can carry. It does, once and before any rule sees a name:
 *   - entity decoding (named: amp lt gt quot apos colon Tab NewLine; numeric, decimal and hex, with or without the semicolon),
 *     one level, as a parser does: "&amp;#112;" is "&#112;", "&#112;" is "p";
 *   - CDATA sections become text, comments are dropped, processing instructions and declarations are their own events;
 *   - namespace resolution: every element and attribute has { prefix, local, ns } from the xmlns declarations in scope, so a rule
 *     matches on the LOCAL name and never trusts a prefix ("s:script" and "x:foreignObject" are script and foreignObject);
 *   - quoting: an attribute value is { value (decoded), quoted }.
 * It is lenient the way browsers are (unquoted values, "/" between attributes, spaces after "<") because a rule that sees less
 * than a browser sees can be evaded. Whatever it cannot close (a quote, a comment, a CDATA section, a tag, a declaration, a
 * processing instruction) is reported in `problems` and the rest of the text is still read.
 * No regular expressions; every loop advances, so the cost is linear in the text.
 *
 *   parseXml(text, { budgetFactor }) → { events, problems, work }     work: the counter the budget (budgetFactor × length + 100 000) stops at
 *     { t: "start", name, attrs, index, selfClosing } | { t: "end", name } | { t: "text", value, cdata } | { t: "pi", target, data }
 *     | { t: "decl", value, internalSubset, entity }
 *   name / attribute: { raw, prefix, local (lower case), ns, ... }; attribute also { value, quoted }
 */
import { isSpace, isAlpha, isNameChar, isHex, isDigit, skipSpace, runWhile, startsWithCI } from "./lex.js";
import { tick } from "./work.js";

export const NS = Object.freeze({ svg: "http://www.w3.org/2000/svg", xlink: "http://www.w3.org/1999/xlink", xhtml: "http://www.w3.org/1999/xhtml", xml: "http://www.w3.org/XML/1998/namespace", xmlns: "http://www.w3.org/2000/xmlns/" });

/** The named character references that matter, exact case as HTML5 spells them ("&Tab;" and "&NewLine;" are, "&TAB;" is not). */
const NAMED = { amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'", colon: ":", Tab: "\t", NewLine: "\n" };

/**
 * One level of entity decoding, as the HTML5 spec has it: a numeric reference takes ANY number of digits (&#0000000106; is "j"),
 * with or without the semicolon; a value of 0, past U+10FFFF or a surrogate is U+FFFD; a named reference needs its semicolon.
 */
export function decodeEntities(s) {
  let at = s.indexOf("&");
  if (at < 0) return s;
  const out = [];
  let from = 0;
  while (at >= 0) {
    out.push(s.slice(from, at));
    let i = at + 1, rep = null, end = at;
    if (s.charCodeAt(i) === 35) {   // &#
      i++;
      const hex = s.charCodeAt(i) === 120 || s.charCodeAt(i) === 88;
      if (hex) i++;
      const stop = runWhile(s, i, hex ? isHex : isDigit);
      if (stop > i) {
        let cp = 0;
        for (let k = i; k < stop && cp <= 0x10ffff; k++) { const c = s.charCodeAt(k); cp = cp * (hex ? 16 : 10) + (c <= 57 ? c - 48 : (c | 32) - 87); }   // saturates: the digits are never counted twice
        rep = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\ufffd" : String.fromCodePoint(cp);
        end = s.charCodeAt(stop) === 59 ? stop + 1 : stop;
      }
    } else {
      const stop = runWhile(s, i, isAlpha);
      if (stop > i && stop - i <= 8 && s.charCodeAt(stop) === 59) {
        const v = NAMED[s.slice(i, stop)];
        if (v !== undefined) { rep = v; end = stop + 1; }
      }
    }
    if (rep === null) { out.push("&"); from = at + 1; } else { out.push(rep); from = end; }
    at = s.indexOf("&", from);
  }
  out.push(s.slice(from));
  return out.join("");
}

const MAX_ATTRS = 2000, MAX_DEPTH = 5000;
const isNameStart = (c) => isAlpha(c) || c === 95 || c > 127;

/** Resolve a name against the namespace bindings in force: bindings maps a prefix to the stack of its values (the innermost last). */
function qname(raw, bindings, isAttr) {
  const colon = raw.indexOf(":");
  const prefix = colon > 0 ? raw.slice(0, colon) : "";
  const local = (colon > 0 ? raw.slice(colon + 1) : raw).toLowerCase();
  let ns = null, unbound = false;
  if (raw === "xmlns" || prefix === "xmlns") ns = NS.xmlns;
  else if (prefix === "xml") ns = NS.xml;
  else if (prefix) { ns = bindings.get(prefix)?.at(-1) ?? null; unbound = ns === null; }
  else if (!isAttr) ns = bindings.get("")?.at(-1) ?? null;
  return { raw, prefix, local, ns, unbound };
}

export function parseXml(text, { budgetFactor = 8 } = {}) {
  const events = [], problems = [];
  const n = text.length;
  // Open elements, their counts by local name, and the namespace bindings in force. Every structure is updated in O(1) amortised: an end
  // tag asks the count first (an unmatched one costs nothing), a matching one pops the frames above its element (each frame pops once),
  // and a binding is pushed on declaration and popped with its element, so a lookup is one map read at any depth.
  const stack = [];                                  // [{ local, declared: [prefix] }]
  const open = new Map();                            // local name → how many open elements have it
  const bindings = new Map();                        // prefix → [namespace, …], innermost last
  const bind = (prefix, uri) => { const l = bindings.get(prefix); if (l) l.push(uri); else bindings.set(prefix, [uri]); };
  const unbind = (frame) => { for (const prefix of frame.declared) bindings.get(prefix).pop(); };
  let work = 0;                                      // the work done: characters searched, events, attributes and bindings. A counter, not a clock: tests assert it grows with the input, not with its square
  const budget = budgetFactor * text.length + 100_000;          // the hard stop, a small multiple of the text: reaching it is a malformed_markup problem, never a hang
  const find = (needle, from) => { const at = text.indexOf(needle, from); work += (at < 0 ? n : at) - from + 1; return at; };
  let i = 0, textFrom = 0, noCommentClose = false, noPiClose = false, ambiguousSeen = false;
  const nextEnd = { xml: -1, bang: -1 };            // cached next "-->" / "--!>" (−1: not searched since the last one was passed, −2: none left)   // a search that finds nothing is final: it must not be repeated from every later "<!--" or "<?"
  const flushText = (to) => { if (to > textFrom) events.push({ t: "text", value: decodeEntities(text.slice(textFrom, to)), cdata: false }); };

  while (i < n) {
    if (work > budget) { problems.push("markup work budget exhausted"); textFrom = n; break; }
    const lt = find("<", i);
    if (lt < 0) break;
    flushText(lt);
    textFrom = lt;
    const c1 = text.charCodeAt(lt + 1);

    if (c1 === 33) {                                 // <!
      if (text.startsWith("<!--", lt)) {
        // where a comment ENDS differs by reader: XML ends at "-->"; an HTML parser also ends at "--!>", and at once for "<!-->" and "<!--->".
        // The earliest of them closes the comment here (so nothing a browser would run is hidden from the rules), and any disagreement is a
        // problem: a file read two ways is never allowed. Each search is cached (a position, or "none"), so none is repeated from every "<!--".
        const from = lt + 4;
        let close = -1, len = 3, ambiguous = false;
        if (text.charCodeAt(from) === 62) { close = from; len = 1; ambiguous = true; }                  // <!-->
        else if (text.charCodeAt(from) === 45 && text.charCodeAt(from + 1) === 62) { close = from; len = 2; ambiguous = true; }   // <!--->
        else {
          if (nextEnd.xml !== -2 && nextEnd.xml < from) nextEnd.xml = find("-->", from);
          if (nextEnd.bang !== -2 && nextEnd.bang < from) nextEnd.bang = find("--!>", from);
          if (nextEnd.xml < 0) nextEnd.xml = -2;
          if (nextEnd.bang < 0) nextEnd.bang = -2;
          const x = nextEnd.xml === -2 ? -1 : nextEnd.xml, b = nextEnd.bang === -2 ? -1 : nextEnd.bang;
          if (b >= 0 && (x < 0 || b < x)) { close = b; len = 4; ambiguous = true; } else { close = x; len = 3; }
        }
        if (close < 0) { if (!noCommentClose) problems.push("unterminated comment"); noCommentClose = true; i = textFrom = lt + 4; continue; }   // what follows is still read as markup
        if (ambiguous && !ambiguousSeen) { ambiguousSeen = true; problems.push("ambiguous comment end (HTML and XML disagree where it closes)"); }
        i = textFrom = close + len; continue;
      }
      if (text.startsWith("<![CDATA[", lt)) {
        const close = find("]]>", lt + 9);
        if (close < 0) { problems.push("unterminated CDATA section"); events.push({ t: "text", value: text.slice(lt + 9), cdata: true }); i = textFrom = n; break; }
        events.push({ t: "text", value: text.slice(lt + 9, close), cdata: true });
        i = textFrom = close + 3; continue;
      }
      // a declaration: DOCTYPE, ENTITY, ELEMENT … up to the ">" outside quotes and an internal subset
      let j = lt + 2, depth = 0, q = 0, sub = false;
      for (; j < n; j++) {
        const c = text.charCodeAt(j);
        if (q) { if (c === q) q = 0; continue; }
        if (c === 34 || c === 39) q = c;
        else if (c === 91) { depth++; sub = true; } else if (c === 93) { if (depth) depth--; }
        else if (c === 62 && depth === 0) break;
      }
      if (j >= n) problems.push("unterminated declaration");
      const value = text.slice(lt + 2, Math.min(j, n));
      events.push({ t: "decl", value, internalSubset: sub, entity: startsWithCI(value, 0, "entity") });
      i = textFrom = Math.min(j + 1, n); continue;
    }

    if (c1 === 63) {                                 // <?
      const close = noPiClose ? -1 : find("?>", lt + 2);
      if (close < 0) { if (!noPiClose) problems.push("unterminated processing instruction"); noPiClose = true; }
      const body = text.slice(lt + 2, close < 0 ? n : close);
      const split = runWhile(body, 0, (c) => !isSpace(c));
      events.push({ t: "pi", target: body.slice(0, split).toLowerCase(), data: body.slice(split).trim() });
      i = textFrom = close < 0 ? n : close + 2; continue;
    }

    // a tag: "<", optional spaces, optional "/", optional spaces, a name
    let p = skipSpace(text, lt + 1), closing = false;
    if (text.charCodeAt(p) === 47) { closing = true; p = skipSpace(text, p + 1); }
    if (!isNameStart(text.charCodeAt(p))) { i = lt + 1; continue; }   // a literal "<": stays in the text run
    const nameEnd = runWhile(text, p, isNameChar);
    const rawName = text.slice(p, nameEnd);
    p = nameEnd;

    const attrsRaw = [];
    let selfClosing = false, ended = false;
    while (p < n) {
      p = skipSpace(text, p);
      const c = text.charCodeAt(p);
      if (p >= n) break;
      if (c === 62) { ended = true; p++; break; }
      if (c === 47) { p++; if (text.charCodeAt(skipSpace(text, p)) === 62) selfClosing = true; continue; }
      if (c === 34 || c === 39 || c === 61) { p++; continue; }
      const room = attrsRaw.length < MAX_ATTRS;   // past the cap the rest of the tag is still consumed, but not stored
      if (!room && attrsRaw.length === MAX_ATTRS) { problems.push("too many attributes in one tag"); attrsRaw.push(null); }
      const aEnd = runWhile(text, p, (d) => !isSpace(d) && d !== 61 && d !== 47 && d !== 62 && d !== 34 && d !== 39);
      const aName = text.slice(p, aEnd);
      p = skipSpace(text, aEnd);
      if (text.charCodeAt(p) !== 61) { if (room) attrsRaw.push({ raw: aName, value: "", quoted: true }); continue; }
      p = skipSpace(text, p + 1);
      const q = text.charCodeAt(p);
      if (q === 34 || q === 39) {
        const close = find(String.fromCharCode(q), p + 1);
        if (close < 0) { problems.push("unterminated attribute value"); if (room) attrsRaw.push({ raw: aName, value: decodeEntities(text.slice(p + 1)), quoted: true }); p = n; break; }
        if (room) attrsRaw.push({ raw: aName, value: decodeEntities(text.slice(p + 1, close)), quoted: true });
        p = close + 1;
      } else {
        const vEnd = runWhile(text, p, (d) => !isSpace(d) && d !== 62);
        if (room) attrsRaw.push({ raw: aName, value: decodeEntities(text.slice(p, vEnd)), quoted: false });
        p = vEnd;
      }
    }
    if (!ended) problems.push("unterminated tag");

    if (closing) {
      const local = (rawName.indexOf(":") > 0 ? rawName.slice(rawName.indexOf(":") + 1) : rawName).toLowerCase();
      const name = qname(rawName, bindings, false);
      if ((open.get(local) || 0) > 0) {
        let frame;
        do { frame = stack.pop(); open.set(frame.local, open.get(frame.local) - 1); unbind(frame); } while (frame.local !== local);
      }
      events.push({ t: "end", name });
    } else {
      const declared = [];
      for (const a of attrsRaw) {
        if (a === null) continue;
        const decl = a.raw === "xmlns" ? "" : a.raw.startsWith("xmlns:") ? a.raw.slice(6) : null;
        if (decl === null) continue;
        bind(decl, a.value); declared.push(decl); work++;
      }
      const name = qname(rawName, bindings, false);
      const attrs = [];
      for (const a of attrsRaw) { if (a === null) continue; const q = qname(a.raw, bindings, true); q.value = a.value; q.quoted = a.quoted; attrs.push(q); work++; }
      events.push({ t: "start", name, attrs, index: lt, selfClosing });
      const frame = { local: name.local, declared };
      if (selfClosing) { events.push({ t: "end", name }); unbind(frame); }
      else if (stack.length >= MAX_DEPTH) { if (stack.length === MAX_DEPTH) problems.push("elements nested too deep"); unbind(frame); }
      else { stack.push(frame); open.set(frame.local, (open.get(frame.local) || 0) + 1); }
    }
    work += 2;
    i = textFrom = Math.min(p, n);
  }
  flushText(n);
  tick(work);
  return { events, problems, work };
}

/** The text of the element that starts at events[i] (decoded text and CDATA of everything inside it). */
export function elementText(events, i) {
  let depth = 0, out = "";
  for (let k = i; k < events.length; k++) {
    const e = events[k];
    if (e.t === "start") depth++;
    else if (e.t === "end") { depth--; if (depth <= 0) break; }
    else if (e.t === "text") out += e.value;
  }
  return out;
}

/** The value of the attribute with this local name (lower case), or null. */
export function attr(start, local) {
  for (const a of start.attrs) if (a.local === local) return a.value;
  return null;
}
