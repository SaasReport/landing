/**
 * Auth-gated app shells: a customer console, an admin console, a billing portal, on the kit's chrome. One page per
 * view of the app, each wired to the backend it already has (the views' endpoints) behind the auth it already has.
 * The pages carry no data of their own: without a session they show the sign-in state and the API contract the view
 * calls (endpoint, methods, what it does, the auth model); after sign-in the generated /apps.js calls the view's GET
 * endpoints with the session token and renders what they return (an array of objects as a table, otherwise the
 * fields), and its POST actions (e.g. "open the billing portal") follow the URL the backend returns. Nothing is ever
 * sample data presented as real.
 *
 *   { type: "apps", path: "/app/", surface: Surface, content: { en: { …strings, script: { …apps.js strings } } } }
 *
 * Surface:
 *   name, host                the app's name and its own host (app.example.org): sign-in happens there; on any other
 *                             host the page is a preview and "Sign in" opens the same view on the host
 *   auth                      HTML: the auth model, shown on every view
 *   signIn                    { provider: "clerk", frontendApi, publishableKey } (public values) or null (no sign-in)
 *   groups                    [[label, RegExp on the view id]]: the section nav (views matching none go under strings.more)
 *   views                     [{ id, path, title, endpoints: [{ path, methods: ["GET"], doc }], children?: [{ id, title }],
 *                             legacy? }]   path is relative to the page path ("" for the surface's home, "dashboard/")
 *   actions                   [{ label, post }] buttons enabled after sign-in that POST and follow the returned { url }
 *   backend                   HTML: where the endpoints are served (shown on every view)
 *   robots                    default "noindex, nofollow"
 * Strings (content.<code>): eyebrow, signIn, openOn ("Open on {host}"), signedOut, notSample, contract, auth,
 *   endpoint, methods, does, noApi, children, sections, more, backend, apiRef ({ href, label }), and script: the
 *   client strings (signedInAs, notSignedIn, preview, loadFailed, unavailable, noData, moreRows, error, signOut).
 */
import { fill } from "../locale.js";
import { esc, innerPage, webPageLd, crumbsLd } from "./shell.js";

export const APPS_SCRIPT = "apps.js";

/** Problems with an apps surface. */
export function checkApps(surface, where = "apps") {
  const p = [];
  if (!surface || typeof surface !== "object") return [`${where}: surface missing`];
  for (const k of ["name", "host", "auth"]) if (!surface[k]) p.push(`${where}: surface.${k} missing`);
  if (!/^[a-z0-9.-]+$/.test(surface.host || "")) p.push(`${where}: surface.host must be a host name`);
  if (surface.signIn && surface.signIn.provider !== "clerk") p.push(`${where}: signIn.provider must be "clerk" (or signIn: null)`);
  if (surface.signIn?.provider === "clerk" && (!/^https:\/\//.test(surface.signIn.frontendApi || "") || !/^pk_(live|test)_/.test(surface.signIn.publishableKey || ""))) p.push(`${where}: clerk signIn needs frontendApi (https://…) and a publishable key (pk_…)`);
  if (!Array.isArray(surface.views) || !surface.views.length) p.push(`${where}: no views`);
  const seen = new Set();
  for (const v of surface.views || []) {
    if (!v.id || !v.title) p.push(`${where}: a view needs id and title`);
    if (!/^([\w-]+\/)*$/.test(v.path ?? "x")) p.push(`${where} ${v.id}: path must be relative, like "dashboard/" or ""`);
    if (seen.has(v.path)) p.push(`${where} ${v.id}: duplicate path «${v.path}»`); seen.add(v.path);
    for (const e of v.endpoints || []) if (!/^\/[\w\-/.{}:$]*$/.test(e.path || "")) p.push(`${where} ${v.id}: endpoint path «${e.path}»`);
  }
  for (const a of surface.actions || []) if (!a.label || !/^\//.test(a.post || "")) p.push(`${where}: action needs label and a post path`);
  return p;
}

export function renderApps(page, ctx) {
  const S = page.surface, c = ctx.c;
  const base = ctx.pathOf(page.path);
  const views = S.views;
  const groups = (S.groups || []).map(([label, re]) => [label, views.filter((v) => re.test(v.id))]);
  const rest = views.filter((v) => !groups.some(([, vs]) => vs.includes(v)));
  if (rest.length && groups.length) groups.push([c.more ?? "More", rest]);
  const navGroups = groups.length ? groups : [[c.sections ?? "Sections", views]];
  const single = views.length === 1;
  const nav = (cur) => `<nav class="ap-nav" aria-label="${esc(fill(c.sections ?? "Sections", { name: S.name }))}"><details open><summary>${c.sections ?? "Sections"}</summary>${navGroups.filter(([, vs]) => vs.length).map(([g, vs]) => `<h2>${esc(g)}</h2><ul>${vs.map((v) => `<li><a href="${base}${v.path}"${v === cur ? ' aria-current="page"' : ""}>${esc(v.title)}</a></li>`).join("")}</ul>`).join("")}</details></nav>`;
  const signIn = S.signIn ? ` data-provider="${esc(S.signIn.provider)}" data-frontend-api="${esc(S.signIn.frontendApi)}" data-publishable-key="${esc(S.signIn.publishableKey)}"` : "";
  const files = {};
  for (const v of views) {
    const path = `${page.path}${v.path}`;
    const u = ctx.url + ctx.pathOf(path);
    const gets = (v.endpoints || []).filter((e) => (e.methods || []).some((m) => /^(get|any)$/i.test(m))).map((e) => e.path);
    const onHost = `https://${S.host}/${v.path}`;
    const body = `  <section class="wrap ap${single ? " ap--single" : ""}">
    ${single ? "" : nav(v)}
    <div class="ap-main">
      <p class="eyebrow">${esc(S.name)}</p>
      <h1>${esc(v.title)}</h1>
      <div class="ap-session" data-app-session data-host="${esc(S.host)}" data-base="${esc(base)}"${signIn}>
        <p><b data-app-state>${c.signedOut ?? "Sign in to see your data."}</b> <span class="muted">${c.notSample ?? "This view shows only what the API returns for your session; nothing on this page is sample data."}</span></p>
        <div class="actions">${S.signIn ? `<button class="btn btn--primary" type="button" data-app-signin>${c.signIn ?? "Sign in"}</button>` : ""}${(S.actions || []).map((a) => `<button class="btn btn--ghost" type="button" data-app-post="${esc(a.post)}" disabled>${esc(a.label)}</button>`).join("")}<a class="btn btn--ghost" href="${esc(onHost)}">${esc(fill(c.openOn ?? "Open on {host}", { host: S.host }))}</a></div>
      </div>
      <div class="ap-data" data-app-data data-endpoints="${esc(JSON.stringify(gets))}" hidden></div>
      <h2 class="cb-h2">${c.contract ?? "API contract"}</h2>
      <p class="muted">${c.auth ?? "Auth"}: ${S.auth}</p>
      ${(v.endpoints || []).length ? `<div class="cb-table" role="region" aria-label="${esc(c.contract ?? "API contract")}" tabindex="0"><table><thead><tr><th>${c.endpoint ?? "endpoint"}</th><th>${c.methods ?? "methods"}</th><th>${c.does ?? "what it does"}</th></tr></thead><tbody>${v.endpoints.map((e) => `<tr><td><code>${esc(e.path)}</code></td><td>${esc((e.methods || []).join(", ").toUpperCase() || "—")}</td><td>${esc(e.doc || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p>${c.noApi ?? "This view calls no API of its own."}</p>`}
      ${v.children?.length ? `<h2 class="cb-h2">${c.children ?? "Views inside this section"}</h2><ul class="cb-list">${v.children.map((x) => `<li><code>${esc(x.id)}</code>: ${esc(x.title)}</li>`).join("")}</ul>` : ""}
      ${S.backend ? `<p class="tx-note"><b>${c.backend ?? "Backend"}</b><span>${S.backend}${v.legacy ? ` <code>${esc(v.legacy)}</code>` : ""}</span></p>` : ""}
    </div>
  </section>`;
    files[`${v.path}index.html`] = innerPage(ctx, {
      path, title: `${v.title} | ${S.name}`, description: fill(c.description ?? "{name}: {title}. Requires sign-in.", { name: S.name, title: v.title, host: S.host }),
      ogTitle: v.title, robots: S.robots || "noindex, nofollow", bodyClass: "tpage ap-page", styles: page.styles, scripts: [...(page.scripts || []), "/apps.js"],
      bar: [{ href: base, label: esc(S.name) }, ...(c.apiRef ? [c.apiRef] : [])], generator: page.generator,
      graph: [webPageLd({ name: v.title, url: u, ctx }), crumbsLd([[ctx.chrome.strings.home, ctx.homeUrl], [S.name, ctx.url + base], ...(v.path ? [[v.title, u]] : [])])],
      body,
    });
  }
  return files;
}
