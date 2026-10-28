/**
 * SVG triage: an SVG is a document with a script engine. Script elements, event handler attributes, foreignObject and other
 * embedding elements, external references (href, use, image, stylesheets, @import), script URLs, animation of an href, XML
 * entities and DTDs, and unquoted attribute values are all markers. SVG with no marker still never serves inline.
 *
 * The text goes through the one linear tokenizer (xml.js): entities decoded, CDATA unwrapped, namespaces resolved, once, before a
 * rule sees a name. Rules match on LOCAL names (a prefix is never trusted: s:script is script), on decoded values, and read CSS
 * through css.js. Markup the tokenizer could not close is "malformed_markup": needs_sandbox, never allowed.
 *
 *   triageSvg(bytes, limits) → triage result
 */
import { collector } from "./collector.js";
import { parseXml } from "../xml.js";
import { cssExternal } from "../css.js";
import { cleanUrl, isExternalUrl, isScriptUrl } from "../urls.js";
import { isAlpha, skipSpace, startsWithCI, runWhile, isSpace } from "../lex.js";

export const SVG_MARKERS = Object.freeze({
  script_element: "block", event_handler: "block", foreign_object: "block", embedding_element: "block", external_reference: "block", script_url: "block",
  animation_of_href: "block", xml_entities: "block", external_dtd: "block", xml_stylesheet: "block", unquoted_attribute: "block", malformed_markup: "needs_sandbox", not_text: "needs_sandbox", too_large: "needs_sandbox",
});
/** The only external DTDs an SVG may name: the W3C's own, by their public identifiers and their w3.org system literals. */
const W3C_SVG_PUBLIC = new Set(["-//W3C//DTD SVG 1.0//EN", "-//W3C//DTD SVG 1.1//EN", "-//W3C//DTD SVG 1.1 Basic//EN", "-//W3C//DTD SVG 1.1 Tiny//EN", "-//W3C//DTD SVG 20010904//EN", "-//W3C//DTD SVG 20000303 Stylable//EN"]);
function literalAt(s, i) {   // a quoted literal at i → { value, end } or null
  const q = s[i];
  if (q !== '"' && q !== "'") return null;
  const close = s.indexOf(q, i + 1);
  return close < 0 ? null : { value: s.slice(i + 1, close), end: close + 1 };
}
/** Does this declaration (the text after "<!") name an external DTD (SYSTEM, or PUBLIC with anything but the W3C's SVG identifiers)? */
export function externalDtd(decl) {
  if (!startsWithCI(decl, 0, "doctype")) return false;
  let i = skipSpace(decl, 7);
  i = runWhile(decl, i, (c) => !isSpace(c) && c !== 91 && c !== 62);   // the root name
  i = skipSpace(decl, i);
  if (startsWithCI(decl, i, "system")) return true;
  if (!startsWithCI(decl, i, "public")) return false;
  const pub = literalAt(decl, skipSpace(decl, i + 6));
  if (!pub) return true;
  const sys = literalAt(decl, skipSpace(decl, pub.end));
  return !(W3C_SVG_PUBLIC.has(pub.value) && sys && sys.value.startsWith("http://www.w3.org/Graphics/SVG/"));
}

const MAX_BYTES = 4 * 1024 * 1024;
const EMBEDDING = new Set(["iframe", "embed", "object", "applet", "frame", "frameset", "meta", "base"]);

const external = isExternalUrl;
const scriptUrl = isScriptUrl;
export const isHandlerName = (local) => { if (local.length < 3 || !local.startsWith("on")) return false; for (let i = 2; i < local.length; i++) if (!isAlpha(local.charCodeAt(i))) return false; return true; };

export function triageSvg(bytes) {
  const c = collector();
  if (bytes.length > MAX_BYTES) { c.add("too_large", "needs_sandbox", "could_not_check"); c.incomplete("svg over the inspection cap"); return c.finish(); }
  let text;
  try {
    const utf16 = bytes.length > 1 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
    text = new TextDecoder(utf16 ? (bytes[0] === 0xff ? "utf-16le" : "utf-16be") : "utf-8", { fatal: true }).decode(bytes);
  } catch { c.add("not_text", "needs_sandbox", "could_not_check"); c.incomplete("not valid text"); return c.finish(); }

  const { events, problems } = parseXml(text);
  let styleDepth = 0, css = "";
  for (const e of events) {
    if (e.t === "decl") { if (e.entity || e.internalSubset) c.add("xml_entities", "block"); if (externalDtd(e.value)) c.add("external_dtd", "block"); continue; }
    if (e.t === "pi") { if (e.target === "xml-stylesheet") c.add("xml_stylesheet", "block"); continue; }
    if (e.t === "text") { if (styleDepth > 0) css += e.value; continue; }
    if (e.t === "end") { if (e.name.local === "style" && styleDepth > 0) styleDepth--; continue; }
    if (e.t !== "start") continue;
    const tag = e.name.local;
    if (tag === "script") c.add("script_element", "block");
    else if (tag === "foreignobject") c.add("foreign_object", "block");
    else if (EMBEDDING.has(tag)) c.add("embedding_element", "block", "active_content_found", tag);
    else if (tag === "link") c.add("external_reference", "block", "active_content_found", "link");
    else if (tag === "style") { if (!e.selfClosing) styleDepth++; }
    else if (tag === "set" || tag === "animate") {   // animating an href, or an event handler attribute, writes a script URL or a handler
      for (const a of e.attrs) if (a.local === "attributename") { const v = cleanUrl(a.value); const local = v.slice(v.lastIndexOf(":") + 1);
        if (local === "href" || isHandlerName(local)) c.add("animation_of_href", "block"); }
    }
    for (const a of e.attrs) {
      const v = a.value;
      if (isHandlerName(a.local)) c.add("event_handler", "block", "active_content_found", a.local);
      if (!a.quoted) c.add("unquoted_attribute", "block", "active_content_found", a.local);
      if (a.local === "href") {
        if (scriptUrl(cleanUrl(v)) || cleanUrl(v).startsWith("data:text/html")) c.add("script_url", "block", "active_content_found", a.local);
        else if (external(v)) c.add("external_reference", "block", "active_content_found", `${tag} ${a.local}`);
      } else if (scriptUrl(cleanUrl(v))) c.add("script_url", "block", "active_content_found", a.local);
      if (a.local !== "href" && cssExternal(v))   // every other attribute value is CSS value syntax to a browser: normalised first (escapes, comments), then the one classifier. No raw-text pre-check.
         c.add("external_reference", "block", "active_content_found", a.local === "style" ? "style attribute" : `${a.local} attribute`);   // a presentation attribute (fill, filter, mask ...) is CSS value syntax
    }
  }
  if (css && cssExternal(css)) c.add("external_reference", "block", "active_content_found", "style");
  if (problems.length) { c.add("malformed_markup", "needs_sandbox", "could_not_check", problems[0]); c.incomplete(`markup: ${problems[0]}`); }
  return c.finish();
}
