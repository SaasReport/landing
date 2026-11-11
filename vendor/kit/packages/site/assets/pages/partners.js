{{banner}}
(() => {
  "use strict";
  const sel = document.querySelector('[name="partner_type"]');
  document.querySelectorAll("[data-ptype]").forEach((b) => b.addEventListener("click", () => {
    if (sel) sel.value = b.dataset.ptype;
    document.getElementById("apply")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setTimeout(() => document.querySelector('#apply [name="name"]')?.focus({ preventScroll: true }), 500);
  }));
})();
