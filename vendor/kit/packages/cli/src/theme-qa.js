/**
 * The rendered theme gate (docs/COLOUR.md): the authoritative contrast check of a stylesheet set. It does not read the CSS and
 * guess the cascade (there is no static pass: this is the gate); the browser computes
 * and paints what renders.
 *
 * Every selector of every rule that can change a colour (color, background*, opacity, custom properties; CSS nesting, @media,
 * @supports and @layer included) is put on a real element, in a real context, and measured:
 *
 *   - on the real pages (the pages of the built site, one per template): the selector's elements are found on the page, or built
 *     under the real ancestor the selector names, so the text sits on the surface it really sits on; a state or variant the page
 *     is not showing (:hover, :focus, :active, :focus-visible, :disabled, .is-sel, [aria-pressed=true], ...) is applied to the
 *     real element, pseudo-class states through the DevTools protocol; the arguments of :is() and :where() are built branch by branch;
 *   - for a selector no page shows (runtime-built markup, a variant no page uses, a menu closed on the page: display forced on), as
 *     a synthetic chain in a neutral page (a modifier brings its block, an element sits in its block). Its context is unknown, so it
 *     must read on the page background, or its entry in canon.allow.json declares the surface it is used on (`on`) or the container
 *     it sits in (`in`), and then it is measured there.
 *
 * What is measured is decided from the DOM and the pixels, never from a tag or from the way an ancestor is walked:
 *   - text: every non-empty text node of the subject, and of a visible descendant that inherits the subject's colour, is a pair
 *     (span, div, i, b and em included; aria-hidden does not make low contrast acceptable); a pair's colour is the computed
 *     colour of the text, or, for text painted by a clipped gradient (background-clip:text with a transparent fill), the gradient
 *     itself, sampled from a screenshot;
 *   - background: the pixels behind the text lines, from a screenshot taken with all text hidden, so a ::before or ::after panel, a
 *     positioned sibling, an image, a gradient or a filter is in it; the ancestors' composited colours are the cross-check (a
 *     disagreement is reported with the problem);
 *   - the pair fails under 4.5:1 (3:1 for large text, from the computed font size and weight). Whatever the cascade, the
 *     inheritance, the fallback of a var(), a state or the colour syntax (named, hsl, oklch, color-mix, currentColor) does, the
 *     number is what the browser painted.
 *
 * Schemes: light, and dark where the CSS has one. The dark pass emulates prefers-color-scheme AND applies the hook the CSS reacts to
 * on <html> or <body> ([data-theme=dark], .dark, ...); a hook that changes no colour is itself a failure ("dark hook not exercised").
 * Viewports: the widest measures every selector; every other one (those asked for and the breakpoints of the media rules) the
 * selectors a width media rule can change.
 *
 * Tones: an element that reads the tone custom properties (--c, --on-c) without setting them is measured on every fill role (the
 * registry of @saasreport/core/colour) with --c and its derived --on-c set on its parent, the way the terminal, the notifications and
 * the directory set them; an element that sets --c itself is measured as it is, so a --c set without its --on-c falls back to the
 * rule's fallback colour and is judged on it.
 *
 * There are no built-in waivers: a disabled control, a placeholder, a selection or a translucent chip is measured like any other
 * pair, and a selector that cannot be built or measured (an unsupported pseudo-class, :visited, an unbuildable :nth-child(of S)) is a
 * failure with the state "not measured". An exception is one canon.allow.json entry (category "contrast": file = the sheet's exact
 * path, match = the selector exactly as reported, context = the state label exactly ("base", ":hover", "::before", "not measured",
 * optionally followed by " tone:<role>"), reason; optionally `on` = the surface role or `in` = the container the selector is used
 * on); an entry that excuses nothing is stale and fails. Only a shape that carries no text at all (a real element with no text
 * node, a pseudo-element without content) is no pair.
 *
 * The background is ALWAYS read from pixels (no shortcut for a "plain" case: a child panel, an outline, a filter or a content image would defeat any list of what paints).
 *
 *   themeQa({ sheets: [{ file, text }], playwright, chromium, pages?: [url], allow?, schemes?, viewports? })
 *     → { problems: [{ kind, file, line, selector, state, tone, where, scheme, viewports, fg, bg, ratio, need, note }], stale, unbuilt, skipped, placed, placedSelectors, notes }
 */
import { decodePng } from "./visual-qa.js";
import { launchGuarded, faultsSince, faultMessage } from "./browser-guard.js";

import postcss from "postcss";
/**
 * Where each selector is written, for reporting only (the browser measures; the CSSOM has no line numbers): [{ selector, line }] of
 * every style rule of a stylesheet, from postcss's source positions. A nested rule is reported as written (`.b`) and resolved
 * against its parents (`.a .b`, or `&` replaced by the parent). Keyframe steps are not selectors. A stylesheet postcss cannot
 * parse throws (a gate never skips what it cannot read).
 */
export function selectorLines(css, file = "stylesheet") {
  const out = [];
  const resolve = (parents, sel) => parents.flatMap((p) => (sel.includes("&") ? [sel.replaceAll("&", p)] : [`${p} ${sel}`]));
  const walk = (node, parents) => {
    node.each((n) => {
      if (n.type === "atrule") { if (/keyframes$/i.test(n.name)) return; if (n.nodes) walk(n, parents); return; }
      if (n.type !== "rule") return;
      const own = n.selectors.map((x) => x.replace(/\s+/g, " ").trim());
      const line = n.source.start.line;
      out.push({ selector: n.selector.replace(/\s+/g, " ").trim(), line });
      const resolved = parents.length ? own.flatMap((x) => resolve(parents, x)) : own;
      if (parents.length) for (const r of resolved) out.push({ selector: r, line });
      walk(n, resolved);
    });
  };
  walk(postcss.parse(css, { from: file }), []);
  return out;
}
import { FILL_ROLES, SURFACE_ROLES, contrast } from "@saasreport/core/colour";

/** The fills a text sits on and the surfaces a declared selector is used on: the one registry (@saasreport/core/colour), never a list of its own. */
export const FILLS = FILL_ROLES;
export const SURFACES = SURFACE_ROLES;
const kebab = (n) => n.replace(/[A-Z0-9]+/g, (m, i) => (i ? "-" : "") + m.toLowerCase());

/* ----------------------------------------------------------------------------------------------------------------------
 * `program` runs inside the page: it is serialised, so it has no outer references.
 * -------------------------------------------------------------------------------------------------------------------- */
function program() {
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const FORCE = new Set(["hover", "focus", "focus-visible", "active", "focus-within", "target"]);
  const CARRIER = new Set(["a", "button", "label", "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "dt", "dd", "summary", "legend", "caption", "figcaption", "blockquote", "code", "pre", "small", "strong", "input", "textarea", "select", "option", "output", "kbd", "mark", "time", "cite", "q", "abbr"]);   // elements that exist to carry text: never a shape
  const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "label", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var"]);

  // ---- selector parsing: a complex selector → [{ comb, c: { tag, id, classes, attrs, pseudos, pe, src } }]
  function parseComplex(sel) {
    const parts = []; let i = 0, comb = " ";
    const n = sel.length;
    while (i < n) {
      while (i < n && /\s/.test(sel[i])) i++;
      if (i >= n) break;
      if (">+~".includes(sel[i])) { comb = sel[i]; i++; continue; }
      const c = { tag: "", id: "", classes: [], attrs: [], pseudos: [], pe: "", src: "" };
      const start = i;
      while (i < n && !/[\s>+~]/.test(sel[i])) {
        const ch = sel[i];
        if (ch === "[") { let j = i, d = 0, q = ""; for (; j < n; j++) { const x = sel[j]; if (q) { if (x === q) q = ""; continue; } if (x === '"' || x === "'") q = x; else if (x === "[") d++; else if (x === "]" && --d === 0) break; } c.attrs.push(sel.slice(i + 1, j)); i = j + 1; }
        else if (ch === ".") { const m = /^\.((?:\\.|[\w-])+)/.exec(sel.slice(i)); if (!m) return null; c.classes.push(m[1].replace(/\\/g, "")); i += m[0].length; }
        else if (ch === "#") { const m = /^#((?:\\.|[\w-])+)/.exec(sel.slice(i)); if (!m) return null; c.id = m[1].replace(/\\/g, ""); i += m[0].length; }
        else if (ch === ":") {
          const dbl = sel[i + 1] === ":";
          const m = /^::?([\w-]+)/.exec(sel.slice(i)); if (!m) return null;
          let j = i + m[0].length, args = null;
          if (sel[j] === "(") { let d = 0, q = ""; let k = j; for (; k < n; k++) { const x = sel[k]; if (q) { if (x === q) q = ""; continue; } if (x === '"' || x === "'") q = x; else if (x === "(") d++; else if (x === ")" && --d === 0) break; } args = sel.slice(j + 1, k); j = k + 1; }
          if (dbl || ["before", "after", "first-line", "first-letter"].includes(m[1])) c.pe = m[1]; else c.pseudos.push({ name: m[1], args });
          i = j;
        }
        else if (ch === "*") { i++; }
        else { const m = /^(?:\\.|[\w-])+/.exec(sel.slice(i)); if (!m) return null; c.tag = m[0].toLowerCase(); i += m[0].length; }
      }
      c.src = sel.slice(start, i);
      parts.push({ comb, c }); comb = " ";
    }
    return parts;
  }
  const STRIP_PE = /::?(before|after|placeholder|selection|marker|first-line|first-letter)\b/g;
  // Remove protocol-forceable pseudo classes for DOM validation, never matching their
  // spelling inside an attribute string, escaped identifier or functional pseudo argument.
  // The CSS inspector forces states separately; a string replacement may falsify selectors.
  function withoutForcedPseudo(src) {
    let result = "", quoted = "", brackets = 0, parens = 0;
    for (let i = 0; i < src.length;) {
      const c = src[i];
      if (c === String.fromCharCode(92)) { result += src.slice(i, i + 2); i += 2; continue; }
      if (quoted) { result += c; if (c === quoted) quoted = ""; i++; continue; }
      if (c === '"' || c === "'") { result += c; quoted = c; i++; continue; }
      if (c === "[") { brackets++; result += c; i++; continue; }
      if (c === "]") { brackets = Math.max(0, brackets - 1); result += c; i++; continue; }
      if (c === "(") { parens++; result += c; i++; continue; }
      if (c === ")") { parens = Math.max(0, parens - 1); result += c; i++; continue; }
      if (c === ":" && !brackets && !parens) {
        const forced = /^:(hover|focus-visible|focus-within|focus|active|target)(?![\w-])/i.exec(src.slice(i));
        if (forced) { i += forced[0].length; continue; }
      }
      result += c; i++;
    }
    return result;
  }
  const sep = (p) => (p.comb === " " ? " " : ` ${p.comb} `);
  /** The selector text of some parts (to find the real ancestor), and the relaxed compound (tag + first class) of one (to find a real element whatever its variant). */
  const textOf = (parts) => parts.map((p, i) => (i ? sep(p) : "") + p.c.src.replace(STRIP_PE, "")).join("");
  const relaxed = (c) => ((c.tag || "") + (c.classes[0] ? "." + CSS.escape(c.classes[0]) : "")) || "*";

  // ---- every change to the page is undone
  const undoAttrs = []; const created = []; const extras = []; const touched = new Set(); let seq = 0; let clipEls = []; let heldItems = [];
  function setAttr(el, k, v) { undoAttrs.push([el, k, el.getAttribute(k)]); el.setAttribute(k, v); }
  function undo() {
    while (created.length) created.pop().remove();
    while (extras.length) extras.pop().remove();
    while (undoAttrs.length) { const [el, k, v] = undoAttrs.pop(); if (v === null) el.removeAttribute(k); else el.setAttribute(k, v); }
    for (const e of touched) { e.removeAttribute("data-qa-force"); e.removeAttribute("data-qa-fid"); e.removeAttribute("data-qa-subject"); e.removeAttribute("data-qa-tone"); e.removeAttribute("data-qa-clip"); }
    touched.clear(); clipEls = [];
    document.getElementById("qa-hide")?.remove();
  }
  /** Put the state a compound names on an element (class, id, attributes, :disabled, :checked; hover and focus are forced by the protocol). false when it cannot be built. */
  function applyState(el, c, st) {
    if (c.id && el.id !== c.id) setAttr(el, "id", c.id);
    if (c.classes.length) { const have = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean); const want = c.classes.filter((k) => !have.includes(k)); if (want.length) setAttr(el, "class", [...have, ...want].join(" ")); }
    for (const a of c.attrs) {
      const m = /^\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*(?:[is])?$/.exec(a);
      if (!m) { st.unbuilt = `attribute [${a}]`; return false; }
      const name = m[1], op = m[2], v = m[3] ?? m[4] ?? m[5] ?? "";
      if (el.getAttribute(name) === null || (op && el.getAttribute(name) !== v)) setAttr(el, name, op ? v : "");
    }
    const forces = [];
    for (const p of c.pseudos) {
      const nm = p.name.toLowerCase();
      if (FORCE.has(nm)) forces.push(nm);
      else if (nm === "disabled") setAttr(el, "disabled", "");
      else if (nm === "checked") { setAttr(el, "checked", ""); if (el.tagName === "INPUT" && !el.getAttribute("type")) setAttr(el, "type", "checkbox"); }
      else if (nm === "required") setAttr(el, "required", "");
      else if (nm === "link" || nm === "any-link") { if (el.tagName === "A" && !el.getAttribute("href")) setAttr(el, "href", "#x"); }
      else if (nm === "lang") setAttr(el, "lang", (p.args || "en").replace(/["']/g, ""));
      else if (nm === "dir") setAttr(el, "dir", (p.args || "ltr").trim());
      else if (nm === "open") setAttr(el, "open", "");
      else if (nm === "visited") { st.unbuilt = ":visited cannot be measured (the browser hides the visited colour from scripts and from the protocol)"; return false; }
      else if (["enabled", "not", "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "nth-child", "nth-of-type", "nth-last-child", "nth-last-of-type", "is", "where", "matches", "has", "empty", "root", "scope", "any", "optional", "read-write", "read-only", "valid", "invalid", "autofill", "-webkit-autofill", "placeholder-shown", "default", "indeterminate", "in-range", "out-of-range", "playing", "paused", "modal", "popover-open", "fullscreen", "defined", "host", "state"].includes(nm)) { /* position, or satisfied by default */ }
      else { st.unbuilt = `:${nm} cannot be put on an element`; return false; }
    }
    if (forces.length) { const have = (el.getAttribute("data-qa-force") || "").split(" ").filter(Boolean); el.setAttribute("data-qa-force", [...new Set([...have, ...forces])].join(" ")); touched.add(el); }
    return true;
  }
  function position(el, c, st, { siblingFollows = false } = {}) {
    for (const p of c.pseudos) {
      const nm = p.name.toLowerCase();
      // Negated structural selectors need DOM siblings, not just an attribute on the subject.
      // In the neutral harness an element starts as its parent's sole child; on real pages a
      // relaxed subject may be first/last even though the rule addresses another row.
      // Add disposable, unstyled siblings only when needed so the browser actually matches.
      // This is not a waiver: the resulting case is still measured against painted pixels.
      if (nm === "not" && el.parentNode) {
        const arg = String(p.args || "").replace(/\s+/g, "").toLowerCase();
        if (arg === ":first-child" && !el.previousElementSibling) {
          const sibling = document.createElement("span");
          el.parentNode.insertBefore(sibling, el); created.push(sibling);
        } else if (arg === ":last-child" && !siblingFollows && !el.nextElementSibling) {
          const sibling = document.createElement("span");
          el.parentNode.insertBefore(sibling, el.nextSibling); created.push(sibling);
        } else if (arg === ":only-child" && !siblingFollows && !el.previousElementSibling && !el.nextElementSibling) {
          const sibling = document.createElement("span");
          el.parentNode.insertBefore(sibling, el.nextSibling); created.push(sibling);
        }
      }
      if ((nm === "nth-child" || nm === "nth-of-type") && el.parentNode) {
        const arg = String(p.args || "1").replace(/\s+/g, " ").trim().toLowerCase();
        if (/\sof\s/.test(arg)) { st.unbuilt = `:${nm}(${p.args}): the "of <selector>" form cannot be positioned`; return false; }
        const flat = arg.replace(/\s+/g, "");
        let idx = 1;
        if (flat === "odd") idx = 1; else if (flat === "even") idx = 2;
        else { const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(flat); if (m) { const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : 0; for (let n = 0; n < 50; n++) { const v = a * n + b; if (v >= 1) { idx = v; break; } } } else if (/^\d+$/.test(flat)) idx = parseInt(flat, 10); else { st.unbuilt = `:${nm}(${p.args})`; return false; } }
        for (let k = 1; k < idx; k++) { const sib = document.createElement(nm === "nth-of-type" ? el.tagName : "span"); el.parentNode.insertBefore(sib, el); created.push(sib); }
      } else if (nm === "has" && p.args) {
        const inner = parseComplex(p.args.replace(/^\s*[>+~]\s*/, ""));
        if (!inner) { st.unbuilt = `:has(${p.args})`; return false; }
        let cur = el;
        for (const part of inner) { const ch = document.createElement(part.c.tag || "div"); cur.appendChild(ch); created.push(ch); if (!applyState(ch, part.c, st)) return false; cur = ch; }
      }
    }
    return true;
  }
  const tagFor = (c) => c.tag || (c.pseudos.some((p) => p.name === "disabled" || p.name === "enabled") ? "button" : c.pseudos.some((p) => p.name === "checked") ? "input" : "div");
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const dimmed = (e) => { for (let x = e; x; x = x.parentElement) if (parseFloat(getComputedStyle(x).opacity) < 1) return true; return false; };
  /** The first visible real element for a selector (one that is not dimmed by an ancestor's opacity if there is one: a dimmed row is its own state), or null. */
  const findReal = (s) => { try { let any = null; for (const e of document.querySelectorAll(s)) if (visible(e) && !e.closest("#qa-host")) { if (!dimmed(e)) return e; any = any || e; } return any; } catch (e) { note(`selector "${s}"`, e); } return null; };
  function addText(subject, last) {
    const tag = subject.tagName.toLowerCase();
    if (last.pe && !/^(before|after|first-line|first-letter)$/.test(last.pe)) { if (last.pe === "placeholder" && (tag === "input" || tag === "textarea")) { setAttr(subject, "placeholder", "Text"); subject.removeAttribute("value"); } return; }
    if (tag === "input" && /^(checkbox|radio|range|color|file|hidden|image)$/i.test(subject.getAttribute("type") || "")) return;
    // An SVG geometry node has no textual content. Inventing the word "Text"
    // under a stroke-only path/line falsifies rendered contrast; SVG labels and
    // <text> remain text carriers and are still checked. Geometric contrast
    // belongs to the visible-UI/non-text visual QA on real SVG pixels.
    if (/^(path|line|polyline|polygon|rect|circle|ellipse|svg|g)$/.test(tag)) return;
    if (tag === "input" || tag === "textarea") { if (tag === "input" && !subject.getAttribute("type")) setAttr(subject, "type", "text"); if (!subject.value) { setAttr(subject, "value", "Text"); if (tag === "textarea") subject.textContent = "Text"; } }
    else if (!VOID.has(tag) && !last.pseudos.some((p) => p.name === "empty") && !subject.textContent.trim()) subject.textContent = "Text";
  }
  /** A menu closed on the page, a hidden panel: shown, so what it paints when it opens is measured (the subject, its subtree and its ancestors). */
  function forceShow(subject) {
    const list = []; for (let e = subject; e; e = e.parentElement) list.push(e);
    for (const e of subject.querySelectorAll("*")) list.push(e);
    for (const e of list) {
      const c = getComputedStyle(e); let add = "";
      if (c.display === "none") { const t = e.tagName.toLowerCase(); add += `;display:${INLINE.has(t) ? "inline" : t === "li" ? "list-item" : ["button", "input", "select", "textarea", "img"].includes(t) ? "inline-block" : "block"}!important`; }
      if (c.visibility === "hidden") add += ";visibility:visible!important";
      if (add) setAttr(e, "style", (e.getAttribute("style") || "") + add);
    }
  }

  /**
   * Put a selector on the page. mode "page": on the real page (reuse a real subject, or build it under the real ancestor the
   * selector names); mode "harness": a synthetic chain in the neutral page (`on`: the surface role it is declared to sit on).
   * `show`: whatever is hidden (display:none, visibility:hidden) is shown.
   */
  /** Errors the page program swallowed: a selector the browser rejects, a colour it cannot read. Never a match and never a pass: the case is reported as "not measured: <error>". */
  const swallowed = [];
  const note = (what, e) => { swallowed.push(`${what}: ${(e && e.message) || e}`); };
  function build(sel0, mode, decl, show) {
    swallowed.length = 0;
    const r = buildOne(sel0, mode, decl, show);
    if (swallowed.length) { if (r.ok) undo(); return { ok: false, error: true, unbuilt: `not measured: ${swallowed[0]}` }; }
    return r;
  }
  function buildOne(sel0, mode, decl, show) {
    undo();
    const on = decl && decl.on, container = decl && decl.in;
    const sel = container ? `${container} ${sel0}` : sel0;
    const parts = parseComplex(sel);
    if (!parts || !parts.length) return { ok: false, unbuilt: "unparsable selector" };
    const st = { unbuilt: "" };
    const fail = () => { undo(); return { ok: false, unbuilt: st.unbuilt }; };
    const last = parts[parts.length - 1].c, prefix = parts.slice(0, -1);
    const token = `c${++seq}`;
    let subject = null, where = "", synthetic = false;
    if (mode === "page") {
      if (prefix.length) {
        let M = findReal(textOf(prefix));
        if (!M) {
          // relaxed: the real element of the ancestor compound whatever its variant; the variant is then put on it
          const lc = prefix[prefix.length - 1].c;
          const rp = prefix.slice(0, -1).map((p, i) => (i ? sep(p) : "") + p.c.src).join("") + (prefix.length > 1 ? sep(prefix[prefix.length - 1]) : "") + relaxed(lc);
          M = findReal(rp);
          if (M && (!applyState(M, lc, st) || !position(M, lc, st, { siblingFollows: ["+", "~"].includes(parts.at(-1).comb) }))) return fail();
        }
        if (!M) {
          // A positional predicate may be on ANY ancestor, not merely the final prefix
          // compound. Find the real path with only the stable tag/class constraints,
          // then reconstruct its actual ancestors and put every state on its own node.
          const relaxedPath = prefix.map((p, i) => (i ? sep(p) : "") + relaxed(p.c)).join("");
          const candidate = findReal(relaxedPath);
          if (candidate) {
            let node = candidate, valid = true;
            for (let i = prefix.length - 1; i >= 0; i--) {
              const c = prefix[i].c, next = prefix[i + 1];
              if (next) {
                if (next.comb === ">") node = node.parentElement;
                else if (next.comb === "+") node = node.previousElementSibling;
                else if (next.comb === "~") {
                  node = node.previousElementSibling;
                  while (node && !node.matches(relaxed(c))) node = node.previousElementSibling;
                } else {
                  node = node.parentElement;
                  while (node && !node.matches(relaxed(c))) node = node.parentElement;
                }
              }
              if (!node || !node.matches(relaxed(c))) { valid = false; break; }
              if (!applyState(node, c, st) || !position(node, c, st, {
                siblingFollows: ["+", "~"].includes(parts[i + 1]?.comb),
              })) return fail();
            }
            // Never measure default page colours for a rule that does not apply.
            // Its target must genuinely match the entire selector path after placement.
            if (valid && candidate.matches(prefix.map((p, i) => (i ? sep(p) : "") + withoutForcedPseudo(p.c.src.replace(STRIP_PE, ""))).join(""))) M = candidate;
          }
        }
        if (!M) return { ok: false, unmounted: true };
        const rel = relaxed(last), comb = parts[parts.length - 1].comb;
        try {
          const pool = comb === "+" || comb === "~" ? (() => { const after = []; for (let e = M.nextElementSibling; e; e = comb === "+" ? null : e.nextElementSibling) { if (e.matches(rel)) after.push(e); } return after; })() : [...M.querySelectorAll(comb === ">" ? `:scope > ${rel}` : `:scope ${rel}`)];
          subject = pool.find(visible) || null;
        } catch (e) { note(`selector "${rel}"`, e); subject = null; }
        if (!subject) { subject = document.createElement(tagFor(last)); created.push(subject); synthetic = true; if (comb === "+" || comb === "~") M.parentNode.insertBefore(subject, M.nextSibling); else M.appendChild(subject); }
      } else {
        subject = last.tag === "html" ? document.documentElement : last.tag === "body" ? document.body : findReal(relaxed(last));
        if (!subject) return { ok: false, unmounted: true };
      }
      if (!applyState(subject, last, st) || !position(subject, last, st)) return fail();
      // a state a tag cannot have (:disabled on an <a>, :checked on a <div>) is not on the element: it is built as the element that can have it
      if (!last.tag && !matchesCompound(subject, last)) {
        const swap = document.createElement(last.pseudos.some((p) => p.name === "checked") ? "input" : "button"); created.push(swap);
        subject.parentNode.insertBefore(swap, subject.nextSibling); subject = swap; synthetic = true;
        if (!applyState(subject, last, st) || !position(subject, last, st)) return fail();
      }
      if (!matchesCompound(subject, last)) { undo(); return { ok: false, unbuilt: `the element built for "${sel0}" does not match its last compound selector` }; }
      if (subject === document.body || subject === document.documentElement) { const t = document.createTextNode("Text"); document.body.appendChild(t); extras.push(t); }
      where = "page";
    } else {
      // synthetic chain: a modifier brings its block, an element sits in its block (unless the entry declares where it is used, on a surface or in a container: that is then the context)
      synthetic = true;
      const blocks = [];
      for (const { c } of parts) for (const k of [...c.classes]) { const m = /^([a-z][\w-]*?)--[\w-]+$/i.exec(k); if (m && !c.classes.includes(m[1])) c.classes.push(m[1]); }   // a modifier always comes with its block class
      if (!container && !on) for (const k of parts[0].c.classes) { const m = /^([a-z][\w-]*?)__[\w-]+$/i.exec(k); if (m && !parts.some((x) => x.c.classes.includes(m[1]))) blocks.push(m[1]); }
      for (const b of [...new Set(blocks)].reverse()) parts.unshift({ comb: " ", c: { tag: "", id: "", classes: [b], attrs: [], pseudos: [], pe: "", src: "." + b } });
      let host = document.getElementById("qa-host");
      if (!host) { host = document.createElement("div"); host.id = "qa-host"; document.body.appendChild(host); }
      const wrap = document.createElement("div"); if (on) wrap.style.background = `var(--c-${on.replace(/[A-Z0-9]+/g, (m, i) => (i ? "-" : "") + m.toLowerCase())})`; host.appendChild(wrap); created.push(wrap);
      // A synthetic selector must inherit the same component-level token
      // authority as the real application. For example, .kw-dev--phone is
      // always inside .kw, which defines --kw-ink/--kw-on-ink. Without that
      // root scope Chromium silently discards its unresolved colour vars and
      // judges white text on an unrelated neutral page instead of the phone.
      // Discover the prefix from the selector and prove the stylesheet defines
      // that namespace. Never invent a colour, hand-wave an exception or mark
      // a pair as passing without rendered pixels.
      const leadClass = parts[0]?.c?.classes?.[0] || "";
      const componentPrefix = /^([a-z][a-z0-9]*)(?:[-_])/.exec(leadClass)?.[1];
      if (componentPrefix && !parts.some((p) => p.c.classes.includes(componentPrefix))) {
        const probe = document.createElement("div");
        probe.className = componentPrefix;
        host.appendChild(probe);
        const probeStyle = getComputedStyle(probe);
        const hasScopedTokens = ["ink", "accent", "surface"].some((role) =>
          probeStyle.getPropertyValue("--" + componentPrefix + "-" + role).trim() !== "");
        probe.remove();
        if (hasScopedTokens) wrap.classList.add(componentPrefix);
      }
      let prev = wrap;
      for (let i = 0; i < parts.length; i++) {
        const { comb, c } = parts[i];
        let el;
        if (c.tag === "html" || c.tag === "body") { el = c.tag === "html" ? document.documentElement : document.body; if (!applyState(el, c, st)) return fail(); if (i === parts.length - 1) subject = el; continue; }
        el = document.createElement(tagFor(c)); created.push(el);
        if (comb === "+" || comb === "~") { if (prev === wrap) { undo(); return { ok: false, unbuilt: "sibling combinator without a previous element" }; } prev.parentNode.appendChild(el); }
        else { if (VOID.has(prev.tagName.toLowerCase())) { undo(); return { ok: false, unbuilt: "child of a void element" }; } prev.appendChild(el); }
        if (!applyState(el, c, st) || !position(el, c, st, { siblingFollows: ["+", "~"].includes(parts[i + 1]?.comb) })) return fail();
        prev = el; subject = el;
      }
      if (!subject) { undo(); return { ok: false, unbuilt: "no subject" }; }
      if (subject === document.body) { const t = document.createTextNode("Text"); document.body.appendChild(t); extras.push(t); }
      where = container ? `neutral page, declared in ${container}` : on ? `neutral page, declared on ${on}` : "neutral page";
    }
    // a real element keeps the text the page gave it; a built one is given text unless it is a shape: a box the CSS sizes (a dot, a bar, an icon box)
    // that stands there EMPTY with a content area, which a text carrier does not (an empty block has no height, an empty inline no width)
    let shape = false;
    if (synthetic && !last.pe && !VOID.has(subject.tagName.toLowerCase())) {
      const c = getComputedStyle(subject), r = subject.getBoundingClientRect();
      const cw = r.width - (parseFloat(c.paddingLeft) || 0) - (parseFloat(c.paddingRight) || 0) - (parseFloat(c.borderLeftWidth) || 0) - (parseFloat(c.borderRightWidth) || 0);
      const ch = r.height - (parseFloat(c.paddingTop) || 0) - (parseFloat(c.paddingBottom) || 0) - (parseFloat(c.borderTopWidth) || 0) - (parseFloat(c.borderBottomWidth) || 0);
      shape = !subject.textContent.trim() && ((cw > 0.5 && ch > 0.5) || (!CARRIER.has(subject.tagName.toLowerCase()) && (window.__sized || []).some((q) => { try { return subject.matches(q); } catch (e) { note(`selector "${q}"`, e); return false; } })));
    }
    if (!shape && (synthetic || subject === document.body || subject === document.documentElement)) addText(subject, last);
    if (show) forceShow(subject);
    subject.setAttribute("data-qa-subject", token); touched.add(subject);
    const forced = [...touched].filter((e) => e.hasAttribute("data-qa-force"));
    forced.forEach((f, k) => f.setAttribute("data-qa-fid", `${token}-${k}`));
    return { ok: true, token, pe: last.pe || "", states: [...new Set(forced.flatMap((f) => f.getAttribute("data-qa-force").split(" ")))], hasForce: forced.length > 0, where, synthetic, toneable: toneable(token) };
  }
  /** Does the element match the compound as written, leaving out what is forced by the protocol (:hover ...) and the pseudo-element? */
  function matchesCompound(el, c) {
    const text = withoutForcedPseudo(c.src.replace(STRIP_PE, ""));
    if (!text || text === "*") return true;
    try { return el.matches(text); } catch (e) { note(`selector "${text}"`, e); return false; }
  }
  const subjectOf = (token) => document.querySelector(`[data-qa-subject="${token}"]`);

  // ---- measuring
  let cv = null;
  /** Any computed colour (rgb, color(srgb), oklch, lab, hsl ...) as sRGB [r,g,b,a]: the browser's own conversion, through a canvas. */
  const viaCanvas = (str) => { try { cv = cv || document.createElement("canvas"); cv.width = cv.height = 1; const g = cv.getContext("2d", { willReadFrequently: true }); g.clearRect(0, 0, 1, 1); g.fillStyle = "transparent"; g.fillStyle = str; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; if (d[3] === 0) return [0, 0, 0, 0]; return [d[0], d[1], d[2], d[3] / 255]; } catch (e) { note(`colour "${str}"`, e); return null; } };
  const parse0 = (s) => { const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(s || ""); if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return [+m[1], +m[2], +m[3], a]; } const c = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)/.exec(s || ""); if (c) { const a = c[4] === undefined ? 1 : c[4].endsWith("%") ? parseFloat(c[4]) / 100 : parseFloat(c[4]); return [c[1] * 255, c[2] * 255, c[3] * 255, a]; } return null; };
  const parse = (s) => { if (!s) return null; if (s === "transparent") return [0, 0, 0, 0]; return parse0(s) || viaCanvas(s); };
  const over = (f, b) => [0, 1, 2].map((k) => f[k] * f[3] + b[k] * (1 - f[3])).concat([1]);
  /** The colour of the canvas under the page in the scheme being rendered (white in light, the dark canvas in a dark colour-scheme), by the browser's own `Canvas` system colour. */
  function canvas() { const p = document.createElement("div"); p.style.cssText = "background:Canvas;position:absolute;width:1px;height:1px"; document.documentElement.appendChild(p); const c = parse(getComputedStyle(p).backgroundColor) || [255, 255, 255, 1]; p.remove(); return [c[0], c[1], c[2], 1]; }
  const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const fillOf = (cs) => parse(cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color);
  /** The elements whose text is a pair of this subject: the subject itself if it has a text node, and every visible descendant with one that inherits the subject's colour (what the subject's rule gives it; a descendant with a colour of its own is judged by its own selector). */
  function textHolders(subj, pe) {
    if (pe) return [subj];
    const tag = subj.tagName.toLowerCase();
    if (tag === "input" && /^(checkbox|radio|range|color|file|hidden|image)$/i.test(subj.getAttribute("type") || "")) return [];   // paints no text
    if (tag === "input" || tag === "textarea" || tag === "select") return [subj];
    const sc = getComputedStyle(subj).color, out = [];
    if (ownText(subj)) out.push(subj);
    const w = document.createTreeWalker(subj, NodeFilter.SHOW_ELEMENT);
    for (let e; (e = w.nextNode());) if (ownText(e) && visible(e) && getComputedStyle(e).color === sc) out.push(e);
    return out.slice(0, 8);
  }
  /** The line boxes of a holder's own text (page coordinates); the box of the holder for a pseudo-element, a field or a text-less holder. */
  function textRects(h, pe) {
    const page = (r) => [r.left + scrollX, r.top + scrollY, r.width, r.height];
    const tag = h.tagName.toLowerCase();
    let rects = [];
    if (!pe && tag !== "input" && tag !== "textarea" && tag !== "select") for (const n of h.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) if (q.width > 1 && q.height > 1) rects.push(page(q)); }
    if (!rects.length) { const q = h.getBoundingClientRect(); if (q.width > 0 && q.height > 0) rects.push(page(q)); }
    return rects.slice(0, 8);
  }
  /** What the text of a subject is measured as: { items: [{ fg, size, bold, rects, clip, domBg, holder }] } or { skip, benign }. */
  function measure(subj, pe) {
    clipEls = []; heldItems = [];
    if (pe === "backdrop") return { skip: "::backdrop is the top layer, not a text pair", benign: true };
    const holders = textHolders(subj, pe);
    if (!holders.length) return { skip: "no text on this element", benign: true, noText: true };
    const canvasBg = canvas(), items = []; let reason = "", benign = true;
    for (const h of holders) {
      const chain = []; for (let e = h; e; e = e.parentElement) chain.unshift(e);
      if (chain.some((e) => { const c = getComputedStyle(e); return c.display === "none" || c.visibility === "hidden"; })) { reason = "not rendered (display:none / visibility:hidden)"; benign = false; continue; }
      const peName = pe && /^(before|after|placeholder|selection|marker|first-line|first-letter|file-selector-button)$/.test(pe) ? `::${pe}` : null;
      const cs = getComputedStyle(h, peName);
      if (pe === "before" || pe === "after") { const ct = cs.content; if (!ct || ct === "none" || ct === "normal" || ct === '""' || ct === "''") { reason = "pseudo-element without content paints no text"; continue; } }
      try { h.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch { /* the page detached the element: nothing to scroll to, and its measurement is skipped as a lost subject */ }
      const rects = textRects(h, pe);
      if (!rects.length) { reason = "not rendered (no box)"; benign = false; continue; }
      const fill = fillOf(cs);
      if (!fill) { reason = "unreadable colour"; benign = false; continue; }
      const clipEl = [...chain].reverse().find((e) => { const c = getComputedStyle(e); return c.webkitBackgroundClip === "text" || c.backgroundClip === "text"; });
      const clip = fill[3] === 0 && !!clipEl;
      if (fill[3] === 0 && !clip) { reason = "fully transparent text paints nothing"; continue; }
      let opacity = 1; for (const e of chain) opacity *= parseFloat(getComputedStyle(e).opacity);
      if ((clip ? 1 : fill[3]) * opacity === 0) { reason = "fully transparent (opacity 0) text paints nothing"; continue; }
      let cur = canvasBg;
      for (const e of chain) {
        const c = getComputedStyle(e); const b = parse(c.backgroundColor); const o = parseFloat(c.opacity);
        if (b && b[3] > 0 && !(e === clipEl && clip)) { const withBg = over(b, cur); cur = o < 1 ? over([withBg[0], withBg[1], withBg[2], o], cur) : withBg; }
      }
      if (peName && pe !== "first-line" && pe !== "first-letter") { const b = parse(cs.backgroundColor); if (b && b[3] > 0) cur = over(b, cur); }
      const pseudoBg = !!(peName && pe !== "first-line" && pe !== "first-letter" && ((parse(cs.backgroundColor) || [0, 0, 0, 0])[3] > 0 || cs.backgroundImage !== "none"));   // a pseudo-element with a box of its own (a marker, a badge): its colour and the ancestors' are what is behind its text; the host's box is not
      if (clip) clipEls.push(clipEl);
      const px = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight, 10) || (cs.fontWeight === "bold" ? 700 : 400);
      const vrects = rects.map(([x, y, w, hh]) => [x - scrollX, y - scrollY, w, hh]);
      const inView = vrects.every(([x, y, w, hh]) => x >= 0 && y >= 0 && x + w <= innerWidth && y + hh <= innerHeight);
      heldItems.push({ h, pe });
      items.push({ vrects, inView, fg: [fill[0], fill[1], fill[2], fill[3] * opacity], size: px, bold: w >= 700, rects, clip, domBg: cur.slice(0, 3), pe: !!peName });
    }
    if (!items.length) return { skip: reason || "no text on this element", benign };
    return { items };
  }
  /** Hide every text on the page (so a screenshot is the background alone); `fill`: the clipped gradient of a background-clip:text element painted as a plain rectangle (the fill the text shows). */
  function hide(mode) {
    document.getElementById("qa-hide")?.remove();
    for (const e of clipEls) { e.setAttribute("data-qa-clip", ""); touched.add(e); }
    const st = document.createElement("style"); st.id = "qa-hide";
    st.textContent = `*,*::before,*::after,*::placeholder,*::marker,::selection{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important;caret-color:transparent!important}` +
      (mode === "fill" ? `[data-qa-clip]{-webkit-background-clip:border-box!important;background-clip:border-box!important}` : `[data-qa-clip]{background:none!important}`);
    document.head.appendChild(st);
  }
  /** Restore normal glyph paint after a synthetic mask probe. Does not undo a forced selector state. */
  function showOriginalText() { document.getElementById("qa-hide")?.remove(); }
  /** Scroll the i-th measured holder to the middle of the view and give its lines as they are now (page coordinates): a sticky or fixed bar is then where the user would see it. */
  function focusItem(i) {
    const { h, pe } = heldItems[i];
    try { h.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch { /* the page detached the element: nothing to scroll to, and its measurement is skipped as a lost subject */ }
    return textRects(h, pe);
  }
  /** Measure the SAME glyph box after scroll, in viewport space for a Chromium
   * captureBeyondViewport:false shot. This is an independent coordinate proof:
   * an offscreen/document-space clip may yield white unrelated pixels even when
   * the target genuinely paints black behind its white text. */
  function viewportItem(i) {
    const h = heldItems[i]?.h;
    if (!h?.isConnected) return null;
    const rects = focusItem(i).map(([x, y, w, height]) => [x - scrollX, y - scrollY, w, height]);
    if (!rects.length || rects.some(([x, y, w, height]) =>
      x < 0 || y < 0 || w < 2 || height < 2 || x + w > innerWidth || y + height > innerHeight)) return null;
    return rects;
  }
  /** Show the measured pseudo-element's text, and only it, in a loud colour: the difference of that shot and the hidden one is where its glyphs are. */
  function showPseudoText(pe, loud) { const st = document.getElementById("qa-hide"); if (st) st.textContent += `[data-qa-subject]::${pe}{color:${loud}!important;-webkit-text-fill-color:${loud}!important}`; }
  /**
   * Expose the precise glyph shape of ONE measured text holder, without
   * changing layout, background, or other text. The normal background-only
   * screenshot samples a line rectangle, which includes margins, siblings and
   * badges on real pages and can falsely mark white-on-black as white-on-white.
   * A second loud-ink screenshot identifies ONLY pixels on which that holder
   * actually paints. No detected glyph => keep the original failure.
   */
  function showItemText(i, loud) {
    const h = heldItems[i]?.h, st = document.getElementById("qa-hide");
    if (!h || !h.isConnected || !st) return false;
    h.setAttribute("data-qa-glyph", String(i));
    touched.add(h);
    st.textContent += `[data-qa-glyph="${i}"]{color:${loud}!important;-webkit-text-fill-color:${loud}!important}`;
    return true;
  }
  /** A positioned real-page overlay conceals glyph ink; a loud-glyph
   * screenshot CANNOT disprove this overlay simply because its pixels remain
   * obscured. Keep the original rectangle failure for this case. */
  function coveredByPositionedOverlay(i, x, y) {
    const subject = heldItems[i]?.h;
    if (!subject || !subject.isConnected) return false;
    // worstOverRects returns DOCUMENT coordinates, but elementFromPoint
    // consumes VIEWPORT coordinates. A scrolled page must subtract the
    // current viewport offset or an occluding header/sibling is missed.
    const vx = x - scrollX, vy = y - scrollY;
    if (vx < 0 || vy < 0 || vx >= innerWidth || vy >= innerHeight) return false;
    const top = document.elementFromPoint(vx, vy);
    if (!top || top === subject) return false;
    for (let node = top; node && node !== subject; node = node.parentElement) {
      const st = getComputedStyle(node);
      if (st.position !== "static" && st.zIndex !== "auto" &&
          !node.contains(subject)) return true;
    }
    return false;
  }
  /** Set --c (and --on-c) the way a consumer does: on the parent of the subject. */
  function setTone(token, tone) {
    const subj = subjectOf(token); const host = subj && subj.parentElement; if (!host) return;
    if (!host.hasAttribute("data-qa-tone")) { host.setAttribute("data-qa-tone", ""); touched.add(host); undoAttrs.push([host, "style", host.getAttribute("style")]); }
    host.style.removeProperty("--c"); host.style.removeProperty("--on-c");
    if (tone) { host.style.setProperty("--c", `var(${tone.fill})`); if (tone.on) host.style.setProperty("--on-c", `var(${tone.on})`); }
  }
  /** A tone is set by a rule when --c comes from a stylesheet on this very element (a .ntf--ok{--c:..}), not inherited from its parent. */
  const ownsTone = (el) => { const p = el.parentElement; const mine = getComputedStyle(el).getPropertyValue("--c").trim(); const up = p ? getComputedStyle(p).getPropertyValue("--c").trim() : ""; return mine !== "" && mine !== up; };
  /** Does the case read the tone custom properties without setting them itself? Then it is measured on every fill. */
  function toneable(token) {
    const subj = subjectOf(token); if (!subj || ownsTone(subj)) return false;
    for (let e = subj; e && e !== document.body; e = e.parentElement) for (const s of window.__toned || []) { try { if (e.matches(s) && !ownsTone(e)) return true; } catch (er) { note(`selector "${s}"`, er); } }
    return false;
  }
  /** Measure the built case (with the tone set when given) and hide the text for the screenshot that follows. */
  function measureCase(token, pe, tone) {
    const subj = subjectOf(token); if (!subj) return { skip: "subject lost", benign: false };
    swallowed.length = 0;
    const m = measureCaseInner(subj, token, pe, tone);
    return swallowed.length ? { error: `not measured: ${swallowed[0]}` } : m;
  }
  function measureCaseInner(subj, token, pe, tone) {
    document.getElementById("qa-hide")?.remove();   // a previous tone's screenshot hid the text: it is shown again to be read
    if (tone) setTone(token, tone);
    const m = measure(subj, pe);
    if (m.items) hide("backdrop");
    return m;
  }
  /** build + measure in one round trip when the case needs nothing from outside the page (no forced state, no tone to set). */
  function start(sel, mode, decl, show) {
    const b = build(sel, mode, decl, show);
    if (!b.ok || b.hasForce || b.toneable) return { b };
    return { b, m: measureCase(b.token, b.pe, null) };
  }
  /** What a hook changes: the colour roles of the root and the page's own colours, as one string (a hook that leaves it as it was is not exercised). */
  function colourState() {
    const cs = getComputedStyle(document.documentElement), out = [];
    for (let i = 0; i < cs.length; i++) { const n = cs[i]; if (n.startsWith("--c-")) out.push(`${n}=${cs.getPropertyValue(n).trim()}`); }
    const b = getComputedStyle(document.body);
    out.push(cs.backgroundColor, cs.color, b.backgroundColor, b.color);
    return out.join("|");
  }
  /** Put the page in the dark theme the CSS reacts to: the attributes and classes of the hooks, on <html> or <body>. Returns what they changed. */
  function applyHooks(hooks) {
    const before = colourState();
    for (const h of hooks) { const el = h.el === "body" ? document.body : document.documentElement; if (h.kind === "attr") el.setAttribute(h.name, h.value); else el.classList.add(h.name); }
    return { changed: colourState() !== before };
  }
  return { build, start, undo, measureCase, hide, showPseudoText, showItemText, showOriginalText, coveredByPositionedOverlay, focusItem, viewportItem, setTone, applyHooks };
}

/* ---------------------------------------------------------------------------------------------------------------------- */

const splitTop = (s) => { const out = []; let d = 0, q = "", cur = ""; for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { cur += c; if (c === q && s[i - 1] !== "\\") q = ""; continue; } if (c === '"' || c === "'") { q = c; cur += c; continue; } if (c === "(" || c === "[") d++; if (c === ")" || c === "]") d--; if (c === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += c; } out.push(cur.trim()); return out.filter(Boolean); };
const expandNested = (parents, children) => {
  const out = [];
  for (const c of children) for (const p of parents.length ? parents : [""]) out.push(!p ? c : c.includes("&") ? c.replace(/&/g, p) : `${p} ${c}`);
  return out;
};
/**
 * :is(), :where(), :matches() and :-webkit-any() are built branch by branch: `.chip:is(.hot, .cold)` is `.chip.hot` and `.chip.cold`,
 * `:where(.dark) .t2` is `.dark .t2`. → { branches: [selector], unbuilt?: reason } (an argument with a combinator inside a compound cannot be written as one compound).
 */
export function expandBranches(sel) {
  const m = /:(?:is|where|matches|-webkit-any|-moz-any)\(/.exec(sel);
  if (!m) return { branches: [sel] };
  let d = 0, k = m.index + m[0].length - 1;
  for (; k < sel.length; k++) { if (sel[k] === "(") d++; else if (sel[k] === ")" && --d === 0) break; }
  if (k >= sel.length) return { branches: [sel], unbuilt: "unbalanced :is()/:where()" };
  const pre = sel.slice(0, m.index), post = sel.slice(k + 1), args = splitTop(sel.slice(m.index + m[0].length, k));
  const out = [];
  for (const a of args) {
    const complex = /[\s>+~]/.test(a.replace(/\([^)]*\)|\[[^\]]*\]/g, ""));
    const compoundBefore = pre.length > 0 && !/[\s>+~]$/.test(pre), compoundAfter = post.length > 0 && !/^[\s>+~]/.test(post);
    if (complex && (compoundBefore || compoundAfter)) return { branches: [sel], unbuilt: `:is()/:where() argument "${a}" has a combinator inside a compound selector` };
    const r = expandBranches(pre + a + post);
    if (r.unbuilt) return r;
    out.push(...r.branches);
    if (out.length > 16) return { branches: [sel], unbuilt: ":is()/:where() with more than 16 branches" };
  }
  return { branches: [...new Set(out)] };
}
/** The widths a list of media conditions switch at: the breakpoint and the pixel next to it, on the side the rule does not apply. */
export function breakpointsOf(conditions) {
  const px = (n, u) => Math.round(parseFloat(n) * (u === "px" ? 1 : 16));
  const set = new Set();
  for (const c of conditions) {
    for (const m of String(c).matchAll(/\b(min|max)-width\s*:\s*([\d.]+)(px|em|rem)/gi)) { const v = px(m[2], m[3].toLowerCase()); set.add(v); set.add(m[1].toLowerCase() === "min" ? v - 1 : v + 1); }
    for (const m of String(c).matchAll(/\bwidth\s*(>=|<=|>|<)\s*([\d.]+)(px|em|rem)/gi)) { const v = px(m[2], m[3].toLowerCase()); set.add(v); set.add(m[1][0] === ">" ? v - 1 : v + 1); }
    for (const m of String(c).matchAll(/([\d.]+)(px|em|rem)\s*(<=|<|>=|>)\s*width/gi)) { const v = px(m[1], m[2].toLowerCase()); set.add(v); set.add(m[3][0] === "<" ? v - 1 : v + 1); }
  }
  return [...set].filter((v) => v >= 200 && v <= 4000).sort((a, b) => a - b);
}
/** The dark-theme hooks a CSS reacts to on the page itself: [data-theme=dark] and the like, html.dark, :root.dark, body.dark. */
export function darkHooks(selectors) {
  const hooks = new Map();
  for (const sel of selectors) for (const one of splitTop(sel)) {
    const first = one.trim().split(/[\s>+~]/)[0];
    const tag = (/^([a-z]+|:root)/i.exec(first) || [])[1] || "";
    if (tag && !/^(html|body|:root)$/i.test(tag)) continue;   // a component's own variant (.card[data-theme=dark]) is built by the selector itself
    const el = /^body$/i.test(tag) ? "body" : "html";
    for (const m of first.matchAll(/\[\s*((?:data-)?[\w-]*(?:theme|mode|scheme)[\w-]*)\s*[~|^$*]?=\s*["']?(dark[\w-]*|[\w-]*-dark)["']?\s*\]/gi)) hooks.set(`a:${el}:${m[1]}=${m[2]}`, { el, kind: "attr", name: m[1], value: m[2], text: `${el === "body" ? "body" : "html"}[${m[1]}=${m[2]}]` });
    if (tag) for (const m of first.matchAll(/\.(dark|dark-mode|dark-theme|theme-dark|is-dark|mode-dark)(?![\w-])/gi)) hooks.set(`c:${el}:${m[1]}`, { el, kind: "class", name: m[1], text: `${el}.${m[1]}` });
  }
  return [...hooks.values()];
}

const ratioOf = contrast;   // the one formula, @saasreport/core/colour
const overPx = (f, b) => [0, 1, 2].map((k) => f[k] * f[3] + b[k] * (1 - f[3]));
const hex = (c) => "#" + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("").toUpperCase();
/** A sheet's path with its locale suffix folded: styles.css and styles.ar.css are one sheet in two locales; the directory stays: an entry names the exact path. */
export const sheetKey = (f) => String(f || "").replace(/\.[a-z]{2}\.css$/, ".css");
const sameSheet = (entry, found) => !entry || !found || sheetKey(entry) === sheetKey(found);
/** The label of a measured state: "base", ":hover", "::before :hover", optionally followed by " tone:<role>". An entry's context is that label, exactly. */
export const stateLabel = (state, tone) => `${state}${tone ? ` tone:${tone}` : ""}`;
const contextMatches = (e, p) => e.context === p.state || e.context === stateLabel(p.state, p.tone);

/** The painted pixels behind the lines of a text, from a screenshot of the page (text hidden) cropped at `clip`: the worst ratio of the text colour over them, and that background. */
function worstOverRects(png, clip, rects, fg, fillPng) {
  const all = [];
  for (const [x, y, w, h] of rects) {
    const nx = Math.max(2, Math.min(24, Math.round(w / 6))), ny = Math.max(2, Math.min(6, Math.round(h / 6)));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const px = Math.round(x + w * (0.1 + 0.8 * (i / (nx - 1))) - clip.x), py = Math.round(y + h * (0.2 + 0.6 * (j / (ny - 1))) - clip.y);
      if (px < 0 || py < 0 || px >= png.w || py >= png.h) continue;
      const bg = png.px(px, py), text = fillPng ? fillPng.px(px, py) : overPx(fg, bg);
      all.push({ ratio: ratioOf(text, bg), background: bg, text, sample: [px + clip.x, py + clip.y] });
    }
  }
  if (!all.length) return null;
  all.sort((a, b) => a.ratio - b.ratio);
  return all[Math.min(all.length - 1, Math.floor(all.length * 0.03))];
}
/**
 * Sample contrast *under actual text glyphs*, not every background pixel
 * inside the text line's box. A loud-magenta second screenshot differs from
 * a text-hidden screenshot exactly where this holder paints its glyphs.
 * Null is a failure to verify, never evidence of passing.
 */
export function worstOverGlyphPixels(hidden, loud, clip, rects, fg) {
  if (!hidden || !loud || hidden.w !== loud.w || hidden.h !== loud.h) return null;
  const all = [];
  for (const [x, y, w, h] of rects) {
    const x0 = Math.max(0, Math.floor(x - clip.x)), y0 = Math.max(0, Math.floor(y - clip.y));
    const x1 = Math.min(hidden.w, Math.ceil(x + w - clip.x)), y1 = Math.min(hidden.h, Math.ceil(y + h - clip.y));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
      const bg = hidden.px(px, py), bright = loud.px(px, py);
      // Only strong magenta ink (red AND blue raised, green left behind).
      // Antialiased fringe and unrelated repainting cannot yield a pass.
      if (bright[0] < 140 || bright[2] < 140 ||
          bright[1] > Math.min(bright[0], bright[2]) * 0.6 ||
          Math.abs(bright[0] - bg[0]) + Math.abs(bright[1] - bg[1]) +
          Math.abs(bright[2] - bg[2]) < 80) continue;
      const ink = overPx(fg, bg);
      all.push({ ratio: ratioOf(ink, bg), background: bg, text: ink });
    }
  }
  if (!all.length) return null;
  all.sort((a, b) => a.ratio - b.ratio);
  return all[Math.min(all.length - 1, Math.floor(all.length * 0.03))];
}
/**
 * T=0 painted-glyph proof when a synthetic loud-colour mask cannot be captured.
 * Compare the same Chromium viewport with and without the text. Unlike a
 * rectangle probe, only pixels actually moving TOWARD the element's computed
 * foreground count as glyph ink. No glyph, no contrast attestation; retain RED.
 * The caller must still preserve the foreground-overlay negative control.
 */
export function worstOverVisibleGlyphPixels(hidden, shown, clip, rects, fg) {
  if (!hidden || !shown || hidden.w !== shown.w || hidden.h !== shown.h) return null;
  const difference = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const ink = [];
  for (const [x, y, w, h] of rects) {
    const x0 = Math.max(0, Math.floor(x - clip.x)), y0 = Math.max(0, Math.floor(y - clip.y));
    const x1 = Math.min(hidden.w, Math.ceil(x + w - clip.x)), y1 = Math.min(hidden.h, Math.ceil(y + h - clip.y));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
      const bg = hidden.px(px, py), displayed = shown.px(px, py);
      const target = overPx(fg, bg), span = difference(target, bg);
      // A white-on-white label does not magically become readable. Changes
      // inconsistent with this holder's computed foreground are not glyphs.
      if (span < 60 || difference(displayed, bg) < Math.max(32, span * 0.35) ||
          difference(displayed, target) > span * 0.60) continue;
      ink.push({ ratio: ratioOf(target, bg), background: bg, text: target });
    }
  }
  if (!ink.length) return null;
  ink.sort((a, b) => a.ratio - b.ratio);
  return ink[Math.min(ink.length - 1, Math.floor(ink.length * 0.03))];
}

const clipOf = (rects) => {
  let r = rects;
  const box = (l) => { const x0 = Math.min(...l.map((q) => q[0])), y0 = Math.min(...l.map((q) => q[1])), x1 = Math.max(...l.map((q) => q[0] + q[2])), y1 = Math.max(...l.map((q) => q[1] + q[3])); return { x: Math.max(0, Math.floor(x0)), y: Math.max(0, Math.floor(y0)), width: Math.max(1, Math.ceil(x1) - Math.max(0, Math.floor(x0))), height: Math.max(1, Math.ceil(y1) - Math.max(0, Math.floor(y0))) }; };
  let b = box(r);
  if (b.width > 2400 || b.height > 3000) { r = [rects[0]]; b = box(r); b.width = Math.min(b.width, 2400); b.height = Math.min(b.height, 3000); }
  return { clip: b, rects: r };
};

/** A PNG of a region, straight from the protocol (a viewport region as it is, or a page region beyond the viewport): the fast path a pixel read per pair needs. */
const shoot = async (cdp, clip, full) => Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 }, captureBeyondViewport: full, fromSurface: true })).data, "base64");
/** The actual visible viewport: no CDP clip. Chromium interprets clip coordinates as DOCUMENT offsets even with captureBeyondViewport:false (verified on a scrolled page); adding a viewport-space clip would capture unrelated white canvas pixels. */
const shootViewport = async (cdp) => Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true })).data, "base64");
const SHARDS = 3;
const LOUD = `hsl(${300} 100% 50%)`;   // a colour no page background is, to find where a pseudo-element's glyphs are
const programSource = program.toString();
const NO_MOTION = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}.reveal{opacity:1!important;transform:none!important}";
const BLANK = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><div id="qa-host"></div></body></html>`;
const RELEVANT = "^(color|background|background-color|background-image|opacity|-webkit-text-fill-color|--[\\w-]+)$";

/** The problem of a page that crashed or threw an uncaught error: it names the page (where) and what happened (note). */
const faultProblem = (f, scheme, viewport) => ({ kind: "console", file: "", line: 0, selector: "(page)", state: "page fault", tone: "", where: f.url, scheme, viewport, viewports: [viewport], fg: "", bg: "", ratio: 0, need: 0, note: faultMessage(f) });

export async function themeQa({ sheets, playwright, chromium, pages = [], allow = [], schemes = ["light", "dark"], viewports = [[1280, 800], [390, 844]], fills = FILLS, only = null, bounds, log = () => {} }) {
  const notes = [], problems = [], unbuilt = new Map(), skipped = new Map(), placed = new Map(), measuredAny = new Set(), measureErrors = new Map();   // unbuilt, skipped, measuredAny: by the concrete selector that was built; placed: by the selector as written
  const css = sheets.map((s) => s.text).join("\n");
  const browser = await launchGuarded(playwright, { ...(chromium ? { executablePath: chromium } : {}), args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--no-proxy-server"] }, "theme-qa", bounds);
  const origin = new Map();
  const concrete = new Map();   // concrete selector → the selector as the sheet wrote it (:is() and :where() are built branch by branch)
  for (const r of sheets.flatMap((s) => selectorLines(s.text, s.file).map((x) => ({ ...x, file: s.file })))) for (const sel of splitTop(r.selector)) if (!origin.has(sel)) origin.set(sel, { file: r.file, line: r.line });
  const declared = {};   // selector → { on: the surface role, in: the container selector } an allow entry says it is used on / in
  allow.forEach((e) => { if (e.category === "contrast" && (e.on || e.in)) declared[e.match] = { on: e.on || "", in: e.in || "" }; });
  try {
    // the rules, read once: they do not depend on the viewport or the scheme
    const first = await browser.newContext({ viewport: { width: viewports[0][0], height: viewports[0][1] }, bypassCSP: true });
    const meta = await first.newPage();
    await meta.setContent(BLANK);
    for (const s of sheets) await meta.addStyleTag({ content: s.text });
    const rules = await meta.evaluate(([relevantSrc]) => {
      const re = new RegExp(relevantSrc), out = [];
      const walk = (list, parents, media) => {
        for (const r of list) {
          if (r.type === 1) {
            const props = [...r.style].filter((p) => re.test(p));
            out.push({ sel: r.selectorText, parents, media, relevant: props.length > 0, toned: /var\(\s*--(?:on-)?c\s*[,)]/.test(r.style.cssText), sized: [...r.style].some((p) => /^(width|height|min-width|min-height|aspect-ratio|inline-size|block-size)$/.test(p)) });
            if (r.cssRules && r.cssRules.length) walk(r.cssRules, [...parents, r.selectorText], media);
          } else if (r.cssRules && r.type !== 7) walk(r.cssRules, parents, r.type === 4 ? [...media, r.conditionText || (r.media && r.media.mediaText) || ""] : media);
        }
      };
      for (const sh of document.styleSheets) { try { walk(sh.cssRules, [], []); } catch { /* a cross-origin sheet's rules cannot be read by design; the page's own computed styles are what is measured */ } }
      return out;
    }, [RELEVANT]);
    await first.close();
    const subjects = new Set(), toned = new Set(), sized = new Set(), inMedia = new Set(), conditions = new Set(), everySelector = [];
    for (const r of rules) {
      let up = [];
      for (const p of r.parents) up = expandNested(up, splitTop(p));   // nested CSS: each level is relative to the one above (& or a descendant)
      const flat = expandNested(up, splitTop(r.sel));
      everySelector.push(...flat);
      const widthy = r.media.filter((m) => /width|height|orientation|aspect|resolution/.test(m));
      for (const m of widthy) conditions.add(m);
      for (const s of flat) { if (r.relevant) { subjects.add(s); if (widthy.length) inMedia.add(s); } if (r.toned) toned.add(s); if (r.sized) sized.add(s); }
    }
    // the viewports: the ones asked for, and the breakpoints of the media rules (the breakpoint and the pixel on the other side of it)
    const heightOf = viewports[0][1];
    const asked = new Set(viewports.map(([w]) => w));
    const widest = Math.max(...asked);
    const derived = breakpointsOf([...conditions]).filter((w) => !asked.has(w)).slice(0, 24);
    const allViewports = [...viewports, ...derived.map((w) => [w, heightOf])].sort((a, b) => (b[0] === widest) - (a[0] === widest));   // the widest first: it measures everything and tells which page shows each selector
    const homes = new Map();   // selector → the page that showed it at the widest viewport: the narrower ones go straight to it
    if (derived.length) notes.push(`media breakpoints measured: ${derived.join(", ")}`);
    // the dark theme: prefers-color-scheme, and the hooks the CSS reacts to on <html> or <body>
    const hooks = darkHooks(everySelector);
    const prefersDark = /prefers-color-scheme:\s*dark/i.test(css);
    const hasDark = prefersDark || hooks.length > 0;
    // :is() / :where() are built branch by branch; a concrete selector reports under the selector the sheet wrote
    for (const s of subjects) {
      if (/^(:root|html)$/.test(s.trim())) continue;
      const { branches, unbuilt: why } = expandBranches(s);
      if (why) { unbuilt.set(s, why); continue; }
      for (const b of branches) if (!concrete.has(b)) concrete.set(b, s);
    }
    for (const [c, o] of concrete) if (declared[o] && !declared[c]) declared[c] = declared[o];
    const strip = (list) => [...list].map((s) => s.replace(/::?(before|after|placeholder|selection|marker|first-line|first-letter)\b/g, "")).filter(Boolean);
    for (const scheme of schemes) {
      if (scheme === "dark" && !hasDark) continue;
      let hookNote = "", hookChanged = false;
      for (const [w, h] of allViewports) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, bypassCSP: true, reducedMotion: "reduce", deviceScaleFactor: 1 });
        const faultsFrom = browser.faults.length;
        const mroles = await ctx.newPage();
        await mroles.setContent(BLANK);
        for (const s of sheets) await mroles.addStyleTag({ content: s.text });
        const roles = await mroles.evaluate((names) => { const cs = getComputedStyle(document.documentElement); return names.map(([n, k]) => ({ name: n, fill: `--c-${k}`, on: cs.getPropertyValue(`--c-on-${k}`).trim() ? `--c-on-${k}` : "", has: !!cs.getPropertyValue(`--c-${k}`).trim() })).filter((r) => r.has); }, fills.map((n) => [n, kebab(n)]));
        await mroles.close();
        // the widest viewport measures every selector; the others (asked for and derived) the selectors a media rule can change
        const todoAll = [...concrete.keys()].filter((s) => (w === widest || inMedia.has(concrete.get(s))) && (!only || only.test(concrete.get(s))));
        const settled = new Set();   // selectors measured (or shown to carry no text) in this scheme and width
        const realNoText = new Set(), hidden = new Set();
        const record = (sel, state, tone, item, where, extra = {}) => {
          const need = item.size >= 24 || (item.size >= 18.66 && item.bold) ? 3 : 4.5;
          if (item.ratio < need - 1e-9) {
            const orig = concrete.get(sel) || sel;
            const o = origin.get(orig) || origin.get(orig.replace(/\s+/g, " ")) || {};
            problems.push({ kind: "contrast", file: o.file || "", line: o.line || 0, selector: orig, state, tone, where, scheme, viewport: `${w}x${h}`, fg: hex(item.fg), bg: hex(item.bg), ratio: Math.round(item.ratio * 100) / 100, need, ...(item.note ? { note: item.note } : {}), ...extra });
          }
        };
        /** One selector: build it, force its states, measure it (on every fill when it reads the tone), and judge the painted pixels. Returns "unmounted" when the page does not show it. */
        const one = async (page, cdp, sel, mode, show) => {
          const first = await page.evaluate(([s, md, dc, sh]) => window.__qa.start(s, md, dc, sh), [sel, mode, declared[sel], show]);
          const b = first.b;
          if (!b.ok) {
            if (b.unmounted) return "unmounted";
            // an error building it IN ITS REAL PAGE is a finding of its own: the neutral page may retry the selector, but what it measures never clears it (the real context is where it can fail)
            if (b.error && !measureErrors.has(sel)) measureErrors.set(sel, b.unbuilt);
            unbuilt.set(sel, b.unbuilt); return "unbuilt";
          }
          const forced = [];
          if (b.hasForce) {
            const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
            const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-qa-force]" });
            for (const nodeId of nodeIds) {
              const { attributes } = await cdp.send("DOM.getAttributes", { nodeId });
              const f = (attributes[attributes.indexOf("data-qa-force") + 1] || "").split(" ").filter(Boolean);
              await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: f }); forced.push(nodeId);
            }
          }
          const state = [b.pe ? `::${b.pe}` : "", ...(b.states || []).map((x) => `:${x}`)].filter(Boolean).join(" ") || "base";
          let measured = false, noText = false, reason = "", benign = true, errored = "";
          for (const tone of b.toneable && roles.length ? roles : [null]) {
            // A synthetic forced ARIA state can repaint between the synchronous
          // build+measure fast path and the CDP screenshot. For such selectors
          // only, wait for the real browser paint then measure from the SAME
          // state as the screenshot. Never reinterpret a genuine low-contrast
          // result as a pass; the pixel gate remains authoritative.
          const stateNeedsPaint = sel.includes("[aria-current");
          // Wait from the test runner, NOT through renderer rAF / setTimeout:
          // Chromium throttles both in hidden tabs and can hang a full visual
          // gate waiting for a frame that never arrives. A short host-side
          // bounded wait lets the forced ARIA state settle before remeasuring.
          // The CDP screenshot and every WCAG negative control remain mandatory.
          if (stateNeedsPaint) await page.waitForTimeout(70);
          const m = stateNeedsPaint
            ? await page.evaluate(([t, pe, tn]) => window.__qa.measureCase(t, pe, tn), [b.token, b.pe, tone])
            : first.m || await page.evaluate(([t, pe, tn]) => window.__qa.measureCase(t, pe, tn), [b.token, b.pe, tone]);
            if (m.error) { errored = errored || m.error; continue; }
            if (m.skip) { if (!reason) { reason = m.skip; benign = m.benign; noText = !!m.noText; } continue; }
            measured = true;
            for (const [mi, item] of m.items.entries()) {
              // page coordinates, at the scroll the holder was measured at: a sticky bar is where it really is there
              let live = item.rects;
              try { const f = await page.evaluate((i) => window.__qa.focusItem(i), mi); if (f && f.length) live = f; } catch { /* the page moved on */ }   // scrolled to this line: the pixels are those of the view the user has
              const { clip, rects } = clipOf(live), full = true;
              let png = null, fillPng = null, pseudoHit = null;
              try {
                if (item.pe) {   // a pseudo-element has no box to ask for: its glyphs are where the shot with its text shown differs from the hidden one, and what is behind them is the hidden shot there
                  const pad = 96, h0 = live[0];
                  const reg = { x: Math.max(0, Math.floor(h0[0] - pad)), y: Math.max(0, Math.floor(h0[1] - pad)), width: Math.min(900, Math.ceil(h0[2] + 2 * pad)), height: Math.min(600, Math.ceil(h0[3] + 2 * pad)) };
                  const A = decodePng(await shoot(cdp, reg, full));
                  await page.evaluate(([pe, c]) => window.__qa.showPseudoText(pe, c), [b.pe, LOUD]);
                  const C = decodePng(await shoot(cdp, reg, full));
                  await page.evaluate(() => window.__qa.hide("backdrop"));
                  const W = Math.min(A.w, C.w), H = Math.min(A.h, C.h), all = [];
                  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = A.px(x, y), c = C.px(x, y); if (Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]) > 40) all.push({ ratio: ratioOf(overPx(item.fg, a), a), background: a, text: overPx(item.fg, a) }); }
                  if (all.length) { all.sort((p, q) => p.ratio - q.ratio); pseudoHit = all[Math.min(all.length - 1, Math.floor(all.length * 0.03))]; }
                  else continue;   // the pseudo-element paints no text there
                }
                const shot = await shoot(cdp, clip, full);
                png = decodePng(shot);
                if (item.clip) { await page.evaluate(() => window.__qa.hide("fill")); fillPng = decodePng(await shoot(cdp, clip, full)); await page.evaluate(() => window.__qa.hide("backdrop")); }
              } catch { notes.push(`${sel}: the pixels behind the text could not be read, the ancestors' colours are used`); }
              let worst = pseudoHit || (png && worstOverRects(png, clip, rects, item.fg, fillPng));
              // A rectangle extends beyond letterforms, especially over active
              // pills and absolutely positioned badges. Re-read failures on
              // painted glyph pixels. Missing proof keeps the finding RED.
              const need = item.size >= 24 || (item.size >= 18.66 && item.bold) ? 3 : 4.5;
              if (png && worst && worst.ratio < need && !item.pe && !item.clip) {
                try {
                  const inkShown = await page.evaluate(([i, c]) => window.__qa.showItemText(i, c), [mi, LOUD]);
                  if (inkShown) {
                    const glyphs = decodePng(await shoot(cdp, clip, full));
                    let verified = worstOverGlyphPixels(png, glyphs, clip, rects, item.fg);
                    if (!verified) {
                      // The synthetic magenta mask may not paint for a forced
                      // ARIA/descendant state. Read genuine glyph ink instead.
                      // Both screenshots use the SAME source selector, viewport
                      // and clip. A missing or obscured glyph remains a failure.
                      await page.evaluate(() => window.__qa.showOriginalText());
                      await page.waitForTimeout(70); // host-side, bounded Chromium paint settlement
                      const original = decodePng(await shoot(cdp, clip, full));
                      verified = worstOverVisibleGlyphPixels(png, original, clip, rects, item.fg);
                      if (!verified) {
                        // Evidence mismatch can be a DOCUMENT/VIEWPORT clip
                        // disagreement when the target lives below the fold.
                        // Independently re-focus it and recapture the same
                        // physically visible glyph with viewport coordinates.
                        // This is NOT a DOM-colour waiver: if the target cannot
                        // paint real magenta or its own native foreground pixels,
                        // it still fails WCAG. A truly white-on-white label
                        // cannot pass either branch.
                        const viewportRects = await page.evaluate((i) => window.__qa.viewportItem(i), mi);
                        if (viewportRects) {
                          await page.evaluate(() => window.__qa.hide("backdrop"));
                          await page.waitForTimeout(70);
                          const hiddenViewport = decodePng(await shootViewport(cdp));
                          const visibleClip = { x: 0, y: 0 };
                          const exposed = await page.evaluate(([i, c]) => window.__qa.showItemText(i, c), [mi, LOUD]);
                          if (exposed) {
                            await page.waitForTimeout(70);
                            const loudViewport = decodePng(await shootViewport(cdp));
                            verified = worstOverGlyphPixels(hiddenViewport, loudViewport, visibleClip, viewportRects, item.fg);
                            if (!verified) {
                              await page.evaluate(() => window.__qa.showOriginalText());
                              await page.waitForTimeout(70);
                              const originalViewport = decodePng(await shootViewport(cdp));
                              verified = worstOverVisibleGlyphPixels(hiddenViewport, originalViewport, visibleClip, viewportRects, item.fg);
                            }
                          }
                        }
                      }
                      await page.evaluate(() => window.__qa.hide("backdrop"));
                    }
                    if (verified) {
                      // A visible glyph elsewhere in a text box must not
                      // invalidate a failing pixel obscured by a foreground
                      // absolute/fixed overlay. That was the regression caught
                      // by the narrowOverlay Chromium negative control.
                      const covered = worst.sample && await page.evaluate(
                        ([i, xy]) => window.__qa.coveredByPositionedOverlay(i, xy[0], xy[1]),
                        [mi, worst.sample]);
                      // Evidence-first: an ancestor-computed colour and a screenshot
                      // may disagree. Preserve the original failing sample when
                      // obscured; give CI the precise reason why a valid glyph
                      // recheck was refused instead of repeating blind patches.
                      if (ratioOf(overPx(item.fg, item.domBg), item.domBg) >= need &&
                          worst.ratio < need) {
                        notes.push(`glyph-probe ${sel} [${state}]: rect=${worst.ratio.toFixed(2)} glyph=${verified.ratio.toFixed(2)} covered=${Boolean(covered)} rect-bg=${hex(worst.background)} glyph-bg=${hex(verified.background)} dom-bg=${hex(item.domBg)}`);
                      }
                      if (!covered) worst = verified;
                    } else if (ratioOf(overPx(item.fg, item.domBg), item.domBg) >= need &&
                               worst.ratio < need) {
                      notes.push(`glyph-probe ${sel} [${state}]: rectangle fails, DOM passes, no reliable glyph pixel proof`);
                    }
                  }
                } catch (e) {
                  notes.push(`${sel}: precise glyph contrast failed (${String(e.message).slice(0, 90)}), original failing pixel proof retained`);
                } finally {
                  await page.evaluate(() => window.__qa.hide("backdrop")).catch(() => { /* Best-effort cleanup: the page may have closed; the original measurement failure is retained. */ });
                }
              }
              const dom = overPx(item.fg, item.domBg);
              let out;
              if (worst) {
                const domRatio = item.clip ? null : ratioOf(dom, item.domBg);
                out = { size: item.size, bold: item.bold, ratio: worst.ratio, fg: worst.text, bg: worst.background, note: domRatio !== null && Math.abs(domRatio - worst.ratio) > 1.5 ? `painted background differs from the ancestors' (overlay, ::before/::after or a positioned sibling): ${hex(worst.background)} painted, ${hex(item.domBg)} by the ancestors` : item.clip ? "text painted by a clipped gradient" : "" };
              } else if (item.clip) { reason = "a gradient-clipped text could not be sampled"; benign = false; continue; }
              else out = { size: item.size, bold: item.bold, ratio: ratioOf(dom, item.domBg), fg: dom, bg: item.domBg, note: "measured from the ancestors' colours: no pixels" };
              record(sel, state, tone ? tone.name : "", out, b.where);
            }
          }
          for (const nodeId of forced) { try { await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }); } catch { /* the node left the page with its case: nothing is left to un-force */ } }
          if (errored) measureErrors.set(sel, errored);   // the browser rejected something while measuring: a finding, whatever else was measured
          const orig = concrete.get(sel) || sel;
          if (measured) { settled.add(sel); measuredAny.add(sel); placed.set(orig, (placed.get(orig) || 0) + 1); skipped.delete(sel); }
          else {
            if (!measuredAny.has(sel)) skipped.set(sel, { reason, benign });
            if (benign && mode === "page") realNoText.add(sel);   // a real element with no text, a pseudo-element without content: no pair (and not retried in the neutral page)
            else if (benign) settled.add(sel);
            else hidden.add(sel);
          }
          return measured ? "measured" : "skipped";
        };
        const open = async (url) => {
          const page = await ctx.newPage();
          if (url) {
            await page.goto(url, { waitUntil: "load" });
            // settled = fonts loaded, as a bounded poll (the default timeout), not a fixed 150 ms a busy machine can outrun
            await page.waitForFunction(() => document.readyState === "complete" && (!document.fonts || document.fonts.status === "loaded"), null, { polling: "raf" });
          }
          else { await page.setContent(BLANK); for (const s of sheets) await page.addStyleTag({ content: s.text }); }
          await page.addStyleTag({ content: NO_MOTION + "*{pointer-events:auto!important}" });   // an overlay with pointer-events:none still paints: it must be seen by the stack at a text line
          await page.evaluate(`window.__qa = (${programSource})()`);
          await page.evaluate(([d, z]) => { window.__toned = d; window.__sized = z; }, [strip(toned), strip(sized)]);
          const cdp = await ctx.newCDPSession(page);
          await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
          if (scheme === "dark" && hooks.length) {
            const r = await page.evaluate((hk) => window.__qa.applyHooks(hk), hooks);
            if (r.changed) hookChanged = true;
          }
          return { page, cdp };
        };
        /** The selectors of one document, shared by SHARDS pages of it that run at once (each has its own DOM, its own protocol session): the pixel reads are the cost, and they overlap. */
        const sharded = async (url, list, mode, show, done) => {
          const parts = Array.from({ length: Math.min(SHARDS, Math.max(1, Math.ceil(list.length / 40))) }, () => []);
          list.forEach((x, i) => parts[i % parts.length].push(x));
          await Promise.all(parts.map(async (part) => {
            const { page, cdp } = await open(url);
            for (const sel of part) done(sel, await one(page, cdp, sel, mode, show));
            try { await page.evaluate(() => window.__qa.undo()); } catch { /* the page already closed itself: there is nothing left to undo */ }
            await page.close();
          }));
        };
        // 1. the real pages: the selector's elements, in the context they are really in
        let remaining = todoAll;
        const plan = w === widest ? pages.map((u) => [u, null]) : [...new Set(todoAll.map((x) => homes.get(x)).filter(Boolean))].map((u) => [u, todoAll.filter((x) => homes.get(x) === u)]);
        for (const [url, only] of plan) {
          if (!remaining.length) break;
          const list = only ? remaining.filter((x) => only.includes(x)) : remaining;
          if (!list.length) continue;
          let n = 0;
          await sharded(url, list, "page", false, (sel, r) => { if (r === "measured" && w === widest) homes.set(sel, url); if (++n % 250 === 0) log(`  theme ${scheme} ${w}x${h}: ${n}/${list.length} on ${url}`); });
          remaining = remaining.filter((s) => !settled.has(s));
        }
        // a selector the pages show with no text at all is no pair; the rest, and what no page shows, is built in the neutral page
        const rest = remaining.filter((s) => !realNoText.has(s) || hidden.has(s));
        // 2. what no page shows (or showed hidden): a synthetic chain in the neutral page, display forced on (a declared surface, or the page background)
        let n2 = 0;
        await sharded(null, rest, "harness", true, () => { if (++n2 % 250 === 0) log(`  theme ${scheme} ${w}x${h}: ${n2}/${rest.length} in the neutral page`); });
        log(`theme ${scheme} ${w}x${h}: ${todoAll.length - rest.length} selectors on real pages, ${rest.length} in the neutral page`);
        // a crash or an uncaught error of a page is a failure even when nothing later threw (browser-guard.js collects them)
        for (const f of faultsSince(browser, faultsFrom)) problems.push(faultProblem(f, scheme, `${w}x${h}`));
        await ctx.close();
      }
      if (hooks.length && scheme === "dark" && !hookChanged) hookNote = `dark hook not exercised: ${hooks.map((x) => x.text).join(", ")} changed no colour (no --c-* role, no page colour) when set on the page`;
      if (hookNote) problems.push({ kind: "unmeasured", file: "", line: 0, selector: "(dark theme)", state: "not measured", tone: "", where: "dark pass", scheme, viewport: "-", viewports: ["-"], fg: "", bg: "", ratio: 0, need: 0, note: hookNote });
    }
  } finally { await browser.close(); }
  for (const f of faultsSince(browser)) problems.push(faultProblem(f, "light", "-"));   // a fault of no viewport (never silent)
  // a selector that was never measured is a failure of its own, unless an entry covers it (state "not measured")
  const unmeasured = (c, reason) => { const selector = concrete.get(c) || c, o = origin.get(selector) || {}; problems.push({ kind: "unmeasured", file: o.file || "", line: o.line || 0, selector, state: "not measured", tone: "", where: "page", scheme: "light", viewport: "-", viewports: ["-"], fg: "", bg: "", ratio: 0, need: 0, note: reason }); };
  for (const [c, reason] of unbuilt) if (!measuredAny.has(c) && !measureErrors.has(c)) unmeasured(c, reason);
  for (const [c, reason] of measureErrors) unmeasured(c, reason);
  for (const [c, s] of skipped) if (!s.benign && !measuredAny.has(c)) unmeasured(c, s.reason);
  const seen = new Map();
  for (const p of problems) { if (p.viewports) { seen.set(`${p.file}|${p.selector}|${p.state}|${p.scheme}|${p.note}`, p); continue; } const k = `${p.file}|${p.selector}|${p.state}|${p.tone}|${p.scheme}|${p.fg}|${p.bg}`; if (!seen.has(k)) seen.set(k, { ...p, viewports: [p.viewport] }); else seen.get(k).viewports.push(p.viewport); }
  const kept = [], used = new Set();
  for (const p of seen.values()) {
    const i = allow.findIndex((e) => e.category === "contrast" && !e.on && !e.in && e.match === p.selector && sameSheet(e.file, p.file) && contextMatches(e, p));
    if (i >= 0) used.add(i); else kept.push(p);
  }
  // a declared surface is used when its selector was measured; an entry for a selector nothing builds is stale
  allow.forEach((e, i) => { if (e.category === "contrast" && (e.on || e.in) && placed.has(e.match)) used.add(i); });
  const stale = allow.filter((e, i) => e.category === "contrast" && !used.has(i));
  return {
    problems: kept, stale,
    unbuilt: [...unbuilt].filter(([s]) => !measuredAny.has(s)).map(([c, reason]) => ({ selector: concrete.get(c) || c, reason })),
    skipped: [...skipped].filter(([s]) => !measuredAny.has(s)).map(([c, v]) => ({ selector: concrete.get(c) || c, reason: v.reason, benign: v.benign })),
    placed: placed.size, placedSelectors: [...placed.keys()], notes,
  };
}
