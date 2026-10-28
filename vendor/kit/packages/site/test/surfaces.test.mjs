// The surfaces of a product site: content pages from blocks, the OpenAPI reference, the auth-gated app shells and
// the status board, built with the sample project (English and Arabic) plus these page types.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildSite, checkProject, renderBlocks, normalizeSpec, checkContent, checkApps, checkReference, trademarker, THEME_CSS } from "../src/index.js";
import sample from "../../../examples/site-sample/site.config.js";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Example Runtime API", version: "1.2.0", description: "Decide on an action.\n\nUse `POST /decide`." },
  servers: [{ url: "https://api.example.org" }],
  security: [{ ApiKey: [] }],
  components: {
    parameters: { Id: { name: "id", in: "path", required: true, schema: { type: "string" }, description: "The decision id" } },
    schemas: { Decide: { type: "object", required: ["action"], properties: { action: { type: "string", description: "What the agent wants to do" }, mode: { enum: ["live", "test"] } } } },
  },
  paths: {
    "/decide": { post: { tags: ["Runtime"], summary: "Decide", operationId: "decide", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Decide" } } } }, responses: { 200: { description: "The decision" }, 422: { description: "Invalid" } } } },
    "/decisions/{id}": { parameters: [{ $ref: "#/components/parameters/Id" }], get: { tags: ["Evidence"], summary: "One decision", responses: { 200: { description: "OK" } } } },
  },
};

const pages = [
  { path: "/pricing/", title: "Pricing", description: "Plans.", hero: { eyebrow: "Pricing", title: "Start <span class=\"t-accent\">free</span>", lead: "Then scale.", actions: [{ href: "/contact/", label: "Talk to us" }] },
    sections: [{ id: "plans", blocks: [
      { t: "h", level: 2, html: "Plans" }, { t: "p", html: "Two plans.", lead: true }, { t: "list", items: ["Open", "Pilot"] },
      { t: "defs", items: [{ term: "Seat", def: "One person" }] }, { t: "table", head: ["Plan", "Price"], rows: [["Open", "0"]] },
      { t: "code", text: "npm i <x>" }, { t: "quote", html: "Quote", cite: "Someone" }, { t: "details", summary: "More", blocks: [{ t: "p", html: "Inside" }] },
      { t: "cards", items: [{ href: "/a/", title: "<a href=\"/x\">A</a>", text: "a" }, { title: "B" }] }, { t: "actions", items: [{ href: "/b/", label: "Go" }] },
      { t: "note", label: "Note", html: "Fictional." }, { t: "form", id: "contact" }] }],
    band: { title: "Ready?", actions: [{ href: "/contact/", label: "Contact" }] } },
  { path: "/legal/terms/", title: "Terms", hero: { title: "Terms" }, crumbs: [["Legal", "/legal/terms/"]], robots: "noindex, follow", sections: [{ blocks: [{ t: "p", html: "Text" }] }],
    ld: { nodes: [{ "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A." } }] }] } },
];

const surface = (single) => ({
  name: single ? "Billing" : "Console", host: single ? "billing.example.org" : "app.example.org", auth: "Session token (<code>Bearer</code>).",
  signIn: { provider: "clerk", frontendApi: "https://clerk.example.org", publishableKey: "pk_test_ZXhhbXBsZQ" },
  groups: single ? [] : [["Overview", /^dashboard/], ["Runtime", /^decisions/]],
  views: single ? [{ id: "billing", path: "", title: "Billing", endpoints: [{ path: "/api/v1/billing", methods: ["GET"], doc: "Plan and invoices" }] }]
    : [{ id: "dashboard", path: "", title: "Dashboard", endpoints: [{ path: "/api/v1/summary", methods: ["GET"], doc: "Counts" }] },
      { id: "decisions", path: "decisions/", title: "Decisions", endpoints: [{ path: "/api/v1/decisions", methods: ["GET", "POST"], doc: "List" }], children: [{ id: "decisions/[id]", title: "One decision" }] },
      { id: "settings", path: "settings/", title: "Settings", endpoints: [] }],
  actions: single ? [{ label: "Manage payment methods", post: "/api/v1/portal-session" }] : [],
  backend: "Served by the existing backend.",
});

const project = {
  ...sample,
  locales: [{ code: "en", path: "/" }],
  content: { en: sample.content.en },
  pages: [
    { type: "content", path: "/", pages, renderers: { form: (b) => `<form class="cform" data-cform="${b.id}"></form>` }, content: { en: {} } },
    { type: "reference", path: "/developers/api/", specs: [{ file: "runtime.openapi.yaml", doc: SPEC, raw: "openapi: 3.1.0\n" }], source: { url: "https://github.com/example/open-api" }, security: { ApiKey: "API key" },
      content: { en: { index: { title: "API reference | Example", description: "{specs} contracts, {operations} operations.", eyebrow: "API", h1: "API reference", lead: "Every operation.", note: "{specs} contracts." },
        spec: { title: "{title} | API reference", description: "{title}: {count} operations ({file}).", eyebrow: "Contract" }, bar: [{ href: "/developers/", label: "Developers" }] } } },
    { type: "apps", path: "/app/", surface: surface(false), content: { en: { apiRef: { href: "/developers/api/", label: "API" } } } },
    { type: "apps", path: "/billing/", surface: surface(true), content: { en: {} } },
    { type: "statusboard", path: "/status/", content: { en: { meta: { title: "Status | Example", description: "Status." }, hero: { eyebrow: "Status", title: "Checking", lead: "Live." }, components: "Components", monitor: "Journeys", checks: "Build checks", runs: "Builds", bar: [] } } },
  ],
};

const { files, sitemap } = buildSite(project, { root: SAMPLE });

test("the surfaces validate and build: no problems, every page in the sitemap", () => {
  assert.deepEqual(checkProject(project), []);
  for (const f of ["pricing/index.html", "legal/terms/index.html", "developers/api/index.html", "developers/api/runtime/index.html", "developers/api/index.json", "developers/api/runtime.openapi.yaml",
    "app/index.html", "app/decisions/index.html", "app/settings/index.html", "billing/index.html", "status/index.html", "surfaces.css", "apps.js", "statusboard.js"]) assert.ok(files[f], f);
  assert.ok(THEME_CSS.includes("surfaces.css"));
  for (const p of ["pricing/", "developers/api/runtime/", "status/"]) assert.ok(sitemap.some((u) => u.loc === `https://example.org/${p}`), p);
  for (const p of ["app/decisions/", "billing/", "legal/terms/"]) assert.ok(!sitemap.some((u) => u.loc === `https://example.org/${p}`), `${p} is noindex: not in the sitemap`);
});

test("content pages: hero, every block type, the project's renderer, band, SEO head and JSON-LD", () => {
  const h = files["pricing/index.html"];
  assert.match(h, /<title>Pricing<\/title>/);
  assert.match(h, /<link rel="canonical" href="https:\/\/example\.org\/pricing\/">/);
  assert.match(h, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(h, /"@type":"WebPage"/);
  assert.match(h, /<h1>Start <span class="t-accent">free<\/span><\/h1>/);
  for (const cls of ["cb-h2", "cb-lead", "cb-list", "cb-defs", "cb-table", "cb-code", "cb-quote", "cb-details", "cb-cards", "cb-actions", "tx-note", "sx-band"]) assert.match(h, new RegExp(`class="[^"]*${cls}`), cls);
  assert.match(h, /npm i &lt;x&gt;/, "code is escaped");
  assert.match(h, /<form class="cform" data-cform="contact">/, "custom renderer");
  assert.doesNotMatch(h, /<a class="sx-card"[^>]*>[^]*?<a href="\/x"/, "no link inside a link card");
  assert.match(h, /<link rel="stylesheet" href="\/surfaces\.css\?v=[a-f0-9]{10}">/);
  assert.match(files["legal/terms/index.html"], /<meta name="robots" content="noindex, follow">/);
  assert.match(files["legal/terms/index.html"], /"@type":"FAQPage"/, "extra JSON-LD nodes");
  assert.doesNotMatch(h, /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/, "no inline script");
  assert.deepEqual(checkContent([{ path: "/x/", title: "X", hero: { title: "X" }, sections: [{ blocks: [{ t: "nope" }] }] }], { base: "/" }), ["content /x/ sections[0]: unknown block type \"nope\""]);
  assert.equal(renderBlocks([{ t: "h", level: 2, html: "A &amp; B" }]), '<h2 class="cb-h2" id="a-b">A &amp; B</h2>');
});

test("reference: operations from OpenAPI with $refs, parameters, body fields, responses, auth; index.json", () => {
  const s = normalizeSpec(SPEC, "runtime.openapi.yaml");
  assert.equal(s.id, "runtime");
  assert.equal(s.ops.length, 2);
  const decide = s.ops.find((o) => o.id === "decide");
  assert.deepEqual(decide.body.map((b) => [b.name, b.required]), [["action", true], ["mode", false]]);
  assert.deepEqual(decide.security, ["ApiKey"]);
  assert.equal(s.ops[1].params[0].name, "id");
  const h = files["developers/api/runtime/index.html"];
  assert.match(h, /<span class="rf-m rf-m--post">POST<\/span><code class="rf-op__path">\/decide<\/code>/);
  assert.match(h, /<b>Auth:<\/b> API key/);
  assert.match(h, /<code>id<\/code> <b>required<\/b>/);
  assert.match(h, /Use <code>POST \/decide<\/code>\./);
  assert.match(files["developers/api/index.html"], /1 contracts, 2 operations/);
  const idx = JSON.parse(files["developers/api/index.json"]);
  assert.equal(idx.total_operations, 2);
  assert.equal(idx.specs[0].page, "/developers/api/runtime/");
  assert.deepEqual(checkReference([{ file: "a.yaml", doc: { openapi: "2.0" } }]), ["reference a.yaml: not an OpenAPI 3.x document"]);
});

test("apps: one page per view, nav, API contract, sign-in data, no data of their own, noindex; billing as one view", () => {
  const d = files["app/decisions/index.html"];
  assert.match(d, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(d, /<a href="\/app\/decisions\/" aria-current="page">Decisions<\/a>/);
  assert.match(d, /data-host="app\.example\.org"/);
  assert.match(d, /data-provider="clerk" data-frontend-api="https:\/\/clerk\.example\.org" data-publishable-key="pk_test_ZXhhbXBsZQ"/);
  assert.match(d, /data-endpoints="\[&quot;\/api\/v1\/decisions&quot;\]"/);
  assert.match(d, /<td><code>\/api\/v1\/decisions<\/code><\/td><td>GET, POST<\/td>/);
  assert.match(d, /<code>decisions\/\[id\]<\/code>: One decision/);
  assert.match(d, /<script src="\/apps\.js\?v=[a-f0-9]{10}" defer>/);
  assert.match(files["app/settings/index.html"], /This view calls no API of its own\./);
  const b = files["billing/index.html"];
  assert.match(b, /class="wrap ap ap--single"/);
  assert.doesNotMatch(b, /class="ap-nav"/);
  assert.match(b, /data-app-post="\/api\/v1\/portal-session" disabled>Manage payment methods/);
  assert.equal(new vm.Script(files["apps.js"]) instanceof vm.Script, true, "apps.js parses");
  assert.match(files["apps.js"], /Preview: sign in on/);
  assert.deepEqual(checkApps({ name: "X", host: "x.org", auth: "a", signIn: { provider: "oidc" }, views: [{ id: "a", path: "", title: "A" }] }), ['apps: signIn.provider must be "clerk" (or signIn: null)']);
});

test("status board: the three sources (defaults), strings, template sections", () => {
  const h = files["status/index.html"];
  for (const k of ["data-st-components", "data-st-monitor", "data-st-checks", "data-st-runs"]) assert.match(h, new RegExp(k));
  assert.match(h, /<link rel="stylesheet" href="\/surfaces\.css\?v=/);
  const js = files["statusboard.js"];
  assert.ok(new vm.Script(js));
  assert.match(js, /components: "\/api\/status\/components", monitor: "\/api\/status", build: "\/status\.json"/);
  assert.match(js, /All systems normal/);
});

test("trademarker: a multi-word name and its shorter part are marked once, and marking again changes nothing", () => {
  const tm = trademarker({ names: ["Brand", "Brand Protocol"], mark: "™" });
  const once = tm("a.html", "<p>Brand Protocol, Brand and Brand Protocol™.</p>");
  assert.equal(once, "<p>Brand Protocol™, Brand™ and Brand Protocol™.</p>");
  assert.equal(tm("a.html", once), once);
  assert.equal(tm("a.js", tm("a.js", 'const a = "Brand Protocol";')), 'const a = "Brand Protocol™";');
});

test("trademarker: phrases in except (a legal entity) stay unmarked", () => {
  const tm = trademarker({ names: ["Brand Protocol", "Brand"], mark: "™", except: ["Brand Protocol Ltd"] });
  assert.equal(tm("a.html", "<p>© Brand Protocol Ltd. Brand Protocol and Brand.</p>"), "<p>© Brand Protocol Ltd. Brand Protocol™ and Brand™.</p>");
});

test("trademarker: hyphenated compounds (an organisation name) are left alone; the name alone still gets the mark", () => {
  const tm = trademarker({ names: ["Brand"], mark: "™" });
  assert.equal(tm("a.html", "<p>Brand and Brand-Org on github.com/Brand-Org; Brand.</p>"), "<p>Brand™ and Brand-Org on github.com/Brand-Org; Brand™.</p>");
});

test("widgets page: renders the generated widgets in the site's chrome with widgets.css (from tokens) and the runtime", async () => {
  const { default: generated } = await import("../../widgets/test/fixture/widgets.generated.json", { with: { type: "json" } });
  const project = { ...sample, out: "out", pages: [{ type: "widgets", path: "/examples/", generated, content: { en: { meta: { title: "Examples" } } } }] };
  assert.deepEqual(checkProject(project), []);
  const { files: f, sitemap: sm } = buildSite(project, { root: SAMPLE });
  const html = f["examples/index.html"];
  assert.match(html, /<link rel="stylesheet" href="\/widgets\.css\?v=[a-f0-9]{10}">/);
  assert.match(html, /<script src="\/widgets\.js\?v=[a-f0-9]{10}" defer><\/script>/);
  assert.match(html, /data-widget="chain"/); assert.match(html, /<h1>Examples<\/h1>/);
  assert.match(f["widgets.css"], /--kw-accent:var\(--c-accent\)/, "the widgets read the accent role");
  assert.ok(sm.some((x) => x.loc.endsWith("/examples/")));
  assert.match(checkProject({ ...project, pages: [{ type: "widgets", path: "/examples/", generated: {}, content: { en: {} } }] }).join("\n"), /kit\.widgets-generated\.v1/);
});

test("landing: false: no landing is rendered; a content page at / is the home page, and the project needs no landing content", () => {
  const home = { path: "/", title: "Home", description: "The hub.", hero: { eyebrow: "Hub", title: "Every page, one place", lead: "Start here." }, sections: [{ blocks: [{ t: "p", html: "Sections." }] }] };
  const project = { ...sample, landing: false, content: undefined, locales: ["en"], pages: [{ type: "content", path: "/", pages: [home], content: { en: {} } }] };
  assert.deepEqual(checkProject(project), []);
  const { files } = buildSite(project, { root: SAMPLE });
  assert.match(String(files["index.html"]), /Every page, one place/);
  assert.doesNotMatch(String(files["index.html"]), /class="hero__title/);
});
