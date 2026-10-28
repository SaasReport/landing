/**
 * The markup and styles of the site shell (menu drawer + global search), shared by the static site (src/pages.js,
 * src/page.js) and the Worker's pages (@saasreport/cloudflare shell): no Node APIs here. src/shell.js has the index and
 * the checks. SHELL_CSS uses the theme's variables, falling back to the Worker theme's (kit.css).
 */
import { scriptTag } from "@saasreport/core/cloudflare-safe";
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SEARCH_ICO = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
const SECTIONS_ICO = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
const MENU_ICO = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
export const SEARCH_INDEX = "search-index.json";

/** The buttons (for a bar) and the panels (drawer with the menu, search dialog) of the shell, in one locale. */
export function shellMarkup({ menu = [], t, home = "/", script = "/shell.js?v=0", links = [], cta = "" }) {
  const s = (k, d) => (t && t(k) !== k ? t(k) : d);
  const buttons = [
    `<button type="button" class="kshell__btn kshell__btn--search" data-kit-search aria-haspopup="dialog" aria-controls="kshell-search" title="${esc(s("search", "Search"))} (Ctrl K)">${SEARCH_ICO}<span class="kshell__lbl">${esc(s("search", "Search"))}</span><kbd class="kshell__kbd">⌘K</kbd></button>`,
    `<button type="button" class="kshell__btn kshell__btn--sections" data-kit-sections aria-expanded="false" aria-controls="kshell-sections" title="${esc(s("sectionsOnPage", "Sections on this page"))}">${SECTIONS_ICO}<span class="kshell__lbl">${esc(s("sections", "Sections"))}</span></button>`,
    `<button type="button" class="kshell__btn kshell__btn--menu" data-kit-menu aria-expanded="false" aria-controls="kshell-drawer" aria-label="${esc(s("menuOpen", "Open menu"))}">${MENU_ICO}<span class="kshell__lbl">${esc(s("menu", "Menu"))}</span></button>`,
  ].join("");
  const item = (l) => `<li><a href="${esc(l.href)}">${l.label}</a></li>`;
  // a group with a hub (href) is collapsible: its heading opens it, its first link is the hub (with the hub's own label)
  const group = (g) => g.href
    ? `<details class="kshell__grp"><summary>${g.label}${g.count ? ` <small>${g.count}</small>` : ""}</summary><ul><li><a class="kshell__hub" href="${esc(g.href)}">${g.label}</a></li>${(g.items || []).filter((l) => l.href !== g.href).map(item).join("")}</ul></details>`
    : `${g.label ? `<p class="kshell__gh">${g.label}</p>` : ""}<ul>${(g.items || []).map(item).join("")}</ul>`;
  const section = (m) => [
    `<details class="kshell__sec"><summary>${m.label}</summary>`,
    m.href ? `<a class="kshell__all" href="${esc(m.href)}">${m.hrefLabel || `${m.label} · ${esc(s("overview", "Overview"))}`}</a>` : "",
    ...(m.groups || []).map(group),
    `</details>`,
  ].join("");
  const panels = [
    `<nav class="kshell__sections" id="kshell-sections" data-kit-sections-panel aria-label="${esc(s("pageSections", "Page sections"))}" hidden><b>${esc(s("sectionsOnPage", "Sections on this page"))}</b></nav>`,
    `<div class="kshell__drawer" id="kshell-drawer" data-kit-drawer hidden>`,
    `<div class="kshell__dhead"><a href="${esc(home)}">${esc(s("home", "Home"))}</a><button type="button" class="kshell__x" data-kit-close aria-label="${esc(s("close", "Close"))}">×</button></div>`,
    // the header's call to action (the bar hides it on phones): the drawer carries it there, first
    cta ? `<div class="kshell__cta">${cta}</div>` : "",
    `<button type="button" class="kshell__sfield" data-kit-search aria-controls="kshell-search">${SEARCH_ICO}<span>${esc(s("searchPlaceholder", "Search every page"))}</span></button>`,
    links.length ? `<ul class="kshell__quick">${links.map(item).join("")}</ul>` : "",
    `<nav class="kshell__menu" aria-label="${esc(s("navMain", "Main navigation"))}">${menu.map(section).join("")}</nav>`,
    `</div>`,
    `<div class="kshell__search" id="kshell-search" role="dialog" aria-modal="true" aria-label="${esc(s("search", "Search"))}" data-kit-search-dialog data-index="/${SEARCH_INDEX}" data-none="${esc(s("searchNone", "No page matches"))}" data-kit-hint="${esc(s("searchHint", "Type two or more letters to search every page"))}" data-kit-found="${esc(s("searchCount", "{n} results"))}" data-kit-fixed="${esc(s("searchFixed", "Showing results for “{to}” (not “{from}”)"))}" data-all="${esc(s("searchAll", "All"))}" data-filter="${esc(s("searchFilter", "Filter: audience, industry, regulation…"))}" data-sections="${esc(s("sections", "Sections"))}" hidden>`,
    `<div class="kshell__sbox"><form role="search" class="kshell__form"><label class="kshell__field">${SEARCH_ICO}<input type="search" name="q" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="kshell-results" autocomplete="off" spellcheck="false" placeholder="${esc(s("searchPlaceholder", "Search every page"))}" aria-label="${esc(s("search", "Search"))}"></label><button type="button" class="kshell__x" data-kit-close aria-label="${esc(s("close", "Close"))}">×</button></form>`,
    `<p class="kshell__note" data-kit-note hidden></p>`,
    `<div class="kshell__sr" role="status" aria-live="polite" data-kit-count></div>`,
    `<ol class="kshell__results" id="kshell-results" role="listbox" aria-label="${esc(s("search", "Search"))}"></ol></div>`,
    `</div>`,
    scriptTag({ src: script }),
  ].join("\n");
  return { buttons, panels };
}


/** The shell's styles (appended to styles.css by buildSite, inlined by the Worker shell). */
export const SHELL_CSS = `.kshell__btns{display:flex;gap:6px;align-items:center;flex:none}
.kshell__btn{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 12px;border-radius:var(--r-btn,var(--radius,10px));border:1.5px solid var(--line-2,var(--line));background:var(--surface);color:var(--text,var(--ink));font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.kshell__btn:hover{border-color:var(--text,var(--ink))}
.kshell__btn .ico{width:18px;height:18px}
.kshell__kbd{font:600 11px/1 var(--mono,var(--font-mono,monospace));color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:3px 5px}
.kshell__btn--menu{background:var(--text,var(--ink));color:var(--surface);border-color:var(--text,var(--ink))}
html.kshell-open{overflow:hidden}
.kshell__drawer{position:fixed;inset:0 0 0 auto;z-index:90;width:min(420px,100vw);overflow-y:auto;overscroll-behavior:contain;background:var(--surface);color:var(--text,var(--ink));border-inline-start:1px solid var(--line);box-shadow:-16px 0 48px color-mix(in srgb,var(--c-ink) 18%,transparent);padding:16px 20px calc(32px + env(safe-area-inset-bottom,0px))}
.kshell__drawer[hidden],.kshell__search[hidden]{display:none}
.kshell__dhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-weight:700}
.kshell__x{width:40px;height:40px;border-radius:var(--r-btn,var(--radius,10px));border:1.5px solid var(--line-2,var(--line));background:transparent;color:var(--text,var(--ink));font-size:22px;line-height:1;cursor:pointer;flex:none}
.kshell__sfield{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0 12px;margin-bottom:12px;border-radius:var(--r-btn,var(--radius,10px));border:1.5px solid var(--line-2,var(--line));background:var(--bg);color:var(--muted);font:inherit;font-size:15px;text-align:start;cursor:pointer}
.kshell__quick{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.kshell__quick a{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border-radius:99px;background:var(--wash,color-mix(in srgb,var(--c-ink) 5%,transparent));font-size:14px;font-weight:600}
.kshell__sec{border-top:1px solid var(--line)}
.kshell__sec>summary{cursor:pointer;min-height:44px;align-items:center;padding:6px 2px;font-weight:700;font-size:16px;list-style:none;display:flex;justify-content:space-between}
.kshell__sec>summary::after{content:"+";color:var(--muted)}.kshell__sec[open]>summary::after{content:"–"}
.kshell__sec>summary::-webkit-details-marker{display:none}
.kshell__sec ul{list-style:none;margin:0 0 10px;padding:0}
.kshell__sec li a,.kshell__all{display:flex;align-items:center;min-height:44px;padding:4px 2px;font-size:15px;line-height:1.3;color:var(--text,var(--ink))}
.kshell__grp{border-top:1px solid var(--line);margin-inline-start:2px}
.kshell__grp summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:2px;font-weight:600;font-size:15px}
.kshell__grp summary::-webkit-details-marker{display:none}
.kshell__grp summary::after{content:"+";color:var(--muted);margin-inline-start:auto}.kshell__grp[open] summary::after{content:"–"}
.kshell__grp summary small{color:var(--muted);font-weight:500;font-size:12px}
.kshell__grp ul{padding-inline-start:12px}
.kshell__hub{font-weight:700}
.kshell__all{font-weight:700}
.kshell__sec li a:hover,.kshell__all:hover{color:var(--orange,var(--accent))}
.kshell__gh{margin:10px 0 2px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.kshell__search{position:fixed;inset:0;z-index:95;background:color-mix(in srgb,var(--c-ink) 45%,transparent);display:flex;justify-content:center;align-items:flex-start;padding:min(10vh,80px) 12px 12px}
.kshell__sbox{width:min(680px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--surface);color:var(--text,var(--ink));border-radius:var(--r-card,var(--radius-lg,16px));box-shadow:0 24px 64px color-mix(in srgb,var(--c-ink) 3%,transparent);overflow:hidden}
.kshell__form{display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid var(--line)}
.kshell__field{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
.kshell__field input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--text,var(--ink));font:inherit;font-size:17px;padding:8px 0}
.kshell__field input::-webkit-search-cancel-button{display:none}
.kshell__filters{display:grid;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line)}
.kshell__chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.kshell__chips::-webkit-scrollbar{display:none}
.kshell__chip{flex:none;min-height:44px;padding:0 14px;border-radius:99px;border:1px solid var(--line-2,var(--line));background:var(--surface);color:var(--text,var(--ink));font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.kshell__chip[aria-pressed="true"]{background:var(--text,var(--ink));color:var(--surface);border-color:var(--text,var(--ink))}
.kshell__facet select{width:100%;min-height:44px;padding:0 10px;border-radius:var(--r-btn,var(--radius,10px));border:1.5px solid var(--line-2,var(--line));background:var(--bg,var(--surface));color:var(--text,var(--ink));font:inherit;font-size:15px}
.kshell__facet .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.kshell__results{list-style:none;margin:0;padding:6px;overflow-y:auto}
.kshell__results a{display:block;padding:10px 12px;border-radius:10px;color:var(--text,var(--ink))}
.kshell__results a:hover,.kshell__results a.on{background:var(--wash,color-mix(in srgb,var(--c-ink) 5%,transparent))}
.kshell__results b{display:block;font-size:15px}
.kshell__results small{display:block;color:var(--muted);font:12px var(--mono,var(--font-mono,monospace));overflow-wrap:anywhere}
.kshell__results span{display:block;margin-top:2px;color:var(--muted);font-size:13px;line-height:1.45}
.kshell__btn--sections[aria-expanded="true"]{border-color:var(--text,var(--ink))}
.kshell__sections{position:fixed;z-index:85;top:72px;inset-inline-end:12px;width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 96px);overflow-y:auto;background:var(--surface);color:var(--text,var(--ink));border:1px solid var(--line);border-radius:var(--r-card,var(--radius-lg,16px));box-shadow:0 16px 48px color-mix(in srgb,var(--c-ink) 18%,transparent);padding:14px 16px}
.kshell__sections[hidden]{display:none}
.kshell__sections b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:6px}
.kshell__sections ol{margin:0;padding-inline-start:20px}
.kshell__sections a{display:block;padding:6px 0;font-size:15px;color:var(--text,var(--ink))}
.kshell__sections a.on{color:var(--accent-text,var(--c-accent-text,var(--orange,var(--accent))));font-weight:700}
.kshell__none{padding:16px 12px;color:var(--muted)}
.kshell__note{margin:0;padding:8px 18px;color:var(--muted);font-size:13px;border-bottom:1px solid var(--line)}.kshell__note[hidden]{display:none}
.kshell__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.kshell__results mark{background:color-mix(in srgb,var(--orange,var(--accent)) 26%,transparent);color:inherit;border-radius:3px}
.kbar--shell .nav__cta{display:flex;gap:8px;align-items:center;margin-inline-start:auto}.kbar--shell .btn--sm{padding:8px 14px;font-size:14px}
@media (max-width:900px){.kbar--shell .kbar__nav{display:none}}
.kshell__cta{display:none;flex-wrap:wrap;gap:8px;margin-bottom:12px}.kshell__cta .btn{flex:1 1 auto;justify-content:center}
.nav .kshell__lbl,.nav .kshell__kbd{display:none}.nav .kshell__btn{width:42px;padding:0;justify-content:center}
@media (max-width:520px){.nav__cta>.btn{display:none}.kshell__cta{display:flex}}
@media (max-width:640px){.kshell__lbl,.kshell__kbd{display:none}.kshell__btns{gap:4px}.kshell__btn{width:38px;min-height:38px;height:38px;padding:0;justify-content:center}}`;

const LINK = { type: "object", required: ["label", "href"], additionalProperties: false, properties: { label: { type: "string", minLength: 1 }, href: { type: "string", pattern: "^(/|https://|#)" } } };
const SECTION = { type: "object", required: ["label", "groups"], additionalProperties: false, properties: {
  label: { type: "string", minLength: 1 }, href: { type: "string", pattern: "^(/|https://)" }, hrefLabel: { type: "string", minLength: 1, description: "The label of the section's hub link (the hub page's own label)." },
  groups: { type: "array", items: { type: "object", required: ["items"], additionalProperties: false, properties: { label: { type: "string" }, href: { type: "string", pattern: "^(/|https://)", description: "The group's hub: the group becomes collapsible and its first link is the hub." }, count: { type: "integer", minimum: 0 }, items: { type: "array", items: LINK } } } },
} };
/** JSON Schema 2020-12 of project.menu: a list of sections, or { <locale code>: list }. */
export const MENU_SCHEMA = { $schema: "https://json-schema.org/draft/2020-12/schema", anyOf: [{ type: "array", items: SECTION }, { type: "object", additionalProperties: { type: "array", items: SECTION } }] };
