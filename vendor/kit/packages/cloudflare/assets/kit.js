/* kit client: toasts, copy link, native share, likes and ratings ([data-rx]), event RSVP forms ([data-form]).
   UI strings come from <script type="application/json" id="kit-strings"> rendered by the Worker. */
(() => {
  "use strict";
  let S = {};
  try { S = JSON.parse(document.getElementById("kit-strings").textContent); } catch (e) { S = {}; /* no strings island: every label falls back to its built-in text */ }
  // Numbers through the kit's one formatter (/kit/format.js, loaded first: globalThis.KitFormat).
  const num = (v) => (typeof v === "number" ? KitFormat.formatNumber(v, S.lang || "en") : KitFormat.digits(v, S.lang || "en"));
  const fill = (key, vars) => String(S[key] || key).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? num(vars[k]) : ""));
  const toastEl = document.querySelector(".toast");
  let toastTimer;
  const notify = (type, title, message) => {
    if (!toastEl) return;
    toastEl.textContent = message ? `${title} — ${message}` : title;
    toastEl.dataset.type = type;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
  };
  window.KitNotify = { show: ({ type, title, message }) => notify(type, title, message) };

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy-url]");
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copyUrl); notify("success", S["rx.copied"] || "Copied"); }
    catch (err) { notify("error", S["rx.copyFailed"] || "Copy failed"); }
  });
  document.querySelectorAll("[data-rx-native]").forEach((b) => {
    if (!navigator.share) return;
    b.hidden = false;
    b.addEventListener("click", () => navigator.share({ title: document.title, url: location.href.split("#")[0] }).catch(() => {}));   // the reader cancelled the share sheet
  });

  /* likes and ratings */
  const blocks = [...document.querySelectorAll("[data-rx]")];
  const paint = (el, s) => {
    const like = el.querySelector("[data-rx-like]");
    if (like) like.setAttribute("aria-pressed", String(Boolean(s.mine && s.mine.liked)));
    const n = el.querySelector("[data-rx-likes]");
    if (n) n.textContent = num(s.likes || 0);
    const avg = el.querySelector("[data-rx-avg]");
    if (avg) avg.textContent = s.rating_count ? fill("rx.ratings", { n: s.rating_count, avg: s.rating_avg }) : S["rx.noRatings"] || "";
    const mine = (s.mine && s.mine.rating) || 0;
    el.querySelectorAll("[data-rate]").forEach((r) => {
      const v = +r.dataset.rate;
      r.classList.toggle("is-on", v <= mine);
      r.setAttribute("aria-checked", String(v === mine));
    });
  };
  const send = async (el, payload) => {
    const r = await fetch("/api/reactions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: el.dataset.rx, ...payload }) });
    const out = await r.json().catch(() => ({}));   // a reply that is not JSON fails the ok check below with the error message
    if (!out.ok) throw new Error(out.error === "rate_limited" ? S["rx.rateLimited"] : S["rx.error"]);
    paint(el, out);
    return out;
  };
  if (blocks.length) {
    fetch(`/api/reactions?items=${encodeURIComponent(blocks.map((b) => b.dataset.rx).join(","))}`, { credentials: "same-origin" })
      .then((r) => r.json()).then((d) => { if (d.ok) blocks.forEach((b) => d.items[b.dataset.rx] && paint(b, d.items[b.dataset.rx])); }).catch(() => {});   // reactions are decoration: the page reads fine without counts
    blocks.forEach((el) => {
      const like = el.querySelector("[data-rx-like]");
      if (like) like.addEventListener("click", async () => {
        const on = like.getAttribute("aria-pressed") !== "true";
        like.setAttribute("aria-pressed", String(on));
        try { await send(el, { like: on }); } catch (err) { like.setAttribute("aria-pressed", String(!on)); notify("error", S["rx.like"] || "", err.message); }
      });
      el.querySelectorAll("[data-rate]").forEach((b) => b.addEventListener("click", async () => {
        try { await send(el, { rating: +b.dataset.rate }); notify("success", S["rx.rated"] || "", fill("rx.rateN", { n: b.dataset.rate })); }
        catch (err) { notify("error", S["rx.error"] || "", err.message); }
      }));
    });
  }

  /* forms ([data-form]: event RSVP, sign-up box, …): POST /api/forms/<name>; data-done = the success message */
  document.querySelectorAll("form[data-form]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const btn = form.querySelector("[type=submit]");
      btn.disabled = true;
      const data = Object.fromEntries(new FormData(form));
      const consent = form.querySelector("[name=consent]");
      data.consent = consent ? consent.checked : true;
      try {
        const r = await fetch(`/api/forms/${form.dataset.form}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
        const out = await r.json().catch(() => ({}));   // a reply that is not JSON fails the ok check below with the error message
        if (!out.ok) throw new Error(S[`form.error.${out.error}`] || S["form.failed"] || out.error || "error");
        const done = document.createElement("p");
        done.className = "form__done";
        const ref = out.reference ? ` ${(S["form.reference"] || "{ref}").replace("{ref}", out.reference)}` : "";
        done.textContent = `${form.dataset.done || S["events.rsvpDone"] || "OK"}${ref}`;
        form.replaceWith(done);
        notify("success", form.dataset.done || S["events.rsvpDone"] || "OK", ref.trim());
      } catch (err) { notify("error", S["form.failedTitle"] || S["rx.error"] || "Error", err.message); btn.disabled = false; }
    });
  });
})();
