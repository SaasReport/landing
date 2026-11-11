// Markdown twins of the static pages (served from ASSETS with the right type, /x.md → /x/index.md, listed in llms.txt and
// concatenated into llms-full.txt, honouring llms.pages: false) and GET /api/meta (kit.api-meta.v1: forms and required fields).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKit, seed } from "./helpers.mjs";
import { pageOfTwin } from "../src/twins.js";
import { fieldMeta, formMeta, RSVP_FIELDS } from "../src/handlers/meta.js";

const SITE = "https://example.org";
/** A fake static-assets binding: a build's md-twins.json and twins (as @saasreport/site writes them). */
function assets(base) {
  const twin = (path, title, body) => ({ locale: "en", path, url: `${base}${path}`, md: `${base}${path}index.md`, title, description: `${title.split(" | ")[0]} page`, body });
  const pages = [twin("/", "Home | Site", "# Home\n\nWelcome."), twin("/terminal/", "Terminal | Site", "# Terminal\n\nDemo."),
    twin("/blog/", "Blog | Site", "# Blog\n\nPosts."), twin("/glossary/", "Glossary | Site", "# Glossary\n\nTerms.")];
  const files = new Map(pages.map((p) => [`${p.path}index.md`, `---\ntitle: "${p.title}"\n---\n\n${p.body}\n`]));
  files.set("/md-twins.json", JSON.stringify({ schema: "kit.md-twins.v1", site: base, pages: pages.map(({ body, ...x }) => x) }));
  const calls = [];
  return { calls, binding: { fetch: async (r) => { const p = new URL(r.url).pathname; calls.push(p); const b = files.get(p);
    return b == null ? new Response("not found", { status: 404 }) : new Response(b, { headers: { "content-type": p.endsWith(".json") ? "application/json" : "application/octet-stream" } }); } } };
}

const setup = async (opts = {}) => {
  const k = makeKit("en", { now: "2026-10-01T08:00:00Z", ...opts });
  await seed(k.env, { lang: "en" });
  const a = assets(k.config.site.url);
  k.env.ASSETS = a.binding;
  return { ...k, calls: a.calls };
};

test("pageOfTwin maps a twin to its HTML page", () => {
  assert.equal(pageOfTwin("/index.md"), "/");
  assert.equal(pageOfTwin("/terminal/index.md"), "/terminal/");
  assert.equal(pageOfTwin("/terminal.md"), "/terminal/");
});

test("twins: served as text/markdown with a canonical link and noindex; /x.md answers with /x/index.md", async () => {
  const { get, config } = await setup();
  let r = await get("/terminal/index.md");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.equal(r.headers.get("link"), `<${config.site.url}/terminal/>; rel="canonical"`);
  assert.match(await r.text(), /# Terminal/);
  r = await get("/terminal.md");
  assert.equal(r.status, 200, "alias");
  assert.match(await r.text(), /# Terminal/);
  assert.equal(r.headers.get("link"), `<${config.site.url}/terminal/>; rel="canonical"`);
  assert.equal((await get("/index.md")).status, 200);
  assert.equal((await get("/missing.md")).status, 404);
  assert.equal((await get("/blog/hello-world.md")).headers.get("content-type"), "text/markdown; charset=utf-8", "the blog still owns its twins");
  for (const sect of ["blog", "glossary"]) {
    r = await get(`/${sect}/index.md`);
    assert.equal(r.status, 200, `/${sect}/index.md: the static twin wins over the ${sect} route`);
    assert.equal(r.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(r.headers.get("link"), `<${config.site.url}/${sect}/>; rel="canonical"`);
  }
  assert.equal((await get("/terminal/index.md", { method: "POST" })).headers.get("content-type"), "application/octet-stream", "only GET and HEAD are rewritten");
});

test("twins: llms.txt lists them, llms-full.txt carries their Markdown before the posts", async () => {
  const { get, config } = await setup();
  const idx = await (await get("/llms.txt")).text();
  assert.match(idx, /^## Pages \(Markdown\)$/m);
  assert.ok(idx.includes(`- [Terminal | Site](${config.site.url}/terminal/index.md): Terminal page`));
  assert.ok(idx.includes(`- [Home | Site](${config.site.url}/index.md): Home page`));
  const full = await (await get("/llms-full.txt")).text();
  assert.ok(full.includes(`Source: ${config.site.url}/terminal/`) && full.includes("Demo."));
  assert.ok(full.indexOf("Demo.") < full.indexOf("## Part one"), "pages first, then the posts");
});

test("twins: llms.pages: false keeps them out; no ASSETS or no manifest means no section", async () => {
  const off = await setup({ options: { llms: { pages: false } } });
  assert.ok(!(await (await off.get("/llms.txt")).text()).includes("Pages (Markdown)"));
  assert.ok(!off.calls.includes("/md-twins.json"));
  const bare = makeKit("en", { now: "2026-10-01T08:00:00Z" });
  await seed(bare.env, { lang: "en" });
  assert.ok(!(await (await bare.get("/llms.txt")).text()).includes("Pages (Markdown)"));
});

test("twins: options.llms.build receives pages and, for llms-full, pageDocs", async () => {
  let seen;
  const { get } = await setup({ options: { llms: { build: (ctx) => { seen = ctx; return `pages=${ctx.pages.length} docs=${ctx.pageDocs.length}`; } } } });
  assert.equal(await (await get("/llms.txt")).text(), "pages=4 docs=0");
  assert.equal(await (await get("/llms-full.txt")).text(), "pages=4 docs=4");
  assert.match(seen.pageDocs[1].markdown, /# Terminal/);
});

test("/api/meta: kit.api-meta.v1 with the RSVP form, the project's forms and the APIs", async () => {
  const FORMS = { contact: { fields: [{ key: "name", required: true, max: 120, label: "Name" }, { key: "email", required: true, max: 200 }, { key: "message", required: false, max: 4000, multiline: true }, { key: "", required: true }], validate: () => null } };
  const { get, config } = await setup({ options: { events: { rsvp: true }, meta: { forms: FORMS } } });
  const r = await get("/api/meta");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const m = await r.json();
  assert.equal(m.schema, "kit.api-meta.v1");
  assert.equal(m.site.url, config.site.url);
  const rsvp = m.forms.find((f) => f.id === "event-rsvp");
  assert.deepEqual(rsvp.required, ["event", "name", "email"]);
  assert.equal(rsvp.endpoint, "/api/forms/event-rsvp");
  assert.deepEqual(rsvp.consent, { field: "consent", type: "boolean", required: true, value: true });
  const contact = m.forms.find((f) => f.id === "contact");
  assert.deepEqual(contact.fields, [{ name: "name", type: "string", required: true, max: 120, label: "Name" }, { name: "email", type: "email", required: true, max: 200 }, { name: "message", type: "text", required: false, max: 4000 }]);
  assert.deepEqual(contact.required, ["name", "email"]);
  assert.ok(!JSON.stringify(m).includes("validate"), "functions never leak");
  assert.ok(m.apis.some((a) => a.path === "/api/calendar/openapi.json"));
  assert.equal((await get("/api/meta", { method: "POST" })).status, 405);
  assert.ok((await (await get("/llms.txt")).text()).includes("/api/meta"));
});

test("/api/meta: meta: false turns it off (404)", async () => {
  const { get } = await setup({ options: { meta: false } });
  assert.equal((await get("/api/meta")).status, 404);
  assert.ok(!(await (await get("/llms.txt")).text()).includes("/api/meta"));
});

test("fieldMeta / formMeta keep only the public shape", () => {
  assert.equal(fieldMeta({}), null);
  assert.deepEqual(fieldMeta({ name: "topic", type: "select", options: [{ value: "a" }, "b"], required: true }), { name: "topic", type: "select", required: true, options: ["a", "b"] });
  assert.equal(formMeta("x", { fields: RSVP_FIELDS, consent: false, honeypot: false }).consent, null);
  // a multi-select chip group (lead-forms field.multiple): the list type and its options
  assert.deepEqual(fieldMeta({ key: "stack", label: "How you will use it", multiple: true, options: ["API", "SDK"], max: 200 }), { name: "stack", type: "multiselect", required: false, max: 200, label: "How you will use it", options: ["API", "SDK"] });
});

test("/api/meta: a project form named event-rsvp replaces the kit's description", async () => {
  const { get } = await setup({ options: { events: { rsvp: true }, meta: { forms: { "event-rsvp": { fields: [{ key: "event", required: true, max: 120 }, { key: "email", required: true }] } } } } });
  const m = await (await get("/api/meta")).json();
  const r = m.forms.filter((f) => f.id === "event-rsvp");
  assert.equal(r.length, 1);
  assert.equal(r[0].fields[0].max, 120);
});

test("contract: GET /api/meta conforms to kit.api-meta.v1 (contracts/api-meta.schema.json)", async () => {
  const { validate, formatProblems } = await import("@saasreport/core/schema");
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../contracts/api-meta.schema.json", import.meta.url), "utf8"));
  const FORMS = { contact: { fields: [{ key: "name", required: true, max: 120, label: "Name" }, { key: "topic", type: "select", options: ["a", { value: "b" }] }], description: "Contact us" } };
  const { get } = await setup({ options: { events: { rsvp: true }, meta: { forms: FORMS } } });
  const body = await (await get("/api/meta")).json();
  assert.deepEqual(formatProblems(validate(body, schema)), []);
  assert.ok(formatProblems(validate({ ...body, extra: 1 }, schema)).length, "the contract is closed");
});
