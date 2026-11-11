/**
 * Markdown twins of built pages (the docs format of llms.txt sites: every HTML page has the same content as Markdown).
 *
 *   htmlToMarkdown(html, { base }) → Markdown of an HTML fragment (headings, paragraphs, lists, links, tables, code, quotes)
 *   pageMarkdown(html, { url, site }) → { title, description, lang, markdown } of a whole page: front matter, then the
 *     page's <main> (or its <body> without header, nav and footer) as Markdown
 *   twinPath("terminal/index.html") → "terminal/index.md";  twinLink(href) → the <link rel="alternate" type="text/markdown">
 *   llmsIndex(site, twins) / llmsFullText(site, twins) → llms.txt / llms-full.txt listing the twins (static-only sites)
 *
 * Digits of Persian twins come from @saasreport/format. The parser is a small tolerant tree builder for the HTML the kit's templates produce. Anything inside
 * script, style, svg, template, noscript, iframe, canvas, dialog, select, textarea and input, [hidden], [aria-hidden="true"] or
 * [data-md="skip"] is left out (data-md="skip" is the author's opt-out for one element).
 */

import { LOCALE_DIGITS, digits } from "@saasreport/format";
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title", "xmp"]);
const SKIP = new Set(["script", "style", "noscript", "svg", "template", "iframe", "canvas", "dialog", "select", "textarea", "input", "option", "object", "video", "audio", "head", "link", "meta"]);
const AUTO_CLOSE = { li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr"], td: ["td", "th"], th: ["td", "th"], p: ["p"], option: ["option"] };
const BLOCK = new Set(["p", "div", "section", "article", "main", "aside", "header", "footer", "nav", "figure", "figcaption", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "address", "details", "summary", "fieldset", "legend", "form", "body", "html"]);

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rlm: "‏", lrm: "‎", zwnj: "‌", zwj: "‍", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", rarr: "→", larr: "←", times: "×" };
export const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; /* not a code point: the entity is kept as written */ } }
  return ENT[e.toLowerCase()] ?? m;
});

function attrs(src) {
  const out = {};
  for (const m of String(src).matchAll(/([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

/** HTML → a tree of { tag, attrs, children } and strings. Tolerant: stray closing tags are ignored, li/td/p close their siblings. */
export function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const s = String(html);
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) top().children.push(decode(s.slice(last, m.index)));
    last = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = stack.map((n) => n.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    if (!m[2]) continue; // comment, doctype
    const tag = m[2].toLowerCase();
    const node = { tag, attrs: attrs(m[3] || ""), children: [] };
    const closes = AUTO_CLOSE[tag];
    if (closes) {
      // close an open sibling of the same family, but never across a list or table boundary
      for (let i = stack.length - 1; i > 0; i--) {
        const t = stack[i].tag;
        if (closes.includes(t)) { stack.length = i; break; }
        if (["ul", "ol", "dl", "table", "tbody", "thead", "tfoot", "tr", "div", "section", "article"].includes(t)) break;
      }
    }
    top().children.push(node);
    if (RAW.has(tag)) {
      const end = s.toLowerCase().indexOf(`</${tag}`, last);
      const stop = end < 0 ? s.length : end;
      node.children.push(tag === "title" ? decode(s.slice(last, stop)) : s.slice(last, stop));
      const close = end < 0 ? s.length : s.indexOf(">", end) + 1;
      re.lastIndex = last = close;
      continue;
    }
    if (VOID.has(tag) || /\/\s*$/.test(m[3] || "")) continue;
    stack.push(node);
  }
  if (last < s.length) top().children.push(decode(s.slice(last)));
  return root;
}

const find = (node, pred) => {
  if (typeof node === "string") return null;
  if (pred(node)) return node;
  for (const c of node.children) { const r = find(c, pred); if (r) return r; }
  return null;
};
const textOf = (node) => (typeof node === "string" ? node : node.children.map(textOf).join(""));
const skipped = (n) => SKIP.has(n.tag) || "hidden" in n.attrs || n.attrs["aria-hidden"] === "true" || n.attrs["data-md"] === "skip"
  || (n.tag === "a" && n.attrs.class && /\bskip\b/.test(n.attrs.class));
const esc = (s) => s.replace(/([\\`*_[\]])/g, "\\$1");
const squash = (s) => s.replace(/[ \t\r\n\f]+/g, " ");

/**
 * Markdown of an HTML fragment or document. `base` (a site URL) makes relative links and images absolute;
 * in-page anchors (#…) and javascript: links keep only their text.
 */
export function htmlToMarkdown(html, { base, lang = "" } = {}) {
  // Persian twins: a number a reader sees is in Persian digits (CONSTITUTION.md §7). CommonMark ordered-list markers
  // need ASCII digits, so an ordered item becomes "- ۱. …" (still a list; the number in Persian), or "- …" when the
  // item already shows its own number.
  const local = LOCALE_DIGITS[String(lang).toLowerCase().split(/[-_]/)[0]] ? String(lang) : "";
  const tree = typeof html === "string" ? parseHtml(html) : html;
  const abs = (href) => {
    if (!href || /^(javascript|data):/i.test(href)) return null;
    if (href.startsWith("#")) return null;
    try { return base ? new URL(href, base).href : href; } catch { return href; /* not resolvable against the base: the link is kept as written */ }
  };

  // adjacent elements are laid out apart by CSS (badges, counters, labels): keep a space between them
  const joinInline = (nodes) => {
    let out = "", prevEl = false;
    for (const c of nodes) {
      const t = inline(c);
      if (!t) continue;
      const el = typeof c !== "string";
      if ((el || prevEl) && out && !/[\s(«"'\u200c]$/.test(out) && !/^[\s.,;:!?)\]،؛…»"'\u200c]/.test(t)) out += " ";
      out += t; prevEl = el;
    }
    return out;
  };

  function inline(n) {
    if (typeof n === "string") return esc(squash(n));
    if (skipped(n)) return "";
    const kids = () => joinInline(n.children);
    switch (n.tag) {
      case "br": return "\n";
      case "strong": case "b": { const t = kids().trim(); return t ? `**${t}**` : ""; }
      case "em": case "i": case "cite": { const t = kids().trim(); return t ? `_${t}_` : ""; }
      case "code": case "kbd": case "samp": { const t = squash(textOf(n)).trim(); return t ? `\`${t.replace(/`/g, "ˋ")}\`` : ""; }
      case "a": {
        // a card link wraps headings and paragraphs: one line of link text
        const t = kids().replace(/\s*\n+\s*/g, " ").replace(/(^|\s)#{1,6} /g, "$1").replace(/ {2,}/g, " ").trim(), href = abs(n.attrs.href);
        if (!t) return "";
        return href ? `[${t}](${href.replace(/\)/g, "%29").replace(/ /g, "%20")})` : t;
      }
      case "img": { const alt = squash(n.attrs.alt || "").trim(), src = abs(n.attrs.src); return alt && src ? `![${esc(alt)}](${src})` : ""; }
      default: return BLOCK.has(n.tag) ? ` ${block(n).trim()} ` : kids();
    }
  }

  const inlineRun = (nodes) => joinInline(nodes).replace(/[ \t]*\n[ \t]*/g, "\n").replace(/ {2,}/g, " ").trim();

  function list(n, depth) {
    const ordered = n.tag === "ol";
    let i = Number(n.attrs.start) || 1;
    const lines = [];
    for (const c of n.children) {
      if (typeof c === "string" || c.tag !== "li" || skipped(c)) continue;
      const marker = ordered && !local ? `${i}.` : "-";
      const pad = " ".repeat(marker.length + 1);
      let inner = flow(c.children, depth + 1).trim();
      const n = i;
      if (ordered) i++;
      if (!inner) continue;
      if (ordered && local && !/^[0-9۰-۹٠-٩]/.test(inner)) inner = `${digits(n, local)}. ${inner}`;
      const [first, ...rest] = inner.split("\n");
      lines.push(`${"  ".repeat(depth)}${marker} ${first}`, ...rest.map((l) => (l.trim() ? `${"  ".repeat(depth)}${pad}${l.replace(/^\s+/, (w) => (/^\s*([-*]|\d+\.) /.test(l) ? "" : w))}` : "")));
    }
    return lines.join("\n");
  }

  function table(n) {
    const rows = [];
    const walk = (x) => { for (const c of x.children) { if (typeof c === "string" || skipped(c)) continue; if (c.tag === "tr") rows.push(c); else if (["thead", "tbody", "tfoot"].includes(c.tag)) walk(c); } };
    walk(n);
    const cells = rows.map((r) => r.children.filter((c) => typeof c !== "string" && (c.tag === "td" || c.tag === "th") && !skipped(c))
      .map((c) => inlineRun(c.children).replace(/\n/g, " ").replace(/\|/g, "\\|")));
    const width = Math.max(0, ...cells.map((r) => r.length));
    if (!width) return "";
    const norm = cells.map((r) => [...r, ...Array(width - r.length).fill("")]);
    const head = rows[0]?.children.some((c) => typeof c !== "string" && c.tag === "th") ? norm.shift() : Array(width).fill("");
    const caption = find(n, (x) => x.tag === "caption");
    return [caption ? `**${inlineRun(caption.children)}**\n` : "", `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...norm.map((r) => `| ${r.join(" | ")} |`)].filter(Boolean).join("\n");
  }

  // a run of children: inline content is joined into paragraphs, block children become their own blocks
  function flow(children, depth = 0) {
    const out = [];
    let run = [];
    const flush = () => { const t = inlineRun(run); if (t) out.push(t); run = []; };
    for (const c of children) {
      if (typeof c === "string" || !BLOCK.has(c.tag)) { run.push(c); continue; }
      flush();
      if (skipped(c)) continue;
      const b = block(c, depth);
      if (b.trim()) out.push(b);
    }
    flush();
    return out.join("\n\n");
  }

  function block(n, depth = 0) {
    if (skipped(n)) return "";
    switch (n.tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const t = inlineRun(n.children).replace(/\n/g, " ");
        return t ? `${"#".repeat(Number(n.tag[1]))} ${t}` : "";
      }
      case "p": case "figcaption": case "summary": case "legend": case "dt": return n.tag === "dt" ? (inlineRun(n.children) ? `**${inlineRun(n.children)}**` : "") : inlineRun(n.children);
      case "ul": case "ol": return list(n, depth);
      case "table": return table(n);
      case "hr": return "---";
      case "pre": { const code = textOf(n).replace(/\n+$/, ""); const fence = code.includes("```") ? "~~~" : "```"; return code.trim() ? `${fence}\n${code}\n${fence}` : ""; }
      case "blockquote": { const t = flow(n.children, depth).trim(); return t ? t.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") : ""; }
      default: return flow(n.children, depth);
    }
  }

  return flow(tree.children).replace(/\n{3,}/g, "\n\n").trim();
}

const yaml = (v) => JSON.stringify(String(v));

/**
 * The Markdown twin of a whole page: front matter (title, description, url, lang, source), a "# title" when the page has
 * no h1 of its own, the description as a quote, then the page's <main> (or <body> without header, nav and footer).
 */
export function pageMarkdown(html, { url = "", site = "" } = {}) {
  const tree = parseHtml(html);
  const htmlEl = find(tree, (n) => n.tag === "html");
  const title = squash(textOf(find(tree, (n) => n.tag === "title") || { children: [] })).trim();
  const desc = find(tree, (n) => n.tag === "meta" && (n.attrs.name || "").toLowerCase() === "description")?.attrs.content?.trim() || "";
  const lang = htmlEl?.attrs.lang || "";
  let main = find(tree, (n) => n.tag === "main");
  if (!main) {
    const body = find(tree, (n) => n.tag === "body") || tree;
    main = { tag: "div", attrs: {}, children: body.children.filter((c) => typeof c === "string" || !["header", "nav", "footer"].includes(c.tag)) };
  }
  const body = htmlToMarkdown({ tag: "#root", attrs: {}, children: [main] }, { base: url || undefined, lang: htmlEl?.attrs.lang || "" });
  const hasH1 = /^# /m.test(body);
  const head = ["---", `title: ${yaml(title)}`, desc && `description: ${yaml(desc)}`, url && `url: ${url}`, lang && `lang: ${lang}`, site && `source: ${yaml(site)}`, "---"].filter(Boolean).join("\n");
  const h1 = hasH1 ? "" : `# ${title.replace(/\s+[|·—–-]\s+[^|·—–-]+$/, "") || title}\n\n`;
  const quote = desc && !body.includes(desc) ? `> ${desc}\n\n` : "";
  return { title, description: desc, lang, markdown: `${head}\n\n${h1}${quote}${body}\n` };
}

/** The twin's file next to an HTML file: "index.html" → "index.md", "terminal/index.html" → "terminal/index.md". */
export const twinPath = (rel) => rel.replace(/\.html$/, ".md");
/** The <link> that points a page at its twin. */
export const twinLink = (href, title = "Markdown") => `<link rel="alternate" type="text/markdown" title="${title}" href="${href}">`;
/** Add the twin link to a page's <head> (once). */
export function linkTwin(html, href) {
  // a page may already link other Markdown (e.g. llms.txt): only this twin's own link counts
  if (html.includes(`rel="alternate" type="text/markdown" title="Markdown" href="${href}"`)) return html;
  const i = html.search(/<\/head>/i);
  return i < 0 ? html : `${html.slice(0, i)}${twinLink(href)}\n${html.slice(i)}`;
}

/**
 * llms.txt (llmstxt.org) for the twins: "# name", "> about", then a "Pages" section per locale linking every .md twin.
 * twins: [{ locale, url, md, title, description }] (md and url absolute).
 */
export function llmsIndex({ name, about = "", intro = "", optional = [] }, twins) {
  const locales = [...new Set(twins.map((t) => t.locale))];
  const line = (t) => `- [${t.title.replace(/[[\]]/g, "")}](${t.md})${t.description ? `: ${t.description}` : ""}`;
  return [
    `# ${name}`, "", ...(about ? [`> ${about}`, ""] : []), ...(intro ? [intro, ""] : []),
    ...locales.flatMap((l) => [`## ${locales.length > 1 ? `Pages (${l})` : "Pages"}`, "", ...twins.filter((t) => t.locale === l).map(line), ""]),
    ...(optional.length ? ["## Optional", "", ...optional.map((o) => `- [${o.title}](${o.url})${o.description ? `: ${o.description}` : ""}`), ""] : []),
  ].join("\n");
}

/** llms-full.txt: the index, then every twin's Markdown, each after a --- rule with its source URL. */
export function llmsFullText(site, twins) {
  return [llmsIndex(site, twins), ...twins.map((t) => `\n---\n\nSource: ${t.url}\n\n${String(t.markdown || "").trim()}\n`)].join("\n");
}
