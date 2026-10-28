{{banner}}
/* The app shells (page type "apps"): no data of their own. Without a session the page shows the sign-in state and
   the API contract; on the app's own host, "Sign in" loads the sign-in provider (only then: a preview makes no
   third-party request), and with a session the view's GET endpoints are called with the session token and rendered
   (the first array of objects as a table, otherwise the fields). POST actions follow the { url } they return.
   On any other host the page is a preview and "Sign in" opens the same view on the app's host. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const box = $("[data-app-session]");
  if (!box) return;
  const host = box.dataset.host, base = box.dataset.base || "/";
  const onHost = location.hostname === host;
  const state = $("[data-app-state]", box), data = $("[data-app-data]"), signin = $("[data-app-signin]", box);
  const notify = (type, title, message) => window["{{ns.global}}Notify"]?.show?.({ type, title, message });
  const n = (v) => KitFormat.formatNumber(v, "{{locale.code}}", { maxDecimals: 3, numerals: "{{locale.digits}}" });

  function loadClerk() {
    if (window.Clerk) return Promise.resolve(window.Clerk);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.setAttribute("data-cfasync", "false");   // before src: Cloudflare Rocket Loader leaves it alone
      s.src = `${box.dataset.frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
      s.setAttribute("data-clerk-publishable-key", box.dataset.publishableKey);
      s.async = true; s.crossOrigin = "anonymous";
      s.onload = async () => { try { await window.Clerk.load(); resolve(window.Clerk); } catch (e) { reject(e); } };
      s.onerror = () => reject(new Error("{{s.loadFailed|dq}}"));
      document.head.appendChild(s);
    });
  }

  function render(path, status, body) {
    const sec = document.createElement("section"); sec.className = "ap-block";
    const head = `<h2 class="cb-h2"><code>GET ${esc(path)}</code> <small class="muted">${status || ""}</small></h2>`;
    if (!status || status >= 400 || !body || body.ok === false) { sec.innerHTML = `${head}<p class="ap-err">${esc(body?.error || "{{s.error|dq}}")}${body?.reason ? `: ${esc(body.reason)}` : ""}</p>`; return sec; }
    const arr = Object.values(body).find((v) => Array.isArray(v) && v.length && typeof v[0] === "object" && v[0]);
    if (arr) {
      const cols = [...new Set(arr.slice(0, 20).flatMap((r) => Object.keys(r)))].slice(0, 7);
      const cell = (v) => esc(v == null ? "" : typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80));
      sec.innerHTML = `${head}<div class="cb-table" role="region" tabindex="0" aria-label="${esc(path)}"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${arr.slice(0, 50).map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${arr.length > 50 ? `<p class="muted">${n(arr.length - 50)} {{s.moreRows|tl}}</p>` : ""}`;
    } else {
      sec.innerHTML = `${head}<dl class="cb-defs">${Object.entries(body).slice(0, 24).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v).slice(0, 160) : v)}</dd></div>`).join("")}</dl>`;
    }
    return sec;
  }

  async function show(clerk) {
    const user = clerk.user;
    if (!user) { state.textContent = "{{s.notSignedIn|dq}}"; return; }
    state.textContent = `{{s.signedInAs|tl}} ${user.primaryEmailAddress?.emailAddress || user.id}`;
    if (signin) { signin.textContent = "{{s.signOut|dq}}"; signin.onclick = () => clerk.signOut().then(() => location.reload()); }
    const token = await clerk.session?.getToken();
    const eps = JSON.parse(data.dataset.endpoints || "[]");
    data.hidden = false; data.textContent = "";
    if (!eps.length) data.innerHTML = `<p class="muted">{{s.noData|tl}}</p>`;
    for (const ep of eps) {
      try {
        const r = await fetch(ep, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, credentials: "omit" });
        data.appendChild(render(ep, r.status, await r.json().catch(() => null)));   // a body that is not JSON is shown as empty next to its status
      } catch { data.appendChild(render(ep, 0, { error: "{{s.unavailable|dq}}" })); }
    }
    document.querySelectorAll("[data-app-post]").forEach((b) => {
      b.disabled = false;
      b.addEventListener("click", async () => {
        b.setAttribute("aria-busy", "true");
        const r = await fetch(b.dataset.appPost, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }).catch(() => null);   // a network failure is shown as status 0 by render below
        const out = await r?.json().catch(() => null);   // a body that is not JSON is shown as empty
        b.removeAttribute("aria-busy");
        if (out?.url && /^https:\/\//.test(out.url)) location.assign(out.url); else notify("error", "{{s.unavailable|dq}}", out?.error || "{{s.error|dq}}");
      });
    });
  }

  if (signin) signin.addEventListener("click", async () => {
    if (!onHost) { location.assign(`https://${host}/${location.pathname.slice(base.length)}`); return; }
    signin.setAttribute("aria-busy", "true");
    try {
      const clerk = await loadClerk();
      if (!clerk.user) { clerk.openSignIn({ afterSignInUrl: location.href }); clerk.addListener(({ user }) => { if (user) show(clerk); }); }
      else await show(clerk);
    } catch (e) { notify("error", "{{s.unavailable|dq}}", e.message); state.textContent = "{{s.loadFailed|dq}}"; }
    finally { signin.removeAttribute("aria-busy"); }
  });
  if (!onHost) state.textContent = `{{s.preview|tl}} ${host}`;
})();
