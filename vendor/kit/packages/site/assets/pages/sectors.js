{{banner}}
(() => {
  const bar = document.querySelector("[data-sx-filter]");
  const grid = document.querySelector("[data-sx-grid]");
  if (!bar || !grid) return;
  const cards = [...grid.querySelectorAll("[data-group]")];
  const count = document.querySelector("[data-sx-count]");
  const buttons = [...bar.querySelectorAll("[data-filter]")];
  const fa = (n) => KitFormat.digits(n, "{{locale.digits}}");

  const apply = (g, push) => {
    if (!buttons.some((b) => b.dataset.filter === g)) g = "all";
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === g)));
    let shown = 0;
    cards.forEach((c) => { const on = g === "all" || c.dataset.group === g; c.hidden = !on; if (on) shown++; });
    if (count) count.textContent = `${fa(shown)} {{s.text.1|tl}}`;
    if (push) {
      const url = new URL(location.href);
      if (g === "all") url.searchParams.delete("g"); else url.searchParams.set("g", g);
      history.replaceState(null, "", url);
    }
  };

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (b) apply(b.dataset.filter, true);
  });
  apply(new URLSearchParams(location.search).get("g") || "all", false);
})();
