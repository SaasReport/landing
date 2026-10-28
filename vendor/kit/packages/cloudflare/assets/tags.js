/* Tag filter and search for /podcasts/ and /blog/ (docs/TAGS.md): one small script, no inline code, no third party.
   The page already works without it: the form is a GET search and every chip a link to the server-filtered list.
   The script acts only when the page holds the COMPLETE, unfiltered catalogue (the server sets form[data-catalogue="complete"]
   only when no tag, show, kind, search or page applies and nothing was cut off). Then typing filters the cards at once and a
   chip toggles instantly. On any other page (a filtered, searched, paged or truncated list) the DOM holds only part of the
   catalogue, so nothing is intercepted: a chip is its link and the search is a submit, and the server filters before it limits. */
(() => {
  "use strict";
  // The search fold of @saasreport/core/tags foldQuery (a browser script has no imports; a test keeps the two equal).
  const fold = (s) => String(s == null ? "" : s).toLowerCase().replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  window.KitTags = { fold };
  const form = document.querySelector("[data-tagbar]");
  if (!form) return;
  // a link with role=button also answers the space bar (on every page: a link does not do it by itself)
  form.addEventListener("keydown", (e) => { if (e.key === " " && e.target.matches && e.target.matches("a[role=button]")) { e.preventDefault(); e.target.click(); } });
  if (form.dataset.catalogue !== "complete") return;   // a partial, server-filtered list: the server answers every change
  const input = form.querySelector("[data-tag-q]");
  const cards = [...document.querySelectorAll("[data-tags][data-q]")];
  // each card's search text is folded once, at load: typing then only compares strings
  const folded = new Map(cards.map((c) => [c, fold(c.dataset.q)]));
  const sections = [...document.querySelectorAll(".podshow[data-show]")];
  const none = document.querySelector("[data-tags-none]");
  const toggles = () => [...form.querySelectorAll("a[data-tag], a[data-param]")];
  const state = { tags: new Set(), show: null, kind: null };
  for (const a of toggles()) {
    if (a.getAttribute("aria-pressed") !== "true") continue;
    if (a.dataset.tag) state.tags.add(a.dataset.tag); else state[a.dataset.param] = a.dataset.value;
  }
  const query = (s) => {
    const p = [];
    if (s.show) p.push(`show=${encodeURIComponent(s.show)}`);
    if (s.kind) p.push(`kind=${encodeURIComponent(s.kind)}`);
    for (const t of s.tags) p.push(`tag=${encodeURIComponent(t)}`);
    if (input && input.value.trim()) p.push(`q=${encodeURIComponent(input.value.trim())}`);
    return p.length ? `?${p.join("&")}` : "";
  };
  const apply = () => {
    const words = fold(input ? input.value : "").split(" ").filter(Boolean);
    let shown = 0;
    for (const c of cards) {
      const have = (c.dataset.tags || "").split(" ");
      const section = c.closest("[data-show]");
      const hit = [...state.tags].every((t) => have.includes(t))
        && (!state.show || !section || section.dataset.show === state.show)
        && (!state.kind || !c.dataset.kind || c.dataset.kind === state.kind)
        && words.every((w) => folded.get(c).includes(w));
      c.hidden = !hit;
      if (hit) shown++;
    }
    for (const s of sections) s.hidden = !s.querySelector("[data-tags]:not([hidden])") && (state.tags.size > 0 || words.length > 0 || Boolean(state.show));
    if (none) none.hidden = shown > 0;
  };
  const sync = () => {
    for (const a of toggles()) {
      const on = a.dataset.tag ? state.tags.has(a.dataset.tag) : state[a.dataset.param] === a.dataset.value;
      a.setAttribute("aria-pressed", String(on));
      const next = { tags: new Set(state.tags), show: state.show, kind: state.kind };
      if (a.dataset.tag) { if (on) next.tags.delete(a.dataset.tag); else next.tags.add(a.dataset.tag); } else next[a.dataset.param] = on ? null : a.dataset.value;
      a.setAttribute("href", `${form.getAttribute("action")}${query(next)}`);
    }
    for (const h of form.querySelectorAll("input[type=hidden]")) h.remove();
    const add = (n, v) => { const h = document.createElement("input"); h.type = "hidden"; h.name = n; h.value = v; input.after(h); };
    for (const t of state.tags) add("tag", t);
    if (state.kind) add("kind", state.kind);
    if (state.show) add("show", state.show);
  };
  form.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-tag], a[data-param]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    if (a.dataset.tag) { if (state.tags.has(a.dataset.tag)) state.tags.delete(a.dataset.tag); else state.tags.add(a.dataset.tag); }
    else state[a.dataset.param] = state[a.dataset.param] === a.dataset.value ? null : a.dataset.value;
    sync(); apply();
    history.replaceState(null, "", `${form.getAttribute("action")}${query(state)}`);
  });
  // one update per frame however fast the keys come
  let frame = 0;
  if (input) input.addEventListener("input", () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; sync(); apply(); }); });
  apply();
})();
