{{banner}}
/* The kit's site shell (src/shell.js): the menu drawer and the global search on every page. The index is the static
   /search-index.json built with the site (no third-party service); it is fetched the first time the search opens.
   Keys: Ctrl/⌘K or "/" opens the search, Escape closes, arrows move through the results (a combobox over a listbox:
   aria-activedescendant, a live count). A page that owns Ctrl/⌘K (the terminal's command palette) calls preventDefault on
   that keydown and the shell leaves it alone: one owner per shortcut. The matching is public as globalThis.KitSearch
   (fold, words, near, mark, find), so a page's own palette folds, forgives and highlights the same way. */
/* A required chip group (control "chips", data-required="<message>") needs at least one checked option: the first
   checkbox carries the group's validity, so the form's own validation (checkValidity, reportValidity, :invalid) and
   assistive technology see it; it updates on every change. */
(() => {
  for (const g of document.querySelectorAll("[data-chips][data-required]")) {
    const boxes = [...g.querySelectorAll('input[type="checkbox"]')];
    if (!boxes.length) continue;
    const sync = () => boxes[0].setCustomValidity(boxes.some((b) => b.checked) ? "" : g.getAttribute("data-required") || "Required");
    boxes.forEach((b) => b.addEventListener("change", sync));
    sync();
  }
})();
/* The search's matching, shared (globalThis.KitSearch): fold (case, accents, brand marks, Arabic-script letter variants
   U+064A/0649 to U+06CC, U+0643 to U+06A9, U+0629 to U+0647, zero-width joiners, Persian and Arabic digits), words, near
   (one-edit forgiveness for words of 5+ letters), mark (the matched substrings of a text in <mark>, found in the folded
   text and mapped back to the original offsets, so a ZWNJ, a variant letter or a Persian digit highlights its original
   characters; HTML escaped) and find (the texts that match every word of a query, with the terms to highlight). */
(() => {
  const fold = (s) => String(s || "").replace(/[\u2122\u00ae\u00a9]/g, "").normalize("NFKD").replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "").replace(/[\u200c-\u200f]/g, "").replace(/[\u064a\u0649]/g, "\u06cc").replace(/\u0643/g, "\u06a9").replace(/\u0629/g, "\u0647").replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).toLowerCase();
  const words = (q) => fold(q).match(/[\p{L}\p{N}]{2,}/gu) || [];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const MIN_FUZZY = 5;
  // one edit apart (a letter replaced, added, dropped, or two neighbours swapped); equal words are not "near"
  const ed1 = (a, b) => {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
    if (i === la && i === lb) return false;
    if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
  };
  // the vocabulary words one edit from `w` (folded), or whose beginning is: at most `cap`, the closest and commonest first
  const near = (w, vocab, df = () => 1, cap = 5) => {
    if (w.length < MIN_FUZZY) return [];
    const n = w.length, out = [];
    for (const k of vocab) {
      if (k.length < n - 1) continue;
      const whole = ed1(w, k);
      if (whole || (k.length > n && (ed1(w, k.slice(0, n)) || ed1(w, k.slice(0, n - 1)) || ed1(w, k.slice(0, n + 1))))) out.push([k, whole ? 0 : 1, df(k)]);
    }
    return out.sort((x, y) => x[1] - y[1] || y[2] - x[2] || Math.abs(x[0].length - n) - Math.abs(y[0].length - n) || (x[0] < y[0] ? -1 : 1)).slice(0, cap).map((x) => x[0]);
  };
  const mark = (text, terms) => {
    const s = String(text ?? ""), ts = [...new Set((terms || []).filter(Boolean))];
    if (!ts.length) return esc(s);
    let F = "", p = 0; const a = [], b = [];
    for (const ch of s) { const g = fold(ch); for (let k = 0; k < g.length; k++) { a.push(p); b.push(p + ch.length); } F += g; p += ch.length; }
    if (F !== fold(s)) return esc(s);   // a fold that is not letter by letter: no highlight rather than a wrong one
    const r = [];
    for (const t of ts) for (let i = F.indexOf(t); i >= 0 && t; i = F.indexOf(t, i + 1)) r.push([a[i], b[i + t.length - 1]]);
    if (!r.length) return esc(s);
    r.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    const m = []; for (const x of r) { const l = m[m.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else m.push([...x]); }
    let out = "", at = 0;
    for (const [x, y] of m) { out += esc(s.slice(at, x)) + "<mark>" + esc(s.slice(x, y)) + "</mark>"; at = y; }
    return out + esc(s.slice(at));
  };
  // texts matching every word of the query (a substring, or a word one edit away); [{ i, terms }] in the texts' order
  const find = (q, texts) => {
    const ws = words(q); if (!ws.length) return [];
    const out = [];
    texts.forEach((t, i) => {
      const f = fold(t), toks = f.match(/[\p{L}\p{N}]+/gu) || [], terms = [];
      for (const w of ws) {
        if (f.includes(w)) terms.push(w);
        else { const c = near(w, toks, () => 1, 1)[0]; if (c) terms.push(c); else return; }
      }
      out.push({ i, terms });
    });
    return out;
  };
  globalThis.KitSearch = { fold, words, near, mark, find, esc };
})();
(() => {
  "use strict";
  const { fold, words, near, mark, esc } = globalThis.KitSearch;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const drawer = $("[data-kit-drawer]"), dlg = $("[data-kit-search-dialog]");
  if (!drawer && !dlg) return;
  const menuBtns = $$("[data-kit-menu]");
  let last = null;
  const lock = (on) => document.documentElement.classList.toggle("kshell-open", on);

  const closeDrawer = () => { if (!drawer || drawer.hidden) return; drawer.hidden = true; menuBtns.forEach((b) => b.setAttribute("aria-expanded", "false")); lock(false); last?.focus(); };
  const openDrawer = (b) => { closeSearch(); last = b; drawer.hidden = false; menuBtns.forEach((x) => x.setAttribute("aria-expanded", "true")); lock(true); ($("summary, a", drawer))?.focus(); };
  // a page may also have its own drawer (the landing): the kit drawer takes over for [data-kit-menu]
  menuBtns.forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); e.stopImmediatePropagation(); drawer.hidden ? openDrawer(b) : closeDrawer(); }, true));
  drawer && $$("a, [data-modal]", drawer).forEach((a) => a.addEventListener("click", closeDrawer));

  // ---- search ----
  // The index (kit.search-index.v2, schema/search-index.schema.json): pages [url, title, headings, description], body
  // terms, and per page its section, weight and facet values, the sections and facets to filter by, and synonym groups:
  // the dialog offers a section row (and a facet filter when the project has facets) and ranks by the weights. A
  // version 1 file (a stale cache) still searches, without the filters.
  // Matching: every word is folded (KitSearch.fold), found as a prefix of an indexed term or inside the title, headings
  // and description; a word of 5+ letters with no match at all is retried one edit away (a letter wrong, missing,
  // added or two swapped) against the index's own vocabulary, and the page says so. Matches are marked in the result.
  const input = dlg && $("input", dlg), list = dlg && $(".kshell__results", dlg), note = dlg && $("[data-kit-note]", dlg), status = dlg && $("[data-kit-count]", dlg);
  let idx = null, loading = null, sel = -1, fSec = -1, fVal = -1;
  const say = (tpl, o) => String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => (k in o ? o[k] : m));
  const num = (n) => { try { return globalThis.KitFormat?.formatInteger ? globalThis.KitFormat.formatInteger(n, document.documentElement.lang || "en") : String(n); } catch { return String(n); } };
  const load = () => loading || (loading = fetch(dlg.dataset.index, { credentials: "same-origin" }).then((r) => r.json()).then((j) => {
    idx = j; idx.keys = Object.keys(j.terms); idx.low = j.pages.map((p) => [p[1], p[2], p[3], p[0]].map((x) => fold(x)));
    // the words a typo is corrected to: the body terms and the words of titles, headings and descriptions
    idx.vocab = [...new Set([...idx.keys, ...idx.low.flatMap(([t, h, d]) => words(`${t} ${h} ${d}`))])];
    idx.syn = new Map(); for (const g of j.synonyms || []) { const ws = g.flatMap(words); for (const w of ws) idx.syn.set(w, [...new Set([...(idx.syn.get(w) || []), ...ws])]); }
    // a word that names a facet value (its label or a synonym) favours the pages with that value
    idx.vword = new Map(); for (const f of j.facets || []) for (const v of f.values) for (const w of [...words(v[1]), ...(v[3] || []).flatMap(words)]) if (w.length > 2) (idx.vword.get(w) || idx.vword.set(w, new Set()).get(w)).add(v[2]);
    if (j.v === 2) filters();
  }).catch(() => { loading = null; }));
  function filters() {
    if ($(".kshell__filters", dlg) || !idx.sections?.length) return;
    const box = document.createElement("div"); box.className = "kshell__filters";
    const chip = (i, label) => `<button type="button" class="kshell__chip" data-sec="${i}" aria-pressed="${i === fSec}">${esc(label)}</button>`;
    box.innerHTML = `<div class="kshell__chips" role="group" aria-label="${esc(dlg.dataset.sections || "Sections")}">${chip(-1, dlg.dataset.all || "All")}${idx.sections.map((x, i) => chip(i, x[1])).join("")}</div>`
      + (idx.facets?.length ? `<label class="kshell__facet"><span class="sr-only">${esc(dlg.dataset.filter || "Filter")}</span><select data-kit-sfacet><option value="-1">${esc(dlg.dataset.filter || "Filter: audience, industry, regulation…")}</option>${idx.facets.map((f) => `<optgroup label="${esc(f.label)}">${f.values.map((v) => `<option value="${v[2]}">${esc(v[1])}</option>`).join("")}</optgroup>`).join("")}</select></label>` : "");
    $("form", dlg).after(box);
    box.addEventListener("click", (e) => { const b = e.target.closest("[data-sec]"); if (!b) return; fSec = +b.dataset.sec; $$("[data-sec]", box).forEach((x) => x.setAttribute("aria-pressed", String(+x.dataset.sec === fSec))); run(input.value); });
    $("select", box)?.addEventListener("change", (e) => { fVal = +e.target.value; run(input.value); });
  }
  const passes = (i) => { const m = idx.meta?.[i]; if (!m) return fSec < 0 && fVal < 0; return (fSec < 0 || m[0] === fSec) && (fVal < 0 || m[2].includes(fVal)); };
  const setSel = (n) => {
    const as = $$("a", list); sel = as.length ? n : -1;
    as.forEach((a, i) => { a.classList.toggle("on", i === sel); a.setAttribute("aria-selected", String(i === sel)); });
    if (sel >= 0) { input.setAttribute("aria-activedescendant", as[sel].id); as[sel].scrollIntoView({ block: "nearest" }); } else input.removeAttribute("aria-activedescendant");
  };
  // the words with no result of their own: one edit away from a word the index knows
  function mend(w0) { return near(w0, idx.vocab, (k) => idx.terms[k]?.length || 1); }
  function run(q) {
    const ws = words(q);
    if (!idx) return;
    const out = (html, said, n = "") => { list.innerHTML = html; status.textContent = said; note.hidden = !n; note.textContent = n; input.setAttribute("aria-expanded", String(!!$("a", list))); setSel($("a", list) ? 0 : -1); };
    if (!ws.length && fSec < 0 && fVal < 0) { out(`<li class="kshell__none kshell__hint" role="presentation">${esc(dlg.dataset.kitHint || "")}</li>`, dlg.dataset.kitHint || ""); return; }
    const score = new Map(), terms = new Set(), fixed = [];
    if (!ws.length) idx.pages.forEach((p, i) => { if (passes(i)) score.set(i, [0, 0]); });   // a filter alone browses its pages
    // one word (or a synonym or a correction of it) against the pages: hit(page) = best score
    const probe = (w, f, hit) => {
      const add = (i, s) => hit.set(i, Math.max(hit.get(i) || 0, s));
      // the address and the title weigh most, then the headings, then the description, then the body
      idx.low.forEach(([t, h, d, u], i) => { const s = (u.includes(w) ? 8 : 0) + (t.includes(w) ? (t.startsWith(w) ? 12 : 9) : h.includes(w) ? 5 : d.includes(w) ? 3 : 0); if (s) add(i, s * f); });
      for (const key of w.length >= 3 ? idx.keys.filter((x) => x.startsWith(w)) : idx.terms[w] ? [w] : []) for (const i of idx.terms[key]) add(i, (key === w ? 2 : 1) * f);
      const vs = idx.vword.get(w); if (vs && idx.meta) idx.meta.forEach((m, i) => { if (m[2].some((v) => vs.has(v))) add(i, 4 * f); });
    };
    ws.forEach((w0) => {
      const hit = new Map(), same = idx.syn.get(w0) || [w0];
      for (const w of same) { probe(w, w === w0 ? 1 : 0.8, hit); terms.add(w); }
      if (![...hit.keys()].some(passes)) {
        const fix = mend(w0);
        if (fix.length) { for (const w of fix) { probe(w, 0.6, hit); terms.add(w); } fixed.push([w0, fix[0]]); }
      }
      for (const [i, s] of hit) { if (!passes(i)) continue; const c = score.get(i) || [0, 0]; score.set(i, [c[0] + 1, c[1] + s]); }
    });
    // a title that starts with the whole query ranks first
    const whole = ws.join(" ");
    if (whole) for (const [i, v] of score) { const t = idx.low[i][0].replace(/[^\p{L}\p{N}]+/gu, " ").trim(); if (t.startsWith(whole)) v[1] += t === whole ? 25 : 15; }
    const wt = (i) => idx.meta?.[i]?.[1] || 0;
    const top = [...score].sort((a, b) => b[1][0] - a[1][0] || (b[1][1] + wt(b[0]) * 0.2) - (a[1][1] + wt(a[0]) * 0.2) || idx.pages[a[0]][0].length - idx.pages[b[0]][0].length).slice(0, 40);
    const secName = (i) => (idx.sections && idx.meta?.[i] && idx.sections[idx.meta[i][0]]?.[1]) || "";
    const hl = [...terms];
    const html = top.map(([i], n) => { const p = idx.pages[i]; return `<li role="presentation"><a role="option" id="kshell-opt-${n}" aria-selected="false" href="${esc(p[0])}"><b>${mark(p[1], hl)}</b><small>${secName(i) ? `${esc(secName(i))} · ` : ""}${esc(p[0])}</small>${p[3] ? `<span>${mark(p[3], hl)}</span>` : ""}</a></li>`; }).join("");
    const none = esc(dlg.dataset.none);
    out(top.length ? html : `<li class="kshell__none" role="presentation">${none}</li>`, top.length ? say(dlg.dataset.kitFound, { n: num(top.length) }) : dlg.dataset.none,
      fixed.length && top.length ? say(dlg.dataset.kitFixed, { from: fixed[0][0], to: fixed[0][1] }) : "");
  }
  function openSearch(b) {
    if (!dlg) return;
    closeDrawer(); last = b || document.activeElement; dlg.hidden = false; lock(true); input.focus(); input.select();
    load().then(() => run(input.value));
  }
  function closeSearch() { if (!dlg || dlg.hidden) return; dlg.hidden = true; lock(false); last?.focus?.(); }
  $$("[data-kit-search]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); openSearch(b); }));
  $$("[data-kit-close]").forEach((b) => b.addEventListener("click", () => { closeSearch(); closeDrawer(); }));
  if (dlg) {
    let tm = 0;
    input.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => (idx ? run(input.value) : load().then(() => run(input.value))), 30); });
    $("form", dlg).addEventListener("submit", (e) => { e.preventDefault(); const a = $$("a", list)[Math.max(sel, 0)]; if (a) location.href = a.href; });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeSearch(); });
    input.addEventListener("keydown", (e) => {
      const as = $$("a", list); if (!as.length || !/^(Arrow(Up|Down)|Home|End)$/.test(e.key)) return;
      e.preventDefault(); setSel(e.key === "Home" ? 0 : e.key === "End" ? as.length - 1 : (sel + (e.key === "ArrowDown" ? 1 : -1) + as.length) % as.length);
    });
  }
  // One owner per shortcut: the shell listens last (window, bubbling), so a page's own handler for Ctrl/⌘K (the terminal's
  // command palette) runs first and, by preventDefault, keeps the key; the shell then does not open a second dialog.
  window.addEventListener("keydown", (e) => {
    const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) { if (e.defaultPrevented) return; e.preventDefault(); dlg && !dlg.hidden ? closeSearch() : openSearch(); }
    else if (e.key === "/" && !typing && dlg?.hidden) { if (e.defaultPrevented) return; e.preventDefault(); openSearch(); }
    else if (e.key === "Escape") { closeSearch(); closeDrawer(); }
  });
  // ---- Sections: the page's contents, docked in the header. Always shown (the control never appears or disappears
  // while scrolling); it lists the top of the page, then every section with an id and a heading.
  const secBtn = $("[data-kit-sections]"), secPanel = $("[data-kit-sections-panel]");
  if (secBtn && secPanel) {
    const secs = $$("main section[id], body > section[id], main h2[id], main h3[id]").filter((s) => s.id !== "top" && !s.closest("[data-kit-drawer],[data-kit-search-dialog]")).map((s) => {
      const t = /^H[23]$/.test(s.tagName) ? s : s.querySelector(".sec-head .eyebrow, .eyebrow, .sec-head h2, h2, h3");
      const label = t ? t.textContent.replace(/\s+/g, " ").trim() : "";
      return label ? { s, id: s.id, label } : null;
    }).filter(Boolean);
    const h1 = $("main h1, h1");
    const topLabel = (h1 ? h1.textContent.replace(/\s+/g, " ").trim() : "") || document.title;
    secPanel.insertAdjacentHTML("beforeend", `<ol><li><a href="#" data-kit-top>${esc(topLabel)}</a></li>${secs.map((x) => `<li><a href="#${encodeURIComponent(x.id)}">${esc(x.label)}</a></li>`).join("")}</ol>`);
    const links = $$("a", secPanel);
    const close = () => { secPanel.hidden = true; secBtn.setAttribute("aria-expanded", "false"); };
    const open = () => { closeSearch(); closeDrawer(); secPanel.hidden = false; secBtn.setAttribute("aria-expanded", "true"); (links.find((a) => a.classList.contains("on")) || links[0]).focus({ preventScroll: true }); };
    secBtn.hidden = false;
    secBtn.addEventListener("click", (e) => { e.stopPropagation(); secPanel.hidden ? open() : close(); });
    links.forEach((a) => a.addEventListener("click", (e) => { if (a.hasAttribute("data-kit-top")) { e.preventDefault(); scrollTo({ top: 0 }); } close(); }));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !secPanel.hidden) { close(); secBtn.focus(); } });
    document.addEventListener("click", (e) => { if (!secPanel.hidden && !secPanel.contains(e.target) && !secBtn.contains(e.target)) close(); });
    // the current section is marked inside the list; the control itself stays put
    if (secs.length && "IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${encodeURIComponent(e.target.id)}`)); }), { rootMargin: "-45% 0px -50% 0px" });
      secs.forEach((x) => io.observe(x.s));
    }
  }

  // the shortcut label follows the platform
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $$(".kshell__kbd").forEach((k) => { k.textContent = "Ctrl K"; });
})();
