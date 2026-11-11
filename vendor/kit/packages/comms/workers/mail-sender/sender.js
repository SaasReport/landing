/**
 * The Mail Sender Worker — the Cloudflare-native delivery primitive, and the ONLY Worker that touches the
 * send_email binding (MAIL). Reached exclusively via Service binding from the project's Comms Engine.
 * Which sender addresses it may use is enforced by the binding (allowed_sender_addresses in wrangler.toml).
 *
 * The mail-sender Worker. Service-binding only.
 *
 *   GET  /healthz
 *   POST /send  { from, fromName?, to, subject, text, html?, replyTo?, headers? }
 *
 * A project's Worker entry:
 *   import { createMailSender } from "@saasreport/comms/mail-sender";
 *   export default createMailSender({ name: "my-site-mail-sender", logPrefix: "my-mail-sender" });
 */
import { readJsonBody } from "@saasreport/cloudflare/body";

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** { name, logPrefix } → the Worker ({ fetch }). mailSenderOptions(config) derives both from a comms config. */
export function createMailSender({ name = "mail-sender", logPrefix = name } = {}) {
  return {
    async fetch(req, env) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, component: name });
      }
      if (req.method !== "POST" || url.pathname !== "/send") {
        return json({ ok: false, error: "expected POST /send" }, 405);
      }
      const read = await readJsonBody(req, { maxBytes: 1024 * 1024, contentLength: "optional" });   // Service binding only: no Content-Length needed, the cap applies while streaming
      if (read.response) return read.response;
      if (read.invalid || !read.value || typeof read.value !== "object") return json({ ok: false, error: "invalid_json" }, 400);
      const body = read.value;
      for (const k of ["from", "to", "subject", "text"]) {
        if (!body[k]) return json({ ok: false, error: `missing_${k}` }, 400);
      }
      if (!env.MAIL || typeof env.MAIL.send !== "function") {
        return json({ ok: false, error: "mail_binding_missing" }, 503);
      }
      try {
        const resp = await env.MAIL.send({
          from: body.fromName ? { email: body.from, name: body.fromName } : body.from,
          to: body.to,
          subject: body.subject,
          text: body.text,
          ...(body.html ? { html: body.html } : {}),
          ...(body.replyTo ? { replyTo: body.replyTo } : {}),
          ...(body.headers ? { headers: body.headers } : {}),
        });
        return json({ ok: true, message_id: resp?.messageId ?? null, provider: "cf-email" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[${logPrefix}] send failed:`, msg);
        return json({ ok: false, error: "send_failed", detail: msg.slice(0, 400), provider: "cf-email" }, 502);
      }
    },
  };
}
