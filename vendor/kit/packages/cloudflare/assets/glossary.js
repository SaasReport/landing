/* Glossary index: filter terms as you type ([data-gsearch] over [data-gterm] cards in [data-gcat] sections). */
(() => {
  "use strict";
  const input = document.querySelector("[data-gsearch]");
  if (!input) return;
  // Folds Arabic/Persian letter variants and zero-width non-joiners so "ي"/"ی" and "ك"/"ک" match.
  const norm = (s) => String(s || "").toLowerCase().replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ").normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
  const cats = [...document.querySelectorAll("[data-gcat]")];
  const none = document.querySelector("[data-gnone]");
  input.addEventListener("input", () => {
    const q = norm(input.value);
    let shown = 0;
    for (const c of cats) {
      let n = 0;
      for (const a of c.querySelectorAll("[data-gterm]")) { const hit = !q || norm(a.dataset.q).includes(q); a.hidden = !hit; if (hit) n++; }
      c.hidden = n === 0;
      shown += n;
    }
    if (none) none.hidden = shown > 0;
  });
})();
