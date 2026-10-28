/**
 * kit site visual-qa: the rendered gate of the colour canon (docs/COLOUR.md). The built site is served locally (no proxy,
 * nothing leaves the machine: requests to other origins are refused and listed), every page is opened in Chromium at each
 * viewport (default 390x844 and 1280x800) and colour scheme (light and, when the site has a dark theme, dark), and the
 * page is failed on:
 *
 *   contrast     computed text below WCAG AA (4.5:1, 3:1 for large text) against the EFFECTIVE background: ancestors' layers
 *                composited with their opacities; a gradient or image behind the text is sampled from a screenshot taken with
 *                the text hidden (the worst pixel counts). A text colour that is not a declared colour role is reported too.
 *   ui           the border or fill of a form control below 3:1 against what it sits on; a focus ring below 3:1 (or none)
 *   link         a link inside running text told apart from the text by colour alone (no underline)
 *   placeholder  placeholder text below 4.5:1
 *   overflow     content wider than the viewport (outside a clipping ancestor)
 *   clipped      text cut off by its own box; overlapping text
 *   font         a declared web font that failed to load, or the first family of a text that is neither loaded nor generic
 *   image        <img> without width and height (layout shift), or a broken image
 *   console      console errors and uncaught exceptions
 *   literal      a colour literal that survives to runtime: in a stylesheet rule, a style attribute or an SVG attribute, other than a --c-<role> declaration; a canvas drawn with a colour that is not a role
 *
 * Screenshots go to a gitignored folder and the findings to a JSON report (schema kit.visual-qa.v1).
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { scanColour } from "./canon/colour.js";
import { themeQa } from "./theme-qa.js";
import { launchGuarded, faultsSince, faultMessage } from "./browser-guard.js";
import { themeEntries } from "./theme-entries.js";
import { relativeLuminance } from "@saasreport/core/colour";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".md": "text/markdown; charset=utf-8", ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg" };

/** Serve a built site directory: /dir/ → dir/index.html, /page → page.html, 404.html for the rest. Returns { url, close }. */
export async function serveSite(dir) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    const tries = [p, p.endsWith("/") ? `${p}index.html` : `${p}/index.html`, `${p}.html`];
    for (const t of tries) {
      const f = resolve(root, `.${t}`);
      if (!f.startsWith(root + sep) && f !== root) continue;
      if (existsSync(f) && statSync(f).isFile()) { res.writeHead(200, { "content-type": TYPES[extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" }); return res.end(readFileSync(f)); }
    }
    const nf = join(root, "404.html");
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(existsSync(nf) ? readFileSync(nf) : "not found");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

const walk = (d, root = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), root) : [relative(root, join(d, e.name)).split(sep).join("/")]))
/**
 * CSS ownership is a T0 runtime boundary, not a filename convenience.
 * /kit/*.css is copied from the Worker runtime and rendered with Worker-side
 * brandCss; SiteKit pages NEVER load it alongside /styles.css. Injecting both
 * into the same neutral theme-qa document lets the Worker's :root palette
 * overwrite the site's --c-* roles, producing non-existent contrast pairs.
 *
 * Both owners must still be measured by Chromium, independently. The real
 * runtime's inline brand override is separately covered by Worker/live QA.
 */
export const themeOwner = (path) => path.startsWith("kit/") ? "worker-runtime" : "site";
export function splitThemeByOwner(sheets) {
  const site = [], workerRuntime = [];
  for (const sheet of sheets) (themeOwner(sheet.file) === "worker-runtime" ? workerRuntime : site).push(sheet);
  return { site, workerRuntime };
};

/** The pages of a built site: [{ file, url, signature }]; a signature groups pages built from the same template (same stylesheets and scripts). */
export function sitePages(outDir, { include, exclude = [] } = {}) {
  const re = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*") + "$");
  const ex = exclude.map(re), inc = (include || []).map(re);
  return walk(outDir).filter((f) => f.endsWith(".html") && !ex.some((r) => r.test(f)) && (!inc.length || inc.some((r) => r.test(f)))).sort().map((file) => {
    const html = readFileSync(join(outDir, file), "utf8");
    const refs = [...html.matchAll(/<(?:link[^>]+href|script[^>]+src)="([^"]+)"/g)].map((m) => m[1].split("?")[0]).filter((h) => /\.(css|js)$/.test(h) && !/^https?:/.test(h)).sort();
    const body = (/<body[^>]*class="([^"]*)"/.exec(html) || [])[1] || "";
    const own = /http-equiv="refresh"/i.test(html) ? "redirect" : "";
    return { file, url: "/" + file.replace(/(^|\/)index\.html$/, "$1"), signature: [...new Set(refs)].join(",") + "|" + body + "|" + own, redirect: Boolean(own) };
  });
}

// ---- PNG (8-bit, non-interlaced) → RGBA, to read the pixels behind hidden text ----------------------------------------
export function decodePng(buf) {
  let p = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; } else if (kind === "IDAT") idat.push(data);
    p += 12 + len;
  }
  if (depth !== 8 || ![2, 6].includes(type)) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { w, h, px: (x, y) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]]; } };
}

const lum = relativeLuminance;   // the one formula, @saasreport/core/colour
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

/** The worst contrast of a text colour ([r,g,b,a]) over the pixels of a PNG (text hidden): { ratio, background }. */
export function worstOverPixels(pngBuf, fg) {
  const img = decodePng(pngBuf);
  let worst = { ratio: 99, background: [255, 255, 255] };
  const sx = Math.max(1, Math.floor(img.w / 40)), sy = Math.max(1, Math.floor(img.h / 12));
  const all = [];
  // the middle of the box: its border and neighbours are not what the text is read against
  const x0 = Math.floor(img.w * 0.1), x1 = Math.ceil(img.w * 0.9), y0 = Math.floor(img.h * 0.2), y1 = Math.ceil(img.h * 0.8);
  for (let y = y0; y < Math.max(y1, y0 + 1); y += sy) for (let x = x0; x < Math.max(x1, x0 + 1); x += sx) {
    const bg = img.px(x, y);
    const text = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    all.push({ ratio: ratio(text, bg), background: bg });
  }
  all.sort((a, b) => a.ratio - b.ratio);
  worst = all[Math.min(all.length - 1, Math.floor(all.length * 0.03))] || worst;   // the 3rd percentile: robust to one anti-aliased pixel
  return worst;
}

// ---- the in-page probe ------------------------------------------------------------------------------------------------
/* Runs in the page (self-contained). Returns { findings: [...], samples: [...], roles: {...}, sheets: "...", markup: "..." }. */
async function inPage(cfg) {
  window.__vqaTexts = [];
  const out = { findings: [], texts: [], roles: {}, textColours: 0 };
  const add = (kind, msg, el, extra = {}) => out.findings.push({ kind, message: msg, path: el ? pathOf(el) : "", ...extra });
  const pathOf = (el) => { const a = []; for (let e = el; e && e !== document.body && a.length < 4; e = e.parentElement) a.unshift(e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "")); return a.join(" > "); };
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/); if (!m) return null; if (m[2]) { const [r, g, b, a = 1] = m[2].split(/[ /]+/).filter(Boolean).map(Number); return [r * 255, g * 255, b * 255, a]; } const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; };
  const lum = new Function(`return (${cfg.lum})`)();   // the one formula (@saasreport/core/colour), given as source
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
  const visible = (el) => { const cs = getComputedStyle(el), bx = el.getBoundingClientRect(); return !(cs.visibility === "hidden" || cs.display === "none" || bx.width < 2 || bx.height < 2) && !el.closest("[hidden],[aria-hidden=true],.sr-only,.nn__sr,.sx-sr"); };

  // declared colour roles: --c-* custom properties of :root, resolved to rgb by the browser
  const rs = getComputedStyle(document.documentElement);
  const probe = document.createElement("i"); probe.style.cssText = "position:absolute;visibility:hidden"; document.body.appendChild(probe);
  const names = new Set();
  for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { continue; /* a cross-origin stylesheet hides its rules: it declares no roles of ours */ } for (const r of rules) if (r.style) for (const n of r.style) if (/^--c-[\w-]+$/.test(n)) names.add(n); }
  const roleRgb = new Set();
  for (const n of names) { probe.style.color = `var(${n})`; const c = parse(getComputedStyle(probe).color); if (c) { out.roles[n] = c.slice(0, 3).map(Math.round).join(","); roleRgb.add(c.slice(0, 3).map(Math.round).join(",")); } }
  probe.remove();

  // effective background of an element: layers bottom-up with their group opacities; null when an image or gradient is behind
  const stack = (el) => { const L = []; let op = 1; const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e); chain.forEach((e, i) => { const cs = getComputedStyle(e); const above = chain.slice(i).reduce((p, x) => p * (+getComputedStyle(x).opacity), 1); L.push({ bg: parse(cs.backgroundColor), img: cs.backgroundImage !== "none", op: above, clipText: cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text" }); }); return L; };
  const compose = (L) => { let bg = [255, 255, 255]; let image = false; for (const l of [...L].reverse()) { if (l.img || l.clipText) image = true; if (l.bg && l.bg[3] > 0) bg = over([l.bg[0], l.bg[1], l.bg[2], l.bg[3] * l.op], bg); } return { bg, image }; };

  // fixed and sticky elements stay where they are in every viewport slice: their text is read at scroll 0, everything else by scrolling
  for (const e of document.querySelectorAll('body *')) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') e.setAttribute('data-vqa-fx', ''); }

  // -- text contrast
  for (const el of document.querySelectorAll("body *")) {   // every text element is read: nothing is merged with a look-alike before its own background is known
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!visible(el) || (el.closest('details:not([open])') && !el.closest('summary'))) continue;
    if ((cfg.excuse || []).some((q) => { try { return el.matches(q); } catch { return false; } })) continue;   // a declared exception (canon.allow.json)   // the body of a closed <details> is not painted; nothing else is exempt: a disabled control is a pair like any other, and a reviewed exception is an entry of canon.allow.json   // a disabled control is exempt (WCAG 1.4.3)
    const cs = getComputedStyle(el);
    const fgc = parse(cs.color); if (!fgc) continue;
    const L = stack(el), opacity = L[0].op;
    if (opacity < 0.05) continue;
    const { bg, image } = compose(L);
    const fg = [fgc[0], fgc[1], fgc[2], fgc[3] * opacity];
    const size = parseFloat(cs.fontSize), need = size >= 24 || (+cs.fontWeight >= 700 && size >= 18.66) ? 3 : 4.5;
    const text = el.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
    const rgbKey = fgc.slice(0, 3).map(Math.round).join(",");
    if (fgc[3] === 1 && opacity === 1 && !roleRgb.has(rgbKey) && Object.keys(out.roles).length) { out.textColours++; add("role", `text colour rgb(${rgbKey}) is not a declared colour role`, el, { text, color: `rgb(${rgbKey})` }); }
    // where the text is painted (page coordinates): its pixels are read from a screenshot with the text hidden
    const boxes = [];
    for (const n of el.childNodes) { if (n.nodeType !== 3 || !n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width > 3 && r.height > 5 && boxes.length < 80) boxes.push({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }); }
    const t = over(fg, bg), ra = ratio(t, bg);
    (window.__vqaTexts ||= []).push(el);
    out.texts.push({ i: window.__vqaTexts.length - 1, path: pathOf(el), text, need, fg, boxes, fixed: !!el.closest('[data-vqa-fx]'), dom: image ? null : +ra.toFixed(2), domBg: bg.map(Math.round), domText: t.map(Math.round) });
  }

  // -- placeholders, form controls, links
  for (const el of document.querySelectorAll("input,textarea,select")) {
    if (!visible(el) || ["hidden", "checkbox", "radio", "range", "color", "file", "submit", "button"].includes(el.type)) continue;
    const cs = getComputedStyle(el), parentBg = compose(stack(el.parentElement || document.body)).bg;
    const own = parse(cs.backgroundColor), ownMix = own && own[3] > 0 ? over(own, parentBg) : parentBg;
    const bw = parseFloat(cs.borderTopWidth) || 0, bc = parse(cs.borderTopColor);
    const border = bw >= 1 && bc && bc[3] > 0 ? over(bc, parentBg) : null;
    let edge = Math.max(border ? ratio(border, parentBg) : 1, ratio(ownMix, parentBg));
    // a control drawn inside a bordered or filled wrapper (a search field: icon, input, button in one box) takes the wrapper's edge
    for (let w = el.parentElement, k = 0; w && k < 2 && edge < 3; w = w.parentElement, k++) { const wc = getComputedStyle(w), wb = parse(wc.borderTopColor), wbg = parse(wc.backgroundColor), outer = compose(stack(w.parentElement || document.body)).bg; const e2 = Math.max(parseFloat(wc.borderTopWidth) >= 1 && wb && wb[3] > 0 ? ratio(over(wb, outer), outer) : 1, wbg && wbg[3] > 0 ? ratio(over(wbg, outer), outer) : 1); if (e2 > edge && w.getBoundingClientRect().width < el.getBoundingClientRect().width * 1.6 + 40) edge = e2; }
    if (edge < 3) add("ui", `the control's border or fill is ${edge.toFixed(2)}:1 against what it sits on (needs 3)`, el, { ratio: +edge.toFixed(2), need: 3 });
    if (el.placeholder) { const ph = getComputedStyle(el, "::placeholder"), c = parse(ph.color); if (c) { const t = over([c[0], c[1], c[2], c[3] * (+ph.opacity || 1)], ownMix), ra = ratio(t, ownMix); if (ra < 4.5) add("placeholder", `placeholder ${ra.toFixed(2)}:1 (needs 4.5)`, el, { ratio: +ra.toFixed(2), need: 4.5 }); } }
  }
  for (const a of document.querySelectorAll("p a[href],li a[href],dd a[href],blockquote a[href],td a[href]")) {
    if (!visible(a) || a.closest("nav,header,.btn,[role=button],[role=tab],button")) continue;
    const parent = a.parentElement; const around = [...parent.childNodes].filter((n) => n !== a && n.nodeType === 3 && n.textContent.trim().length > 3).length;   // words around the link: a row of a link list (a link and a summary in a span) is not running text
    if (!around) continue;   // a link that is the whole line is a link list, not running text
    const cs = getComputedStyle(a), ps = getComputedStyle(parent);
    const underlined = /underline/.test(cs.textDecorationLine) || (parseFloat(cs.borderBottomWidth) >= 1 && cs.borderBottomStyle !== "none") || (cs.boxShadow !== "none" && /inset/.test(cs.boxShadow)) || cs.fontWeight !== ps.fontWeight && +cs.fontWeight >= 600 && false;
    if (underlined) continue;
    const bgc = compose(stack(a)).bg, f = parse(cs.color), p = parse(ps.color);
    const diff = f && p ? ratio(over(f, bgc), over(p, bgc)) : 1;
    if (diff < 3) add("link", `a link in running text is not underlined and differs from the text by ${diff.toFixed(2)}:1 (needs an underline, or 3:1)`, a, { text: a.textContent.trim().slice(0, 40) });
  }

  // -- horizontal overflow
  const vw = document.documentElement.clientWidth;
  const clippedBy = (el) => { for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (/(hidden|clip|auto|scroll)/.test(cs.overflowX)) { const r = e.getBoundingClientRect(); if (r.right <= vw + 1 && r.left >= -1) return true; } if (getComputedStyle(e).position === "fixed") return false; } return false; };
  const over1 = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    if ((r.right > vw + 1 || r.left < -1) && (cs.position === "fixed" || !clippedBy(el)) && !el.closest("[hidden],[aria-hidden=true]") && +cs.opacity > 0 && cs.pointerEvents !== "none") over1.push(el);
  }
  const tops = over1.filter((e) => !over1.some((o) => o !== e && o.contains(e)));
  for (const el of tops.slice(0, 12)) add("overflow", `${tops.length > 12 ? `(${tops.length} elements) ` : ""}extends beyond the ${vw}px viewport (right ${Math.round(el.getBoundingClientRect().right)}, left ${Math.round(el.getBoundingClientRect().left)})`, el);
  if (document.documentElement.scrollWidth > vw + 1 && !tops.length) add("overflow", `the page scrolls horizontally (scrollWidth ${document.documentElement.scrollWidth} > ${vw})`, document.body);

  // -- clipped text
  for (const el of document.querySelectorAll("body *")) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (!/(hidden|clip)/.test(cs.overflowX + cs.overflowY) || cs.textOverflow === "ellipsis" || cs.animationName !== "none" || el.closest(".marquee,[aria-hidden=true]")) continue;
    if (el.scrollWidth > el.clientWidth + 2 && /(hidden|clip)/.test(cs.overflowX) && el.clientWidth > 0) add("clipped", `text is cut off horizontally (${el.scrollWidth}px of content in ${el.clientWidth}px)`, el, { text: el.textContent.trim().slice(0, 40) });
    else if (el.scrollHeight > el.clientHeight + 3 && /(hidden|clip)/.test(cs.overflowY) && el.clientHeight > 0 && cs.display !== "inline" && !cs.webkitLineClamp) add("clipped", `text is cut off vertically (${el.scrollHeight}px of content in ${el.clientHeight}px)`, el, { text: el.textContent.trim().slice(0, 40) });
  }
  // -- overlapping text: every text run of the whole page, candidates found by a sweep over their page rectangles, each confirmed on screen (both on top at their centre)
  const runs = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    if (!n.textContent.trim() || !n.parentElement || !visible(n.parentElement) || n.parentElement.closest("script,style,noscript")) continue;
    { const d = n.parentElement.closest("details:not([open])"); if (d && !n.parentElement.closest("summary")) continue; }   // a closed <details> shows only its summary
    const rg = document.createRange(); rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) if (r.width > 4 && r.height > 6) runs.push({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, el: n.parentElement, node: n, t: n.textContent.trim().slice(0, 24) });
  }
  runs.sort((a, b) => a.y - b.y);
  const cand = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length && runs[j].y < runs[i].y + runs[i].h; j++) {
    const a = runs[i], b = runs[j]; if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w <= 2 || h <= 2 || w * h < 0.35 * Math.min(a.w * a.h, b.w * b.h)) continue;
    cand.push([a, b]);
  }
  const hit = new Set();
  for (const [a, b] of cand) {
    if (hit.size >= 12) break;
    scrollTo({ top: Math.max(0, (a.y + b.y) / 2 - innerHeight / 2), left: 0, behavior: "instant" });
    await new Promise((r) => requestAnimationFrame(r));
    // the page may have re-flowed while scrolling (lazy content, reveal animations): measure both runs again, live, cut to what their clipping ancestors (their own box included) show
    const live = (x) => {
      const rg = document.createRange(); rg.selectNodeContents(x.node);
      const clips = []; for (let q = x.el; q && q !== document.documentElement; q = q.parentElement) { const o = getComputedStyle(q); if (o.overflowX !== "visible" || o.overflowY !== "visible") clips.push(q.getBoundingClientRect()); }
      const out = [];
      for (const r of rg.getClientRects()) {
        let l = r.left, t = r.top, rt = r.right, bt = r.bottom;
        for (const c of clips) { l = Math.max(l, c.left); t = Math.max(t, c.top); rt = Math.min(rt, c.right); bt = Math.min(bt, c.bottom); }
        if (rt - l > 4 && bt - t > 6) out.push({ left: l, top: t, right: rt, bottom: bt, width: rt - l, height: bt - t });
      }
      return out;
    };
    let shared = null, ra0 = null, rb0 = null;
    for (const ra of live(a)) for (const rb of live(b)) {
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2 && w * h >= 0.35 * Math.min(ra.width * ra.height, rb.width * rb.height)) { shared = { x: (Math.max(ra.left, rb.left) + Math.min(ra.right, rb.right)) / 2, y: (Math.max(ra.top, rb.top) + Math.min(ra.bottom, rb.bottom)) / 2 }; ra0 = ra; rb0 = rb; }
    }
    if (!shared || shared.y < 0 || shared.y > innerHeight || shared.x < 0 || shared.x > vw) continue;
    // each run must be painted: where it is not covered by the other, the element on screen is its own (a closed <details>, a hidden panel or a layer above would answer with something else)
    const related = (x, e) => !!e && (x.el === e || x.el.contains(e));   // the run's own element or something inside it, never a container around it
    const painted = (x, rx, ry) => {
      const pts = [[rx.left + 2, (rx.top + rx.bottom) / 2], [rx.right - 2, (rx.top + rx.bottom) / 2], [(rx.left + rx.right) / 2, rx.top + 2], [(rx.left + rx.right) / 2, rx.bottom - 2]]
        .filter(([px, py]) => !(px >= ry.left && px <= ry.right && py >= ry.top && py <= ry.bottom) && px >= 0 && px <= vw && py >= 0 && py <= innerHeight);
      if (!pts.length) return true;
      return pts.some(([px, py]) => related(x, document.elementFromPoint(px, py)));
    };
    if (painted(a, ra0, rb0) && painted(b, rb0, ra0)) { const k = pathOf(a.el) + "|" + pathOf(b.el); if (!hit.has(k)) { hit.add(k); add("clipped", `text overlaps other text: "${a.t}" and "${b.t}"`, a.el, { other: pathOf(b.el) }); } }
  }
  scrollTo({ top: 0, left: 0, behavior: "instant" });

  // -- fonts
  const faces = [...document.fonts];
  const failed = faces.filter((f) => f.status === "error").map((f) => `${f.family} ${f.weight}`);
  for (const f of failed) out.findings.push({ kind: "font", message: `web font failed to load: ${f}`, path: "" });
  const declared = new Set(faces.map((f) => f.family.replace(/["']/g, "")));
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[\w-]+|emoji|math|fangsong|inherit|initial)$/i;
  const fam = new Map();
  for (const el of [document.body, ...document.querySelectorAll("body *")]) {   // every element that paints text or is a field: the first one of each family, weight and style is loaded
    if (!visible(el) && el !== document.body) continue;
    if (el !== document.body && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !/^(input|textarea|select)$/i.test(el.tagName)) continue;   // a font loads for text that is painted
    const cs = getComputedStyle(el), first = cs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
    const k = first + "|" + cs.fontWeight + "|" + cs.fontStyle; if (fam.has(k)) continue; fam.set(k, el);
    if (GENERIC.test(first)) continue;
    if (!declared.has(first)) { add("font", `the first font family "${first}" has no @font-face and is not a system or generic family: it renders as a fallback unless installed`, el); continue; }
    // load it now, as the browser would for this text: a face that is missing or fails is a defect; one that is merely not needed yet is not
    try { const got = await document.fonts.load(`${cs.fontStyle} ${cs.fontWeight} 16px "${first}"`, (el.textContent || "a").trim().slice(0, 20) || "a"); if (!got.length) add("font", `${first} ${cs.fontWeight} has no @font-face that matches`, el); } catch { add("font", `${first} ${cs.fontWeight} failed to load`, el); }
  }

  // -- images
  for (const img of document.querySelectorAll("img")) {
    if (!img.currentSrc && !img.src) continue;
    const cs = getComputedStyle(img);
    if (img.complete && img.naturalWidth === 0 && cs.display !== "none") add("image", `image failed to load: ${(img.getAttribute("src") || "").slice(0, 80)}`, img);
    if ((!img.hasAttribute("width") || !img.hasAttribute("height")) && cs.aspectRatio === "auto" && cs.display !== "none") add("image", `image has no width and height (layout shift): ${(img.getAttribute("src") || "").slice(0, 80)}`, img);
  }

  // -- colour literals at runtime: the stylesheets as the browser holds them, and the markup
  let css = "";
  for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { out.findings.push({ kind: "literal", message: `a cross-origin stylesheet cannot be read: ${sh.href}`, path: "" }); continue; } for (const r of rules) css += r.cssText + "\n"; }
  out.sheets = css;
  out.markup = document.documentElement.outerHTML.replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<script\b[\s\S]*?<\/script>/gi, "");
  out.canvas = window.__kitCanvasColours || [];
  out.theme = document.documentElement.getAttribute("data-theme") || "";
  return out;
}

/**
 * The focus ring check, for EVERY focusable element of the page (not the first few stops): after one real Tab key press (so the browser's
 * keyboard modality makes :focus-visible match), each control is focused in turn and the ring it shows (outline, box-shadow ring or a
 * border) is read against what is behind it: 3:1, or a finding. Returns [{ path, ratio, kind }] for the ones below 3:1.
 */
async function focusProbe(page) {
  await page.evaluate(() => { scrollTo({ top: 0, left: 0, behavior: "instant" }); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  await page.keyboard.press("Tab");
  return page.evaluate((lumSrc) => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/); if (!m) return null; if (m[2]) { const [r, g, b, a = 1] = m[2].split(/[ /]+/).filter(Boolean).map(Number); return [r * 255, g * 255, b * 255, a]; } const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; };
    const lum = new Function(`return (${lumSrc})`)();   // the one formula (@saasreport/core/colour)
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
    const pathOf = (el) => { const a = []; for (let e = el; e && e !== document.body && a.length < 4; e = e.parentElement) a.unshift(e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "")); return a.join(" > "); };
    const found = new Map();
    const els = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"])')];
    for (const el of els) {
      if (el.disabled || el.closest("[hidden],[aria-hidden=true],[inert]")) continue;
      const bx = el.getBoundingClientRect(), vs = getComputedStyle(el);
      if (vs.visibility === "hidden" || vs.display === "none" || (bx.width < 2 && bx.height < 2)) continue;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el) continue;
      let bg = [255, 255, 255]; const chain = []; for (let e = el.parentElement; e; e = e.parentElement) chain.push(e);   // the ring is painted outside the element: what is behind it is the parent's surface
      for (const e of chain.reverse()) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b[3] > 0) bg = over(b, bg); }
      const cs = getComputedStyle(el), ow = parseFloat(cs.outlineWidth) || 0, oc = parse(cs.outlineColor);
      let r = null;
      if (cs.outlineStyle !== "none" && ow >= 1 && oc && oc[3] > 0) r = { ratio: ratio(over(oc, bg), bg), kind: "outline" };
      else if (cs.boxShadow !== "none" && (() => { const m = cs.boxShadow.match(/(?:rgba?\([^)]+\)|color\(srgb [^)]+\))/); const c = m && parse(m[0]); if (c && c[3] > 0.3) { r = { ratio: ratio(over(c, bg), bg), kind: "ring" }; return true; } return false; })()) { /* ring read above */ }
      else if ((parseFloat(cs.borderTopWidth) || 0) >= 1) r = { ratio: ratio(over(parse(cs.borderTopColor) || [0, 0, 0, 1], bg), bg), kind: "border" };
      else r = { ratio: 1, kind: "none" };
      if (r.ratio < 3) { const path = pathOf(el); const k = `${path}|${r.kind}|${r.ratio.toFixed(2)}`; if (!found.has(k)) found.set(k, { path, ...r }); }
      el.blur();
    }
    return [...found.values()];
  }, relativeLuminance.toString());
}

/** What this page's own CSS offers for a dark theme (runs in the page): prefers-color-scheme: dark, and the attribute or class hooks it reacts to ([data-theme=dark], html.dark, .dark-mode ...). */
function darkSupport() {
  let css = "";
  for (const sh of document.styleSheets) { try { for (const r of sh.cssRules) css += r.cssText + "\n"; } catch { /* a cross-origin stylesheet hides its rules: it carries no dark rules of ours */ } }
  const attrs = new Map();
  for (const m of css.matchAll(/\[\s*((?:data-)?[\w-]*(?:theme|mode|scheme)[\w-]*)\s*[~|^$*]?=\s*["']?(dark[\w-]*|[\w-]*-dark)["']?\s*\]/gi)) attrs.set(m[1], m[2]);
  const classes = new Set();
  for (const m of css.matchAll(/(?:html|body|:root)\s*\.(dark|dark-mode|dark-theme|theme-dark|is-dark|mode-dark)(?![\w-])/gi)) classes.add(m[1]);
  for (const m of css.matchAll(/(?:^|[,{}]\s*)\.(dark|dark-mode|dark-theme|theme-dark|is-dark|mode-dark)(?=\s+[.#\w\[:*>])/gi)) classes.add(m[1]);
  return { prefers: /prefers-color-scheme:\s*dark/.test(css), attrs: [...attrs], classes: [...classes] };
}
/** Put the page in the dark theme its CSS reacts to: the attributes and classes on <html>. */
const applyDark = (page, d) => page.evaluate(([attrs, classes]) => { for (const [k, v] of attrs) document.documentElement.setAttribute(k, v); for (const c of classes) document.documentElement.classList.add(c); }, [d.attrs, d.classes]);

const NO_MOTION = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}.reveal{opacity:1!important;transform:none!important}";

/** Text contrast from pixels: the page is photographed with all text hidden, so every layer (gradients, images, overlays, thumbs painted by a sibling, filters) is in the background the text is read against. */
async function verifyContrast(page, texts, findings, report, url, viewport, afterReload = async () => {}) {
  const H = viewport[1];
  let pixels = true;
  const pixelsOf = new Map();   // text index → [{ ratio, bg }] sampled from the shot taken while it was on screen
  /** Boxes are measured live, in the viewport, at the moment of the shot: content that moved since the probe cannot mislead. */
  const live = (done, fixed, only = -1) => page.evaluate(([done, fixed, VH, only]) => {
    const out = [];
    (window.__vqaTexts || []).forEach((el, i) => {
      if ((only >= 0 && i !== only) || done.includes(i) || !el.isConnected || !!el.closest("[data-vqa-fx]") !== fixed) return;
      const boxes = [];
      for (const n of el.childNodes) { if (n.nodeType !== 3 || !n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) { if (r.width <= 3 || r.height <= 5 || boxes.length >= 4) continue; let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom]; for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== "visible" || cs.overflowY !== "visible") { const q = a.getBoundingClientRect(); if (cs.overflowX !== "visible") { l = Math.max(l, q.left); rt = Math.min(rt, q.right); } if (cs.overflowY !== "visible") { t = Math.max(t, q.top); b = Math.min(b, q.bottom); } } } if (rt - l > 3 && b - t > 5) boxes.push({ x: l, y: t, w: rt - l, h: b - t }); } }   // only the part of the text its scroll containers show
      if (!boxes.length) return;
      const c = boxes[0].y + boxes[0].h / 2;
      if (c >= 0 && c < VH) out.push({ i, boxes });
    });
    return out;
  }, [done, fixed, H, only]);
  const read = (png, batch) => {
    for (const { i, boxes } of batch) {
      const t = texts.find((x) => x.i === i), all = [];
      for (const b of boxes) {
        const x0 = Math.floor(b.x + b.w * 0.08), x1 = Math.ceil(b.x + b.w * 0.92), y0 = Math.floor(b.y + b.h * 0.2), y1 = Math.ceil(b.y + b.h * 0.8);
        const sx = Math.max(1, Math.floor((x1 - x0) / 24)), sy = Math.max(1, Math.floor((y1 - y0) / 4));
        for (let y = y0; y < Math.max(y1, y0 + 1); y += sy) for (let x = x0; x < Math.max(x1, x0 + 1); x += sx) {
          if (x < 0 || y < 0 || x >= png.w || y >= png.h) continue;
          const bg = png.px(x, y), tx = [0, 1, 2].map((k) => t.fg[k] * t.fg[3] + bg[k] * (1 - t.fg[3]));
          all.push({ ratio: ratio(tx, bg), bg });
        }
      }
      if (all.length) { all.sort((a, b) => a.ratio - b.ratio); pixelsOf.set(i, all[Math.floor(all.length * 0.03)]); }
    }
  };
  try {
    await page.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}" });
    const scroll = (y) => page.evaluate(async (y) => { scrollTo({ top: y, left: 0, behavior: "instant" }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return [scrollY, document.documentElement.scrollHeight, innerHeight]; }, y);   // instant: the page's own scroll-behavior:smooth would still be moving when the shot is taken
    await scroll(0);
    const fx = await live([], true);
    if (fx.length) read(decodePng(await page.screenshot({ type: "png" })), fx);
    await page.addStyleTag({ content: "[data-vqa-fx]{visibility:hidden!important}" });
    const done = [];
    for (let y = 0, guard = 0; guard < 400; y += H, guard++) {
      const [sy, total] = await scroll(y);
      const batch = await live(done, false);
      if (batch.length) { read(decodePng(await page.screenshot({ type: "png" })), batch); for (const b of batch) done.push(b.i); }
      if (sy + H >= total - 1) break;
    }
    // a failure read while the page was scrolling past is read again, alone, with the text centred on screen: only a failure that stays is reported (a lazy section that moved under the shot cannot fail a page)
    for (const [i, v] of [...pixelsOf].filter(([i, v]) => v.ratio < texts.find((x) => x.i === i).need).slice(0, 60)) {
      const ok = await page.evaluate(async (i) => { const el = (window.__vqaTexts || [])[i]; if (!el || !el.isConnected || el.closest("[data-vqa-fx]")) return false; el.scrollIntoView({ block: "center", behavior: "instant" }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true; }, i);
      if (!ok) continue;
      const again = await live([], false, i);
      if (again.length) { pixelsOf.delete(i); read(decodePng(await page.screenshot({ type: "png" })), again); if (!pixelsOf.has(i)) pixelsOf.set(i, v); }
    }
  } catch (e) { pixels = false; findings.push({ kind: "contrast", message: `the pixel check could not run (${String(e.message).slice(0, 80)}): contrast is not verified against what is painted`, path: "" }); }
  for (const t of texts) {
    const p = pixelsOf.get(t.i);
    let ra, bgs;
    let fromDom = false;
    if (p) { ra = p.ratio; bgs = p.bg; } else if (t.dom != null) { ra = t.dom; bgs = t.domBg; fromDom = true; } else continue;   // never on screen to read (inside a scroller, say): the DOM layers decide, unless an image is behind it
    if (ra < t.need) findings.push({ kind: "contrast", message: `${ra.toFixed(2)}:1 (needs ${t.need}) text rgb(${t.fg.slice(0, 3).map(Math.round)}) on rgb(${bgs.map(Math.round)})${fromDom ? " (from the DOM layers: never on screen to read pixels)" : ""}`, path: t.path, ratio: +ra.toFixed(2), need: t.need, text: t.text });
  }
  if (pixels) { await page.reload({ waitUntil: "networkidle" }); await page.addStyleTag({ content: NO_MOTION }).catch(() => {}); await afterReload(); }   // a page that refuses the style tag is measured as it is; motion is checked separately
}

const CANVAS_HOOK = () => {
  window.__kitCanvasColours = [];
  const proto = CanvasRenderingContext2D.prototype;
  for (const prop of ["fillStyle", "strokeStyle", "shadowColor"]) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(proto, prop, { configurable: true, get: d.get, set(v) { if (typeof v === "string") window.__kitCanvasColours.push({ prop, value: v }); d.set.call(this, v); } });
  }
};

/**
 * Run the gate. options: { outDir, widths: [[390, 844], [1280, 800]], schemes: ["light", "dark"], pages?: include globs, exclude?: [],
 * shots: "templates" | "all" | "none", shotsDir, playwright, chromium, wait, io }
 * Returns the report (schema kit.visual-qa.v1).
 */
export async function visualQa(options) {
  const { outDir, playwright, chromium, viewports = [[390, 844], [1280, 800]], schemes = ["light", "dark"], shots = "templates", shotsDir, wait = 400, log = () => {}, maxPages, focus = true, perTemplate = 8, bounds } = options;
  const everyPage = sitePages(outDir, options).filter((p) => !p.redirect);
  // pages built from one template (a glossary of 200 terms) are sampled evenly, first and last included; perTemplate 0 opens every page
  const byTemplate = new Map();
  for (const p of everyPage) { if (!byTemplate.has(p.signature)) byTemplate.set(p.signature, []); byTemplate.get(p.signature).push(p); }
  const sampled = new Set();
  for (const list of byTemplate.values()) { const n = perTemplate && list.length > perTemplate ? perTemplate : list.length; for (let i = 0; i < n; i++) sampled.add(list[n === 1 ? 0 : Math.round((i * (list.length - 1)) / (n - 1))]); }
  const pages = everyPage.filter((p) => sampled.has(p)).slice(0, maxPages || Infinity);
  // the project's reviewed exceptions (canon.allow.json, category contrast, state "base"): an element one of them selects is a declared exception in the page pass too
  const excuse = (options.allow || []).filter((e) => e.category === "contrast" && !e.on && !e.in && e.context === "base").map((e) => e.match);
  const server = await serveSite(outDir);
  // no DNS, no proxy: only the loopback site exists for this browser (requests to other origins fail at once and are listed)
  const browser = await launchGuarded(playwright, { ...(chromium ? { executablePath: chromium } : {}), args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--no-proxy-server"] }, "visual-qa", bounds);
  const report = { schema: "kit.visual-qa.v1", generated: new Date().toISOString(), outDir, viewports: viewports.map(([w, h]) => `${w}x${h}`), schemes: [], pages: 0, views: 0, ok: true, counts: {}, templates: [], failures: [], notes: [], screenshots: [] };
  const templates = new Map();
  for (const p of everyPage) { if (!templates.has(p.signature)) templates.set(p.signature, []); templates.get(p.signature).push(p.url); }
  report.templates = [...templates.values()].map((urls) => ({ pages: urls.length, example: urls[0], urls: urls.slice(0, 12) }));
  report.pages = everyPage.length;
  report.checkedPages = pages.length;
  if (pages.length < everyPage.length) report.notes.push(`${pages.length} of ${everyPage.length} pages were opened: pages of one template are sampled evenly (${perTemplate} per template; --per-template 0 opens every page)`);
  const addFault = (f, w, h, scheme) => {
    const url = f.url.startsWith(server.url) ? f.url.slice(server.url.length) || "/" : f.url, message = faultMessage(f);
    if (report.failures.some((x) => x.url === url && x.scheme === scheme && x.message.includes(f.message))) return;   // the page pass already reported this error
    report.failures.push({ url, viewport: h ? `${w}x${h}` : "-", scheme, kind: "console", message, path: "" }); report.counts.console = (report.counts.console || 0) + 1;
  };
  const shotted = new Set();
  const workerPaths = new Set();
  const noDark = new Set(), darkPages = new Set();
  try {
    for (const scheme of options.pagesPass === false ? [] : schemes) {   // pagesPass:false (--theme-only): the stylesheets alone, for a theme demo that is not a deployable site
      for (const [w, h] of viewports) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, bypassCSP: true, deviceScaleFactor: 1, reducedMotion: "reduce" });
        const faultsFrom = browser.faults.length;
        await ctx.addInitScript(CANVAS_HOOK);
        const external = new Set();
        await ctx.route("**/*", (route) => { const u = route.request().url(); if (u.startsWith(server.url) || u.startsWith("data:") || u.startsWith("blob:")) return route.continue(); external.add(new URL(u).origin); return route.abort(); });
        for (const pg of pages) {
          const page = await ctx.newPage();
          let dark = null;   // the dark theme this page's own CSS offers (dark pass only)
          const consoleErr = [];
          page.on("console", (m) => { if (m.type() === "error") { const loc = m.location()?.url || ""; if (loc && !loc.startsWith(server.url) && !loc.startsWith("data:")) return; if (/Failed to load resource/.test(m.text())) return; consoleErr.push(m.text().slice(0, 200)); } });
          page.on("response", (r) => { if (r.status() < 400 || !r.url().startsWith(server.url) || r.request().resourceType() === "document") return; const path = r.url().slice(server.url.length); if (/^\/api\//.test(path)) workerPaths.add(path.split("?")[0]); else consoleErr.push(`HTTP ${r.status()} ${path}`); });   // /api/* belongs to the Worker, which a static server is not
          page.on("pageerror", (e) => consoleErr.push(`uncaught: ${String(e.message || e).slice(0, 200)}`));
          const view = { url: pg.url, viewport: `${w}x${h}`, scheme };
          const findings = [];
          try {
            const resp = await page.goto(server.url + pg.url, { waitUntil: "networkidle" });
            if (resp && resp.status() >= 400 && pg.file !== "404.html") findings.push({ kind: "console", message: `HTTP ${resp.status()}`, path: "" });
            await page.evaluate(() => document.fonts && document.fonts.ready);
            await page.addStyleTag({ content: NO_MOTION }).catch(() => {});   // a page that refuses the style tag is measured as it is; motion is checked separately
            if (scheme === "dark") {
              dark = await page.evaluate(darkSupport);
              if (!dark.prefers && !dark.attrs.length && !dark.classes.length) { noDark.add(pg.url); await page.close(); continue; }   // decided per page: this one has no dark theme to inspect
              darkPages.add(pg.url);
              await applyDark(page, dark);
            }
            // T0: an image deliberately deferred by native loading=lazy can sit
            // beyond the bounded 40-screen scan. It is still a declared asset,
            // not proof of a broken page. Force it to load before asserting ALL
            // images are complete; never silently skip a 404 or failed decode.
            await page.evaluate(() => { for (const img of document.images) if (img.loading === "lazy") img.loading = "eager"; });
            await page.evaluate(async () => { for (let y = 0, n = 0; y < document.body.scrollHeight && n < 40; y += innerHeight, n++) { scrollTo({ top: y, left: 0, behavior: "instant" }); await new Promise((r) => setTimeout(r, 30)); } scrollTo({ top: 0, left: 0, behavior: "instant" }); });
            // Dynamic sections can insert fresh native lazy images while
            // scrolling. Keep the same all-images contract for those too.
            await page.evaluate(() => { for (const img of document.images) if (img.loading === "lazy") img.loading = "eager"; });
            // settled = the document complete, its images decoded and its fonts loaded (a bounded poll, the default timeout), then the declared minimum `wait`
            await page.waitForFunction(() => document.readyState === "complete" && [...document.images].every((i) => i.complete) && (!document.fonts || document.fonts.status === "loaded"), null, { polling: "raf" });
            await page.waitForTimeout(wait);
            const r = await page.evaluate(inPage, { excuse, lum: relativeLuminance.toString() });
            for (const f of r.findings) findings.push(f);
            // contrast against what is really painted: one screenshot with every text hidden, each text's boxes read from it
            await verifyContrast(page, r.texts, findings, report, pg.url, [w, h], async () => { if (dark) await applyDark(page, dark); });
            // literals at runtime
            const lit = [...scanColour("rt.css", r.sheets), ...scanColour("rt.html", r.markup)];
            const seen = new Set();
            for (const l of lit) { const k = l.literal + l.kind; if (seen.has(k)) continue; seen.add(k); findings.push({ kind: "literal", message: `colour literal ${l.literal} (${l.kind}) at runtime (a stylesheet rule, a style attribute or an SVG attribute)`, path: "", literal: l.literal }); }
            const roleSet = new Set(Object.values(r.roles));
            for (const c of r.canvas) { const val = String(c.value).trim(), m = val.match(/rgba?\(([^)]+)\)/), hx = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(val); const key = m ? m[1].split(/[ ,/]+/).slice(0, 3).map((x) => Math.round(+x)).join(",") : hx ? (hx[1].length === 3 ? hx[1].split("").map((d) => d + d).join("") : hx[1]).match(/../g).map((d) => parseInt(d, 16)).join(",") : val; if (!roleSet.has(key) && !/^(transparent|none)$/i.test(c.value)) findings.push({ kind: "literal", message: `canvas ${c.prop} painted with ${c.value}, which is not a declared colour role`, path: "", literal: c.value }); }
            if (focus) { for (const f of await focusProbe(page)) if (f.ratio < 3) findings.push({ kind: "ui", message: `focus ring ${f.kind === "none" ? "missing" : `${f.ratio.toFixed(2)}:1`} on ${f.path} (needs 3)`, path: f.path, ratio: +f.ratio.toFixed(2), need: 3 }); }
            for (const m of consoleErr) findings.push({ kind: "console", message: m, path: "" });
            // screenshots
            const first = templates.get(pg.signature)[0] === pg.url;
            if (shotsDir && (shots === "all" || (shots === "templates" && first))) {
              mkdirSync(shotsDir, { recursive: true });
              const name = `${(pg.url.replace(/^\/|\/$/g, "") || "home").replace(/[^\w.-]+/g, "_")}-${w}x${h}-${scheme}.jpg`;
              await page.screenshot({ path: join(shotsDir, name), fullPage: true, clip: { x: 0, y: 0, width: w, height: Math.min(options.shotHeight || 2400, await page.evaluate(() => document.documentElement.scrollHeight)) }, type: "jpeg", quality: 70 });
              report.screenshots.push(name);
            }
          } catch (e) { findings.push({ kind: "console", message: `could not open the page: ${String(e.message).slice(0, 160)}`, path: "" }); }
          if (!report.schemes.includes(scheme)) report.schemes.push(scheme);
          report.views++;
          const dedupe = new Map();
          for (const f of findings) { const k = `${f.kind}|${f.message}|${f.path}`; if (!dedupe.has(k)) dedupe.set(k, f); }
          for (const f of dedupe.values()) { report.failures.push({ ...view, ...f }); report.counts[f.kind] = (report.counts[f.kind] || 0) + 1; }
          if (dedupe.size) log(`  FAIL ${view.viewport} ${scheme} ${pg.url}: ${dedupe.size} finding${dedupe.size === 1 ? "" : "s"}`); else log(`  ok   ${view.viewport} ${scheme} ${pg.url}`);
          await page.close();
        }
        if (external.size) { const f = { url: "(every page)", viewport: `${w}x${h}`, scheme, kind: "console", message: `requests to other origins (${[...external].join(", ")}): a page loads nothing from another origin`, path: "" }; report.failures.push(f); report.counts.console = (report.counts.console || 0) + 1; log(`  FAIL ${f.viewport} ${scheme}: ${f.message}`); }
        for (const f of faultsSince(browser, faultsFrom)) addFault(f, w, h, scheme);   // a crash or an uncaught error is a failure even when nothing later threw
        await ctx.close();
      }
    }
  } finally { await browser.close(); }
  for (const f of faultsSince(browser)) addFault(f, "-", "", "light");   // a fault of no view (never silent)
  // the stylesheets, measured in the browser for every selector, state and tone, on the site's real pages (one per template)
  if (options.theme !== false) {
    try {
      const all = walk(outDir).filter((f) => f.endsWith(".css") && !/(^|\/)fonts\//.test(f)).map((f) => ({ file: f, text: readFileSync(join(outDir, f), "utf8") }));
      const { site: siteSheets, workerRuntime } = splitThemeByOwner(all);
      // Locale stylesheets share only their own site authority; the separately
      // deployed Worker asset /kit/kit.css has an independent :root and MUST
      // never override the SiteKit palette in the same synthetic document.
      const localeOf = (f) => (/\.([a-z]{2})\.css$/.exec(f) || [])[1] || "";
      const codes = [...new Set(siteSheets.map((x) => localeOf(x.file)).filter(Boolean))];
      const groups = [{ code: "", sheets: siteSheets.filter((x) => !localeOf(x.file)), urls: [...byTemplate.values()].map((list) => list.find((p) => !codes.some((c) => p.url.startsWith(`/${c}/`)))).filter(Boolean).map((p) => server.url + p.url) }];
      for (const c of codes) groups.push({ code: c, sheets: siteSheets.filter((x) => localeOf(x.file) === c), urls: [...byTemplate.values()].map((list) => list.find((p) => p.url.startsWith(`/${c}/`))).filter(Boolean).map((p) => server.url + p.url) });
      if (workerRuntime.length) groups.push({ code: "worker-runtime", sheets: workerRuntime, urls: [] });
      report.theme = { selectors: 0, notBuilt: 0, noText: 0 };
      for (const g of groups) {
        if (!g.sheets.length) continue;
        const allow = [...themeEntries(g.sheets), ...(options.allow || [])];   // the kit's entries apply to the kit's own sheets only; the project's, to the sheet they name
        const t = await themeQa({ sheets: g.sheets, playwright, chromium, pages: g.urls, allow, schemes: schemes.includes("dark") ? ["light", "dark"] : ["light"], viewports, bounds, log });
        report.theme.selectors += t.placed; report.theme.notBuilt += t.unbuilt.length; report.theme.noText += t.skipped.filter((x) => x.benign).length;
        for (const p of t.problems) report.failures.push(p.kind === "console"
          ? { url: p.where, viewport: p.viewport, scheme: p.scheme, kind: "console", message: p.note, path: "" }
          : p.kind === "unmeasured"
          ? { url: "(theme)", viewport: "-", scheme: p.scheme, kind: "theme", message: `not measured: ${p.note} [${p.state}] in ${p.file}${p.line ? `:${p.line}` : ""}: fix the selector, or declare it in canon.allow.json (category contrast, context "not measured") with the reason`, path: p.selector }
          : { url: p.where === "page" ? "(theme, on a page)" : "(theme)", viewport: p.viewports.join(" "), scheme: p.scheme, kind: "theme", message: `${p.ratio}:1 (needs ${p.need}) ${p.fg} text on ${p.bg} [${p.state}${p.tone ? ` tone:${p.tone}` : ""}] in ${p.file}${p.line ? `:${p.line}` : ""}, ${p.where}${p.note ? ` (${p.note})` : ""}`, path: p.selector, ratio: p.ratio, need: p.need });
        for (const e of t.stale) {
          // A shared Kit template may describe a component not exercised by
          // this project's pages. Keep it visible in QA evidence, while only
          // stale PROJECT-owned exemptions remain fatal. Actual contrast
          // failures are still fatal regardless of who owns the template.
          if (e.inheritedFromKit === true) {
            report.notes.push(`Kit theme case not exercised in this site: ${e.file} ${e.match} [${e.context}]`);
            continue;
          }
          report.failures.push({ url: "(theme)", viewport: "-", scheme: "light", kind: "theme", message: `stale contrast entry of canon.allow.json (it excuses nothing): ${e.match} (${e.context})`, path: e.match });
        }
        for (const n of t.notes) report.notes.push(n);
      }
    } catch (e) { report.failures.push({ url: "(theme)", viewport: "-", scheme: "light", kind: "theme", message: `the theme gate could not run (${String(e.message).slice(0, 120)}): stylesheets are not verified against what renders`, path: "" }); }
  }
  await server.close();
  if (schemes.includes("dark")) {
    if (!darkPages.size) report.notes.push("no page has a dark theme (no prefers-color-scheme: dark rule and no [data-theme=dark], html.dark or similar hook in any page's CSS): the dark pass is not applicable");
    else if (noDark.size) report.notes.push(`${noDark.size} page${noDark.size === 1 ? "" : "s"} (e.g. ${[...noDark][0]}) have no dark theme and were not inspected in dark; ${darkPages.size} were`);
  }
  if (workerPaths.size) report.notes.push(`${workerPaths.size} Worker endpoint${workerPaths.size === 1 ? "" : "s"} (/api/*) answered 404 from the static server and are not counted: ${[...workerPaths].slice(0, 6).join(", ")}`);
  report.notes = [...new Set(report.notes)];
  report.ok = report.failures.length === 0;
  return report;
}
