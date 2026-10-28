/**
 * A developer portal's API reference, rendered from OpenAPI 3.x documents: an index of every contract, one page per
 * contract with every operation (method, path, summary, description, auth, parameters, request body fields and
 * responses, grouped by tag), a machine-readable index.json and the raw contract files next to their pages.
 *
 *   { type: "reference", path: "/developers/api/", specs: [{ file, doc, raw? }], source?: { label, url },
 *     schema?: "<project>.openapi-index.v1", security?: { <scheme>: "label" }, generator?,
 *     content: { en: { index: { title, description, ogTitle?, ogImage?, eyebrow, h1, lead, note? }, spec: { title, description,
 *       eyebrow }, labels: { operations, servers, version, source, auth, parameters, body, responses, required,
 *       groups, all, json, yaml, none }, bar: [{ href, label }] } } }
 *   doc   the parsed OpenAPI document (the project parses YAML or JSON; the kit has no YAML dependency)
 *   raw   the file's text, published at <path><file> when given
 * Strings may use {title}, {count}, {file}, {specs} and {operations}.
 *
 * normalizeSpec(doc, file) → { id, file, title, version, description, servers, ops } is exported for projects that
 * want the same data elsewhere (a lab, llms.txt).
 */
import { fill } from "../locale.js";
import { esc, innerPage, webPageLd, crumbsLd } from "./shell.js";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const text = (s) => esc(String(s ?? "").trim()).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").split(/\n\s*\n/).filter(Boolean).map((p) => `<p>${p.replace(/\n/g, " ")}</p>`).join("");
const short = (s, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const specId = (file) => String(file).replace(/\.(openapi\.)?(ya?ml|json)$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const opAnchor = (o) => `${o.method.toLowerCase()}-${o.path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
const tagId = (t) => `tag-${String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/** One OpenAPI document → the reference's data ($refs inside the document are followed, up to 8 hops). */
export function normalizeSpec(doc, file) {
  const ref = (o) => { let x = o, n = 0; while (x && x.$ref && n++ < 8) { const p = x.$ref.replace(/^#\//, "").split("/"); x = p.reduce((a, k) => a?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc); } return x || {}; };
  const ops = [];
  for (const [path, item] of Object.entries(doc?.paths || {})) {
    for (const method of METHODS) {
      const o = item?.[method]; if (!o) continue;
      const params = [...(item.parameters || []), ...(o.parameters || [])].map(ref).filter((p) => p.name);
      const body = ref(o.requestBody);
      const media = body?.content?.["application/json"] || Object.values(body?.content || {})[0];
      const schema = ref(media?.schema);
      const fields = Object.entries(schema.properties || {}).map(([k, v]) => { const r = ref(v); return { name: k, type: r.type || (r.enum ? "enum" : "object"), required: (schema.required || []).includes(k), description: r.description || (r.enum ? `One of ${r.enum.join(", ")}` : "") }; });
      const responses = Object.entries(o.responses || {}).map(([code, r]) => ({ code, description: ref(r).description || "" }));
      const security = (o.security || doc.security || []).flatMap((s) => Object.keys(s));
      ops.push({ method: method.toUpperCase(), path, id: o.operationId || `${method}-${path}`, summary: o.summary || "", description: o.description || "", tag: (o.tags || ["General"])[0],
        params: params.map((p) => ({ name: p.name, in: p.in, required: Boolean(p.required), type: ref(p.schema).type || "", description: p.description || "" })), body: fields, bodyRequired: Boolean(body?.required), responses, security, deprecated: Boolean(o.deprecated) });
    }
  }
  return { id: specId(file), file, title: doc?.info?.title || specId(file), version: doc?.info?.version || "", description: doc?.info?.description || "", servers: (doc?.servers || []).map((s) => s.url), ops };
}

/** Problems with a reference page's specs. */
export function checkReference(specs, where = "reference") {
  const p = [], ids = new Set();
  if (!Array.isArray(specs) || !specs.length) return [`${where}: no specs`];
  for (const s of specs) {
    if (!s?.file || !/^[\w.-]+$/.test(s.file)) { p.push(`${where}: spec file name «${s?.file}» must be a plain file name`); continue; }
    if (!s.doc || typeof s.doc !== "object") p.push(`${where} ${s.file}: doc must be the parsed OpenAPI document`);
    else if (!/^3\./.test(String(s.doc.openapi || ""))) p.push(`${where} ${s.file}: not an OpenAPI 3.x document`);
    const id = specId(s.file);
    if (ids.has(id)) p.push(`${where} ${s.file}: duplicate id ${id}`); ids.add(id);
  }
  return p;
}

export function referenceIndexJson(specs, { schema = "kit.openapi-index.v1", source, base }) {
  return JSON.stringify({
    schema, ...(source ? { source: source.url || source.label } : {}),
    total_operations: specs.reduce((n, s) => n + s.ops.length, 0),
    specs: specs.map((s) => ({ id: s.id, title: s.title, version: s.version, servers: s.servers, operations: s.ops.length, file: `${base}${s.file}`, page: `${base}${s.id}/` })),
  }, null, 1) + "\n";
}

export function renderReference(page, ctx) {
  const c = ctx.c, Lb = c.labels || {};
  const specs = (page.specs || []).map((s) => ({ ...normalizeSpec(s.doc, s.file), raw: s.raw }));
  const base = ctx.pathOf(page.path);
  const total = specs.reduce((n, s) => n + s.ops.length, 0);
  const vars = { specs: ctx.L.toDigits(specs.length), operations: ctx.L.toDigits(total) };
  const f = (s, more = {}) => fill(String(s ?? ""), { ...vars, ...more });
  const secLabel = page.security || {};
  const files = {};
  const indexUrl = ctx.url + base;

  // index
  const I = c.index;
  files["index.html"] = innerPage(ctx, {
    path: page.path, title: f(I.title), description: f(I.description), ogTitle: f(I.ogTitle || I.h1), ogImage: I.ogImage, generator: page.generator,
    bar: c.bar, styles: page.styles, scripts: page.scripts,
    graph: [webPageLd({ type: "CollectionPage", name: f(I.ogTitle || I.h1), description: f(I.description), url: indexUrl, ctx, extra: { mainEntity: { "@type": "ItemList", itemListElement: specs.map((s, i) => ({ "@type": "ListItem", position: i + 1, name: s.title, url: `${indexUrl}${s.id}/` })) } } }),
      crumbsLd([[ctx.chrome.strings.home, ctx.homeUrl], ...(page.crumbs || []).map(([l, h]) => [l, ctx.url + ctx.pathOf(h)]), [f(I.crumb || I.h1), indexUrl]])],
    body: `  <section class="hero-t wrap sx-hero">
    <p class="eyebrow">${I.eyebrow}</p>
    <h1>${f(I.h1)}</h1>
    <p>${f(I.lead)}</p>
  </section>
  <section class="section sx-sec rf-sec">
    <div class="wrap">
      ${I.note ? `<p class="tx-note"><b>${Lb.contracts ?? "Contracts"}</b><span>${f(I.note)} <a class="link" href="${base}index.json">${Lb.json ?? "JSON"}</a></span></p>` : ""}
      <div class="sx-grid sx-grid--3 rf-grid">
${specs.map((s) => `        <a class="sx-card" href="${base}${s.id}/"><span class="sx-card__group">${ctx.L.toDigits(s.ops.length)} ${Lb.operations ?? "operations"}${s.version ? ` · v${esc(s.version)}` : ""}</span><h2 class="sx-card__name">${esc(s.title)}</h2><p class="sx-card__head">${esc(short(s.description.split(/\n\s*\n/)[0], 170) || s.servers.join(", "))}</p><span class="sx-card__go">${esc(s.file)}</span></a>`).join("\n")}
      </div>
    </div>
  </section>`,
  });

  // one page per contract
  for (const s of specs) {
    const tags = [...new Set(s.ops.map((o) => o.tag))];
    const u = `${indexUrl}${s.id}/`;
    const S = c.spec;
    files[`${s.id}/index.html`] = innerPage(ctx, {
      path: `${page.path}${s.id}/`, title: f(S.title, { title: s.title }), description: f(S.description, { title: s.title, count: ctx.L.toDigits(s.ops.length), file: s.file }),
      ogTitle: s.title, ogImage: I.ogImage, generator: page.generator, styles: page.styles, scripts: page.scripts,
      bar: [{ href: base, label: Lb.all ?? "All contracts" }, ...(s.raw ? [{ href: `${base}${s.file}`, label: Lb.yaml ?? "Source" }] : [])],
      graph: [webPageLd({ type: "TechArticle", name: s.title, description: f(S.description, { title: s.title, count: ctx.L.toDigits(s.ops.length), file: s.file }), url: u, ctx }),
        crumbsLd([[ctx.chrome.strings.home, ctx.homeUrl], ...(page.crumbs || []).map(([l, h]) => [l, ctx.url + ctx.pathOf(h)]), [f(I.crumb || I.h1), indexUrl], [s.title, u]])],
      body: `  <section class="hero-t wrap sx-hero">
    <p class="eyebrow">${S.eyebrow}</p>
    <h1>${esc(s.title)}</h1>
    <p>${ctx.L.toDigits(s.ops.length)} ${Lb.operations ?? "operations"} · <code>${esc(s.file)}</code></p>
  </section>
  <section class="section sx-sec rf-sec">
    <div class="wrap cb-prose rf-spec">
      <dl class="cb-defs rf-meta"><div><dt>${Lb.servers ?? "Servers"}</dt><dd>${s.servers.map((x) => `<code>${esc(x)}</code>`).join(" ") || (Lb.none ?? "—")}</dd></div><div><dt>${Lb.version ?? "Version"}</dt><dd>${esc(s.version || (Lb.none ?? "—"))}</dd></div><div><dt>${Lb.source ?? "Source"}</dt><dd>${s.raw ? `<a class="link" href="${base}${esc(s.file)}">${esc(s.file)}</a>` : esc(s.file)}</dd></div></dl>
      ${s.description ? `<div class="rf-about">${text(s.description)}</div>` : ""}
      <nav class="chips2 rf-tags" aria-label="${esc(Lb.groups ?? "Groups")}">${tags.map((t) => `<a class="chip2" href="#${tagId(t)}">${esc(t)} <small>${ctx.L.toDigits(s.ops.filter((o) => o.tag === t).length)}</small></a>`).join("")}</nav>
${tags.map((t) => `      <h2 class="cb-h2" id="${tagId(t)}">${esc(t)}</h2>
${s.ops.filter((o) => o.tag === t).map((o) => `      <details class="rf-op" id="${opAnchor(o)}">
        <summary><span class="rf-m rf-m--${o.method.toLowerCase()}">${o.method}</span><code class="rf-op__path">${esc(o.path)}</code>${o.deprecated ? '<span class="rf-dep">deprecated</span>' : ""}<span class="rf-op__sum">${esc(o.summary)}</span></summary>
        <div class="rf-op__body">
          ${o.description ? text(o.description) : ""}
          ${o.security.length ? `<p class="rf-op__sec"><b>${Lb.auth ?? "Auth"}:</b> ${o.security.map((x) => esc(secLabel[x] || x)).join(" / ")}</p>` : ""}
          ${o.params.length ? `<h3>${Lb.parameters ?? "Parameters"}</h3><div class="cb-table" role="region" aria-label="${esc(Lb.parameters ?? "Parameters")}" tabindex="0"><table><thead><tr><th>name</th><th>in</th><th>type</th><th>description</th></tr></thead><tbody>${o.params.map((p) => `<tr><td><code>${esc(p.name)}</code>${p.required ? ` <b>${Lb.required ?? "required"}</b>` : ""}</td><td>${esc(p.in)}</td><td>${esc(p.type)}</td><td>${esc(short(p.description, 220))}</td></tr>`).join("")}</tbody></table></div>` : ""}
          ${o.body.length ? `<h3>${Lb.body ?? "Request body"}${o.bodyRequired ? ` (${Lb.required ?? "required"})` : ""}</h3><div class="cb-table" role="region" aria-label="${esc(Lb.body ?? "Request body")}" tabindex="0"><table><thead><tr><th>field</th><th>type</th><th>description</th></tr></thead><tbody>${o.body.map((p) => `<tr><td><code>${esc(p.name)}</code>${p.required ? ` <b>${Lb.required ?? "required"}</b>` : ""}</td><td>${esc(p.type)}</td><td>${esc(short(p.description, 220))}</td></tr>`).join("")}</tbody></table></div>` : ""}
          ${o.responses.length ? `<h3>${Lb.responses ?? "Responses"}</h3><ul class="cb-list cb-list--tight">${o.responses.map((r) => `<li><code>${esc(r.code)}</code> ${esc(short(r.description, 260))}</li>`).join("")}</ul>` : ""}
        </div>
      </details>`).join("\n")}`).join("\n")}
    </div>
  </section>`,
    });
    if (s.raw) files[s.file] = s.raw;
  }
  files["index.json"] = referenceIndexJson(specs, { schema: page.schema, source: page.source, base });
  return files;
}
