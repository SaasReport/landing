/**
 * GET /api/meta (kit.api-meta.v1): what an integrator or an agent needs before calling the site, machine-readable:
 * every form it accepts (endpoint, method, content type, each field with its type, whether it is required and its
 * maximum length, the consent and honeypot fields) and the public APIs. The idea of a "/meta" endpoint per provider,
 * applied to the site's own forms. Read-only, CORS open, cached for five minutes; nothing about submissions is exposed.
 *
 * Forms: the kit's own (events.rsvp → event-rsvp) plus the project's, from the Worker option
 *   meta: { forms: { contact: { fields: [{ key, required, max, type, label }], consent: true, description } } }
 * (`key` or `name`; `fields` may be the same objects the project's form handler validates with). meta: false turns the
 * endpoint off.
 */
import { jsonRes, json } from "../util.js";

export const META_SCHEMA = "kit.api-meta.v1";

/** The kit's event RSVP form (handlers/events.js validates exactly these). */
export const RSVP_FIELDS = [
  { name: "event", type: "string", required: true, max: 90, description: "slug of a scheduled, upcoming event" },
  { name: "name", type: "string", required: true, max: 120 },
  { name: "email", type: "email", required: true, max: 200 },
  { name: "company", type: "string", required: false, max: 160 },
  { name: "role", type: "string", required: false, max: 120 },
];

const TYPES = new Set(["string", "email", "text", "url", "tel", "number", "boolean", "select", "multiselect", "date"]);

/** One field of a project form → { name, type, required, max?, label?, options? } (anything else is dropped). */
export function fieldMeta(f) {
  const name = String(f?.key ?? f?.name ?? "");
  if (!name) return null;
  const type = TYPES.has(f.type) ? f.type : f.multiple ? "multiselect" : name === "email" ? "email" : f.multiline ? "text" : "string";
  return {
    name, type, required: Boolean(f.required),
    ...(Number.isInteger(f.max) ? { max: f.max } : {}),
    ...(typeof f.label === "string" ? { label: f.label } : {}),
    ...(Array.isArray(f.options) ? { options: f.options.map((o) => (typeof o === "object" ? String(o.value ?? o.id ?? "") : String(o))) } : {}),
    ...(typeof f.description === "string" ? { description: f.description } : {}),
  };
}

export function formMeta(id, form = {}) {
  const fields = (Array.isArray(form) ? form : form.fields || []).map(fieldMeta).filter(Boolean);
  return {
    id, endpoint: `/api/forms/${id}`, method: "POST", content_type: "application/json",
    ...(typeof form.description === "string" ? { description: form.description } : {}),
    fields,
    required: fields.filter((f) => f.required).map((f) => f.name),
    consent: form.consent === false ? null : { field: "consent", type: "boolean", required: true, value: true },
    honeypot: form.honeypot === false ? null : "website",
    errors: { status: 422, body: '{ "ok": false, "error": "missing_field" | "invalid_email" | "invalid_field" | "consent_required", "field": "<name>" }' },
  };
}

export function createMeta(k) {
  const { config } = k;
  const f = config.features;

  function body() {
    // The project's forms first: a project that handles /api/forms/event-rsvp itself describes it, not the kit.
    const forms = [];
    for (const [id, form] of Object.entries(config.meta?.forms || {})) if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) forms.push(formMeta(id, form));
    if (f.events && config.events.rsvp && !forms.some((x) => x.id === "event-rsvp")) forms.unshift(formMeta("event-rsvp", { fields: RSVP_FIELDS, description: "RSVP to a scheduled event" }));
    const api = (path, description) => ({ path, url: k.abs(path), description });
    const apis = [
      f.blog && api("/api/blog/posts", "published posts (JSON)"),
      f.podcasts && api("/api/podcasts", "podcast episodes (JSON)"),
      f.glossary && api("/api/glossary", "glossary terms (JSON)"),
      f.events && api("/api/events", "events (JSON)"),
      f.calendar && k.deps.calendar && api("/api/calendar/openapi.json", "calendar REST API (OpenAPI 3.1)"),
      f.calendar && k.deps.calendar && api("/mcp", "MCP server (Streamable HTTP, read-only tools)"),
      f.monitor && api("/api/status", "monitor status"),
      f.llms && api("/llms.txt", "LLM index; every page also has a Markdown twin (<page>/index.md)"),
    ].filter(Boolean);
    return { schema: META_SCHEMA, site: { id: config.site.id, url: config.site.url, locale: config.site.locale }, forms, apis };
  }

  function handle(request) {
    if (config.meta === false) return null;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" } });
    if (request.method !== "GET" && request.method !== "HEAD") return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "GET, HEAD, OPTIONS" });
    return jsonRes(body(), 200, { "cache-control": "public, max-age=300" });
  }
  return { handle, body };
}
