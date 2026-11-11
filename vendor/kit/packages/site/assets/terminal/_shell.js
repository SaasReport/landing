  /* ================================================================ SHELL */
  const ORDER = {{d.order|jslist}};
  const CMDS = [
{{#each s._shell.commands}}    {{#each .}}["{{.0|dq}}", "{{.1}}", "{{.2}}"]{{#unless @last}}, {{/unless}}{{/each}},
{{/each}}  ];
  const QUERIES = [{{#each s._shell.queries}}"{{.|dq}}"{{#unless @last}}, {{/unless}}{{/each}}];

  function shell(root) {
    const full = root.dataset.terminal === "full";
    const tourList = (root.dataset.tour || ORDER.join(",")).split(",").filter((v) => VIEWS[v]);
    const groups = [];
    for (const id of ORDER) { const g = VIEWS[id].group; let e = groups.find((x) => x[0] === g); if (!e) groups.push((e = [g, []])); e[1].push(id); }
    root.classList.add("txs", full ? "txs--full" : "txs--teaser");
    root.innerHTML = `
      <div class="txs__top"><div class="txs__brand"><img src="{{d.icon}}" width="96" height="96" alt="">{{s._shell.1|tl}}<span class="txs__ws">{{s._shell.2|tl}}</span></div>
        <div class="txs__search" role="button" tabindex="0" aria-label="{{s._shell.3|tl}}" data-search>⌕ <span data-q>{{s._shell.4|tl}}</span><kbd>⌘K</kbd></div>
        <button class="txs__new" data-new>{{s._shell.5|tl}}</button></div>
      <div class="txs__body">
        <nav class="txs__side" aria-label="{{s._shell.6|tl}}">${groups.map(([g, ids]) => `<b>${g}</b>${ids.map((id) => `<button data-v="${id}">${VIEWS[id].fa}</button>`).join("")}`).join("")}</nav>
        <div class="txs__main"><div class="txs__view" data-view></div></div>
        <aside class="txs__rail"><h4>{{s._shell.7|tl}} <span class="live">{{s._shell.8|tl}}</span></h4><ul class="feed" data-feed></ul></aside>
      </div>
      <div class="txs__tour"><span data-hint></span><span class="txs__dots" data-dots>${tourList.map(() => "<i></i>").join("")}</span><button data-tour>{{s._shell.9|tl}}</button></div>`;
    const S = makeStage(root);
    const feedUl = $("[data-feed]", root);
    const SH = {
      touring: !reduce, cur: null, V: null,
      feed(ev, cls, note) { pushFeed(feedUl, feedItem(ev, cls, note), full ? 9 : 7); },
      show(id, { user = false, kick = true } = {}) {
        if (!VIEWS[id]) return;
        if (kick) S.kick();
        if (SH.V) SH.V.ep++;
        SH.cur = id; const box = $("[data-view]", root);
        box.replaceWith(box.cloneNode(false)); const nb = $("[data-view]", root);
        SH.V = mount(VIEWS[id], nb, { shell: SH });
        $$(".txs__side button", root).forEach((b) => b.setAttribute("aria-current", b.dataset.v === id));
        const i = tourList.indexOf(id); $$("[data-dots] i", root).forEach((d, k) => d.classList.toggle("on", k === i));
        $("[data-hint]", root).textContent = `${VIEWS[id].fa}: ${VIEWS[id].hint}`;
        if (user) { SH.touring = false; syncTour(); }
        if (full && user && history.replaceState) history.replaceState(null, "", `#${id}`);
        if (reduce) VIEWS[id].play(SH.V, S).catch(() => {});   // a demo interrupted by navigation has nothing left to show
      },
      async demoPalette(Sg, text, target) {
        await Sg.click($("[data-search]", root)); openPal("");
        const inp = $(".pal input", root);
        for (const ch of text) { inp.value += ch; filter(inp.value); await Sg.sleep(110); }
        await Sg.sleep(700); const btn = $(`.pal button[data-v="${target}"]`, root) || $(".pal button", root);
        await Sg.click(btn); closePal(); SH.show(target, { kick: false });
      },
    };
    const syncTour = () => { $("[data-tour]", root).textContent = SH.touring ? "{{s._shell.9|dq}}" : "{{s._shell.10|dq}}"; };
    $("[data-tour]", root).addEventListener("click", () => { SH.touring = !SH.touring; syncTour(); });
    $$(".txs__side button", root).forEach((b) => b.addEventListener("click", () => SH.show(b.dataset.v, { user: true })));

    /* command palette */
    let pal = null, sel = 0;
    const filter = (q) => {
      // the shell's own matching (globalThis.KitSearch, /shell.js): case, ي/ی, ك/ک, ZWNJ, digits, one wrong letter; marks what matched.
      // One letter lists every command; no match lists none (never a list that does not answer the query).
      const K = globalThis.KitSearch, texts = CMDS.map(([t, v]) => `${t} ${VIEWS[v].fa}`);
      const hits = K && K.words(q).length ? K.find(q, texts) : CMDS.map((c, i) => ({ i, terms: [] }));
      $(".pal [data-list]", root).innerHTML = hits.map(({ i, terms }, n) => { const [t, v] = CMDS[i], m = (s) => (K ? K.mark(s, terms) : s); return `<button data-v="${v}" class="${n === 0 ? "on" : ""}">${m(t)}<small>${m(VIEWS[v].fa)}</small></button>`; }).join("");
      sel = 0; $$(".pal [data-list] button", root).forEach((b) => b.addEventListener("click", () => { closePal(); SH.show(b.dataset.v, { user: true }); }));
    };
    const openPal = (q = "") => {
      if (pal) return; pal = document.createElement("div"); pal.className = "pal"; pal.setAttribute("role", "dialog"); pal.setAttribute("aria-label", "{{s._shell.11|dq}}");
      pal.innerHTML = `<input type="text" placeholder="{{s._shell.12|tl}}" aria-label="{{s._shell.13|tl}}"><p>{{s._shell.11|tl}}</p><div data-list></div>`;
      $(".txs__main", root).appendChild(pal); $("[data-search]", root).classList.add("on"); filter(q);
      const inp = $("input", pal); inp.value = q;
      inp.addEventListener("input", () => filter(inp.value));
      inp.addEventListener("keydown", (e) => {
        const bs = $$(".pal [data-list] button", root);
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && bs.length) { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length; bs.forEach((b, i) => b.classList.toggle("on", i === sel)); }
        else if (e.key === "Enter") { e.preventDefault(); const b = bs[sel]; if (b) { closePal(); SH.show(b.dataset.v, { user: true }); } }
        else if (e.key === "Escape") closePal();
      });
    };
    const closePal = () => { pal?.remove(); pal = null; $("[data-search]", root).classList.remove("on"); };
    const openFromUser = () => { openPal(""); $(".pal input", root)?.focus(); };
    $("[data-search]", root).addEventListener("click", (e) => { if (e.isTrusted) openFromUser(); });
    $("[data-search]", root).addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFromUser(); } });
    $("[data-new]", root).addEventListener("click", openFromUser);
    document.addEventListener("click", (e) => { if (pal && e.isTrusted && !pal.contains(e.target) && !$("[data-search]", root).contains(e.target) && !$("[data-new]", root).contains(e.target)) closePal(); });
    if (full) document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      // one owner per shortcut: on this page Ctrl/⌘K is the terminal's command palette (preventDefault: the shell's search stays shut,
      // it is still one click or "/" away); while the shell's search is open the key is its own, to close it
      if (document.querySelector("[data-kit-search-dialog]:not([hidden])")) return;
      e.preventDefault(); root.scrollIntoView({ block: "nearest" }); openFromUser(); } });

    /* idle search typing */
    const q = $("[data-q]", root); let qi = 0;
    const typeQuery = async () => {
      if (pal || reduce || !onScreen(root)) return;
      const text = QUERIES[qi++ % QUERIES.length]; q.classList.add("caret"); q.textContent = "";
      for (const ch of text) { if (pal) break; q.textContent += ch; await wait(35); }
      await wait(2200); q.classList.remove("caret"); q.textContent = "{{s._shell.4|dq}}";
    };
    watch(root); setInterval(typeQuery, 9000); setTimeout(typeQuery, 1500);
    every(root, full ? 1700 : 2100, () => { const [e, c, n] = pick(LIVE_EVENTS); SH.feed(e, c, n); });
    for (let i = 0; i < 4; i++) { const [e, c, n] = LIVE_EVENTS[i]; SH.feed(e, c, n); }

    const start = full && VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : tourList[0];
    SH.show(start);
    if (full && start !== tourList[0]) { SH.touring = false; syncTour(); }
    window.addEventListener("hashchange", () => { if (full && VIEWS[location.hash.slice(1)] && location.hash.slice(1) !== SH.cur) SH.show(location.hash.slice(1), { user: true }); });
    $$("[data-open-view]").forEach((b) => b.addEventListener("click", () => { root.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); SH.show(b.dataset.openView, { user: true }); }));

    if (reduce) return;
    (async () => {
      for (;;) {
        try {
          const id = SH.cur, V = SH.V;
          await S.sleep(600); await VIEWS[id].play(V, S); await S.sleep(1800);
          if (SH.touring && SH.cur === id) {
            const nx = tourList[(tourList.indexOf(id) + 1) % tourList.length];
            await S.click($(`.txs__side button[data-v="${nx}"]`, root)); SH.show(nx, { kick: false });
          } else if (SH.cur === id) SH.show(id, { kick: false });
        } catch (e) {
          if (e === STOP) return;
          if (e !== RESTART) { console.error(e); return; }
          if (S.touched) { SH.touring = false; syncTour(); S.clearTouched(); SH.show(SH.cur, { kick: false }); }
        }
      }
    })();
  }

  /* ================================================================ boot */
  const boot = () => {
    $$("[data-terminal]").forEach(shell);
    $$("[data-tx-view]").forEach((el) => {
      const def = VIEWS[el.dataset.txView]; if (!def) return;
      const inner = document.createElement("div"); el.appendChild(inner);
      const S = makeStage(el); const V = mount(def, inner);
      loop(S, V, def);
    });
    // landing: verbs row lights up in sequence
    $$("[data-verbs]").forEach((row) => { const bs = $$("b", row); let i = 0; every(row, 1100, () => { bs.forEach((b, k) => b.classList.toggle("on", k === i % bs.length)); i++; }); });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
