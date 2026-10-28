/**
 * Safe autofix of a raw source region (`kit persian fix --write`): only the text is ever rewritten.
 *
 *   safeFix(raw, linter, { register, arabic }) → { text, changed, refused?: reason }
 *
 * Before fixing, everything that is not prose is masked with opaque placeholders: script, style, pre and code blocks, HTML
 * tags, Markdown links and images (the whole target, parentheses balanced), autolinks and URLs, file paths (a path may
 * contain a space: «/img/فارسی ها.png»), code spans, ${…} expressions and backslash escapes. The fix runs on the masked text;
 * afterwards the placeholders must come back exactly once each, in order, and the skeleton (the source minus its text) must
 * be byte-identical to the original: the masked spans, and a second, independent check that every «](» to the end of its line
 * is unchanged. Otherwise nothing is written for this region and the reason is returned.
 */
const MASKS = [
  /<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi,
  /<!--[\s\S]*?-->/g,
  /<[a-zA-Z/!][^<>]*>/g,
  /<https?:\/\/[^>\s]+>/g,
  /\bhttps?:\/\/[^\s<>"'«»)]+/g,
  /(?:^|(?<=[\s"'(=«]))\.{0,2}\/[^\n"'<>()«»]*?\.(?:png|jpe?g|gif|svg|webp|avif|ico|mp3|m4a|wav|pdf|html?|json|md|css|js|mjs|txt|xml|csv)\b/gi,
  /\$\{[^}]*\}/g,
  /`[^`\n]*`/g,
  /\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g,
];
const OPEN = "", CLOSE = "";
const tag = (i) => `${OPEN}${String.fromCharCode(0xE100 + i)}${CLOSE}`;
const TAG = new RegExp(`${OPEN}([\\uE100-\\uEFFF])${CLOSE}`, "g");

/**
 * Markdown link and image targets with balanced parentheses: «[x](/a/(b) ها/می رود.png)» is one span, «![alt](/img/a (1).png)»
 * too (the image from its «!»). A target that never closes runs to the end of the line.
 */
function maskLinks(text, spans) {
  let out = "", at = 0;
  const re = /(!?)\[[^\]\n]*\]\(/g;
  for (let m; (m = re.exec(text)); ) {
    if (m.index < at) continue;
    let i = m.index + m[0].length, depth = 1;
    while (i < text.length && text[i] !== "\n") {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) { i++; break; }
      i++;
    }
    i = Math.min(i, text.length);
    const start = m[1] ? m.index : m.index + m[0].indexOf("](");
    spans.push(text.slice(start, i));
    out += text.slice(at, start) + tag(spans.length - 1);
    at = i;
    re.lastIndex = i;
  }
  return out + text.slice(at);
}

/** Mask the non-prose spans of a region: { text, spans }. */
export function mask(raw) {
  const spans = [];
  let text = maskLinks(String(raw), spans);
  for (const re of MASKS) {
    text = text.replace(re, (m) => {
      if (m.includes(OPEN)) return m; // already inside a mask
      spans.push(m);
      return tag(spans.length - 1);
    });
  }
  return { text, spans };
}

/** Put the spans back; null when a placeholder is missing, repeated or out of order. */
export function unmask(text, spans) {
  const seen = [];
  const out = text.replace(TAG, (_, c) => { const i = c.charCodeAt(0) - 0xE100; seen.push(i); return spans[i] ?? "\u0000"; });
  if (seen.length !== spans.length || out.includes("\u0000")) return null;
  if ([...seen].sort((a, b) => a - b).some((v, i) => v !== i)) return null;
  return out;
}

/** The masked skeleton of a region: its spans in source order (what must survive a fix byte for byte). */
const skeleton = (raw) => { const { text, spans } = mask(raw); return [...text.matchAll(TAG)].map((m) => spans[m[1].charCodeAt(0) - 0xE100]); };
/** An independent skeleton: every «](» to the end of its line, whatever the masks decided. */
const linkTails = (raw) => [...String(raw).matchAll(/\]\([^\n]*/g)].map((m) => m[0]);

export function safeFix(raw, linter, opts = {}) {
  const { text, spans } = mask(raw);
  const fixed = linter.fix(text, opts);
  if (fixed === text) return { text: raw, changed: false };
  const out = unmask(fixed, spans);
  if (out == null) return { text: raw, changed: false, refused: "a masked span (markup, URL, path, code) was lost or duplicated by the fix" };
  const a = skeleton(raw), b = skeleton(out);
  if (a.length !== b.length || a.some((s, i) => s !== b[i])) return { text: raw, changed: false, refused: "the source minus its text would change (markup, URL, path or code)" };
  // second check: a link target «](…» to the end of the line is opaque, even where the balanced mask guessed wrong
  const ta = linkTails(raw), tb = linkTails(out);
  if (ta.length !== tb.length || ta.some((x, k) => !sameTail(x, tb[k]))) return { text: raw, changed: false, refused: "a link target («](…» to the end of the line) would change" };
  return { text: out, changed: out !== raw };
}

// the tail after «](» may legitimately differ only in the prose that follows the closing parenthesis: compare up to it
const sameTail = (a, b) => { const cut = (s) => { let d = 1, i = 2; for (; i < s.length; i++) { if (s[i] === "\\") { i++; continue; } if (s[i] === "(") d++; else if (s[i] === ")" && --d === 0) { i++; break; } } return s.slice(0, i); }; return cut(a) === cut(b); };
