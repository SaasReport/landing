/**
 * localizeHtml(html, locale): rendered HTML (or SVG) with the locale's digits in what readers see, by the same rules
 * the checker (scan.js) applies: text nodes and the reader attributes (aria-label, alt, title, placeholder, …) are
 * localized; <code>, <pre>, <kbd>, <samp>, <script>, <style>, elements marked data-digits="latin", every other
 * attribute (href, src, datetime, data-*), URLs, e-mails, Latin identifiers and character references stay as they are.
 *
 * For renderers that assemble HTML from data in one place (widgets, the site renderer): format numbers with
 * formatNumber() where they are produced, and run the finished fa fragment through localizeHtml() once.
 */
import { localizeText, PERSIAN_LETTER } from "./text.js";
import { digitSetOf } from "./index.js";

const EXEMPT = new Set(["code", "pre", "kbd", "samp"]);
const RAW = new Set(["script", "style"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
export const READER_ATTRS = new Set(["aria-label", "aria-description", "aria-valuetext", "aria-roledescription", "alt", "title", "placeholder", "label"]);
/** <meta name|property> whose content readers see (search results, link previews). */
export const META_CONTENT = /^(?:description|og:title|og:description|og:image:alt|og:site_name|twitter:title|twitter:description|twitter:image:alt)$/i;
/** JSON-LD keys whose Persian values readers see (rich results). */
export const LD_KEYS = new Set(["name", "alternateName", "headline", "alternativeHeadline", "description", "disambiguatingDescription", "text", "caption", "abstract", "articleBody", "slogan"]);
/** JSON-LD source with the Persian reader-facing string values localized (escapes such as \u003c are identifiers). */
const localizeLd = (json, locale) => json.replace(/"([A-Za-z]+)"(\s*:\s*)"((?:\\.|[^"\\])*)"/g, (all, k, colon, v) =>
  (LD_KEYS.has(k) && PERSIAN_LETTER.test(v) ? `"${k}"${colon}"${localizeText(v, locale)}"` : all));

/** Prose with character references (&#123; &amp;) left intact. */
const localizeRun = (s, locale) => s.split(/(&(?:#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);)/i).map((p, i) => (i % 2 ? p : localizeText(p, locale))).join("");

export function localizeHtml(html, locale = "en") {
  const s = String(html ?? "");
  if (digitSetOf(locale) === "latin") return s;
  const stack = [];
  const exempt = () => stack.some((e) => e.exempt);
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  let out = "", m;
  while ((m = re.exec(s))) {
    const tok = m[0];
    if (m[2] == null) { out += tok.startsWith("<") || exempt() ? tok : localizeRun(tok, locale); continue; }
    const tag = m[2].toLowerCase();
    if (m[1] === "/") { const i = stack.map((e) => e.tag).lastIndexOf(tag); if (i >= 0) stack.length = i; out += tok; continue; }
    const attrs = m[3] || "", selfClosing = /\/\s*$/.test(attrs);
    const marked = /\bdata-digits\s*=\s*["']?latin\b/i.test(attrs) && /\bdata-digits-reason\s*=\s*(["'])\s*[^"'\s]/i.test(attrs);
    const ex = marked || EXEMPT.has(tag) || exempt();
    const isMeta = tag === "meta" && META_CONTENT.test((attrs.match(/\b(?:name|property)\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "");
    out += ex ? tok : tok.replace(/([\s"'])([\w:-]+)(\s*=\s*)("([^"]*)"|'([^']*)')/g, (all, pre, name, eq, q, dq, sq) =>
      (READER_ATTRS.has(name.toLowerCase()) || (isMeta && name.toLowerCase() === "content") ? `${pre}${name}${eq}${q[0]}${localizeRun(dq ?? sq, locale)}${q[0]}` : all));
    if (RAW.has(tag) && !selfClosing) {
      const end = s.toLowerCase().indexOf(`</${tag}`, re.lastIndex), stop = end < 0 ? s.length : end;
      const body = s.slice(re.lastIndex, stop);
      out += tag === "script" && !ex && /type\s*=\s*["']?application\/ld\+json/i.test(attrs) ? localizeLd(body, locale) : body;
      re.lastIndex = stop; continue;
    }
    if (!VOID.has(tag) && !selfClosing) stack.push({ tag, exempt: marked || EXEMPT.has(tag) });
  }
  return out;
}
