/**
 * Minimal, safe Markdown → HTML for posts and event bodies (RTL or LTR).
 * Everything is escaped first; only http(s), site-relative and #fragment links survive.
 * Supports: ## / ### headings, paragraphs, - and 1. lists, > quotes, ``` code fences,
 * `inline code`, **bold**, [links](url), | tables |, and --- rules.
 *   render(md, { origin }) → { html, headings }   (links outside `origin` open in a new tab)
 *   toPlain(md) → plain text for summaries, feeds and channel posts
 */
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const esc = escapeHtml;
const safeUrl = (u) => (/^(https?:\/\/|\/(?!\/)|#)/.test(u) ? u : "#");

function inline(s, origin) {
  const codes = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const href = safeUrl(url.replace(/&amp;/g, "&"));
    const ext = /^https?:\/\//.test(href) && !(origin && (href === origin || href.startsWith(origin + "/")));
    return `<a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
  });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code dir="ltr">${codes[+i]}</code>`);
}

/** Markdown → { html, headings: [{ id, level, text }] }. `origin` (e.g. config.site.url) marks internal absolute links. */
export function renderMarkdown(md, { origin = "" } = {}) {
  origin = String(origin || "").replace(/\/+$/, "");
  const il = (s) => inline(s, origin);
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [], heads = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim(); const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre dir="ltr" class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^#{2,3}\s/.test(line)) {
      const level = line.startsWith("###") ? 3 : 2, text = line.replace(/^#{2,3}\s+/, "");
      const id = `h-${heads.length + 1}`; heads.push({ id, level, text });
      out.push(`<h${level} id="${id}">${il(text)}</h${level}>`); i++; continue;
    }
    if (/^---+$/.test(line.trim())) { out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${buf.map(il).join("<br>")}</blockquote>`); continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*[\d۰-۹]+[.)]\s+/.test(line)) {
      const ordered = /^\s*[\d۰-۹]+[.)]\s+/.test(line), re = ordered ? /^\s*[\d۰-۹]+[.)]\s+/ : /^\s*[-*]\s+/, buf = [];
      while (i < lines.length && re.test(lines[i])) buf.push(lines[i++].replace(re, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${buf.map((b) => `<li>${il(b)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      const rows = []; while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [head, sep, ...body] = rows;
      if (sep && /^[\s|:-]+$/.test(sep)) {
        out.push(`<div class="md-table"><table><thead><tr>${cells(head).map((c) => `<th>${il(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${il(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      } else out.push(`<p>${rows.map(il).join("<br>")}</p>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [lines[i++]]; // the current line is always consumed (progress): no earlier branch took it, so it is paragraph text, e.g. "|half a table row"
    while (i < lines.length && lines[i].trim() && !/^(```|#{2,3}\s|>|\s*[-*]\s|\s*[\d۰-۹]+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${il(buf.join(" "))}</p>`);
  }
  return { html: out.join("\n"), headings: heads };
}

/** Plain text (for summaries, feeds and channel posts). */
export const toPlain = (md) => String(md || "").replace(/```[\s\S]*?```/g, "").replace(/[#>*`|]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
/** Reading time in minutes (at `wpm` words per minute, at least 1). */
export const readingMinutes = (md, wpm = 200) => Math.max(1, Math.round(toPlain(md).split(/\s+/).filter(Boolean).length / wpm));

export const markdown = { render: renderMarkdown, toPlain, readingMinutes, escapeHtml };
