/**
 * Channel adapters. Each adapter is `{ name, send(message) → ref | null }`; `null` means "nothing to do for
 * this message" (e.g. no email template for that kind), a thrown error means the delivery failed.
 *
 * message: { kind, text (Telegram HTML), plain, subject, button?: {label, url}, photo?, audio?, params?, idempotencyKey? }
 */

import { signWebhook } from "./webhooks.js";
import { safeFetch } from "@saasreport/core/safe-fetch";

const trimSlash = (s) => String(s || "").replace(/\/+$/, "");
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

/**
 * Telegram Bot API (and every Bot-API-compatible messenger such as Bale).
 * sendMessage, or sendPhoto / sendAudio when the message carries `photo` / `audio` and `media` is enabled;
 * the button becomes an inline keyboard.
 */
export function botApiAdapter({ name = "telegram", apiBase = "https://api.telegram.org", token, chatId, media = false, fetch: f = globalThis.fetch }) {
  if (!token || !chatId) throw new Error(`${name}: token and chat id are required`);
  const base = trimSlash(apiBase);
  const call = async (method, body) => {
    const res = await f(`${base}/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));   // a body that is not JSON fails the ok check below, with the status
    if (!out.ok) throw new Error(`${name} ${method} ${res.status}: ${String(out.description || "").slice(0, 200)}`);
    return String(out.result?.message_id ?? "");
  };
  return {
    name,
    async send(m) {
      const reply_markup = m.button?.url ? { inline_keyboard: [[{ text: m.button.label, url: m.button.url }]] } : undefined;
      const common = { chat_id: chatId, parse_mode: "HTML", reply_markup };
      if (media && m.audio) return call("sendAudio", { ...common, audio: m.audio, caption: clip(m.text, 1024), ...(m.title ? { title: m.title } : {}) });
      if (media && m.photo) return call("sendPhoto", { ...common, photo: m.photo, caption: clip(m.text, 1024) });
      return call("sendMessage", { ...common, text: clip(m.text, 4096), link_preview_options: { is_disabled: false } });
    },
  };
}

/**
 * Email through a service binding to a comms/mail worker.
 * POST <endpoint> with JSON { template_id, to, params, idempotency_key }; any 2xx is success.
 * `templates` maps message kinds (post, event, episode, alert, …) to template ids; kinds without a template are skipped.
 */
export function emailAdapter({ name = "email", binding, endpoint = "https://comms/v1/comms/dispatch", to, templates = {} }) {
  if (!binding || typeof binding.fetch !== "function") throw new Error(`${name}: service binding is missing`);
  const recipients = (Array.isArray(to) ? to : String(to || "").split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!recipients.length) throw new Error(`${name}: no recipients`);
  return {
    name,
    async send(m) {
      const template_id = templates[m.kind];
      if (!template_id) return null;
      const payload = {
        template_id, to: recipients,
        params: { subject: m.subject, title: m.title, text: m.plain, url: m.button?.url, button: m.button?.label, ...(m.params || {}) },
        idempotency_key: m.idempotencyKey || `${m.kind}:${m.subject || m.title}`,
      };
      const res = await binding.fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`${name} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);   // the status is the error; the body is only detail
      const out = await res.json().catch(() => ({}));   // a 2xx with no JSON body: the message is accepted, only its id is unknown
      return String(out.id ?? out.dispatch_id ?? out.message_id ?? "queued");
    },
  };
}


/**
 * Strict operational-mail boundary for stateful lifecycle notifications
 * (invites, expiration, revocation). Never use it for form acknowledgements:
 * those must go through submitForm to deliver both owner and submitter mail.
 *
 * A 2xx alone is not proof of delivery. Suppression is a terminal result, and
 * unreadable/partial receipts are transient failures; no secrets or request
 * payloads enter thrown errors or logs. Binding access belongs solely to this
 * approved channel adapter, not the site handler.
 */
export async function dispatchOperationalEmail(env, {
  templateId, to, params, idempotencyKey, binding = "COMMS",
} = {}) {
  // Security contract: bounded character-by-character validation; no quantified
  // regex on inputs under attacker control (regular-expression-gate, T=0).
  const templateAllowed = (name) => typeof name === "string" &&
    name.length > 0 && name.length <= 200 && [...name].every((c) =>
      /[A-Za-z0-9_.-]/.test(c));
  if (!templateAllowed(templateId))
    throw new Error("operational email template is invalid");
  const emailValid = (value) => {
    if (typeof value !== "string" || !value || value.length > 200 || /\s/.test(value)) return false;
    const at = value.indexOf("@");
    if (at < 1 || at !== value.lastIndexOf("@") || at >= value.length - 1) return false;
    const dot = value.lastIndexOf(".");
    return dot > at + 1 && dot < value.length - 1;
  };
  if (!emailValid(to))
    throw new Error("operational email recipient is invalid");
  if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 200)
    throw new Error("operational email idempotency key is invalid");
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error("operational email parameters are invalid");
  const channel = env?.[binding];
  if (!channel || typeof channel.fetch !== "function")
    throw new Error("operational email binding unavailable");
  const response = await channel.fetch("https://comms/v1/comms/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      template_id: templateId, to: [to], params, idempotency_key: idempotencyKey,
    }),
  });
  if (!response.ok) throw new Error("operational email dispatcher unavailable");
  let receipt;
  try { receipt = await response.json(); } catch {
    // A successful HTTP code without a parseable receipt proves no delivery.
    throw new Error("operational email receipt unavailable");
  }
  if (!receipt || receipt.ok !== true)
    throw new Error("operational email dispatch not acknowledged");
  if (receipt.suppressed === true || (receipt.sent === 0 && receipt.suppressed === 1))
    return { status: "suppressed", dispatchId: receipt.dispatch_id || null };
  if (receipt.sent !== 1) throw new Error("operational email delivery unconfirmed");
  return { status: "sent", dispatchId: receipt.dispatch_id || null };
}

/** HMAC-SHA256 (hex) of the body, sent as `x-kit-signature: sha256=<hex>` when a secret is set. */
export async function sign(secret, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generic webhook: POST JSON { kind, title, subject, text, plain, url, params, idempotency_key }. With `secret` the body
 * carries `x-kit-signature: sha256=<hex>`; with `keyId` too (or `keys` for rotation) it is also signed with timestamp and
 * key id (webhook-id, webhook-timestamp, webhook-signature; see webhooks.js) so receivers can reject replays.
 */
export function webhookAdapter({ name = "webhook", url, secret, keyId, keys, headers = {}, fetch: f = (u, init) => safeFetch(u, init, { discardBody: true, followRedirects: false }) }) {
  if (!url) throw new Error(`${name}: url is required`);
  return {
    name,
    async send(m) {
      const body = JSON.stringify({
        kind: m.kind, title: m.title, subject: m.subject, text: m.text, plain: m.plain, url: m.button?.url,
        photo: m.photo, audio: m.audio, params: m.params || {}, idempotency_key: m.idempotencyKey,
      });
      const h = { "content-type": "application/json", ...headers };
      if (m.idempotencyKey) h["idempotency-key"] = m.idempotencyKey;
      if (secret) h["x-kit-signature"] = `sha256=${await sign(secret, body)}`;
      const signing = keys || (secret && keyId ? [{ id: keyId, secret }] : null);
      if (signing) Object.assign(h, await signWebhook({ body, id: m.idempotencyKey || `msg_${crypto.randomUUID()}`, keys: signing }));
      const res = await f(url, { method: "POST", headers: h, body });
      if (!res.ok) throw new Error(`${name} ${res.status}`);
      return res.headers.get("x-message-id") || String(res.status);
    },
  };
}

const DEFAULT_ENV = {
  telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", chatIdEnv: "TELEGRAM_CHAT_ID", apiBase: "https://api.telegram.org" },
  bale: { tokenEnv: "BALE_BOT_TOKEN", chatIdEnv: "BALE_CHAT_ID", apiBase: "https://tapi.bale.ai" },
  email: { serviceBinding: "COMMS", toEnv: "ANNOUNCE_EMAIL_TO" },
  webhook: { urlEnv: "CHANNEL_WEBHOOK_URL", secretEnv: "CHANNEL_WEBHOOK_SECRET", keyIdEnv: "CHANNEL_WEBHOOK_KEY_ID" },
};
export const CHANNEL_DEFAULTS = DEFAULT_ENV;

const pick = (env, spec, key) => spec[key] ?? (spec[`${key}Env`] ? env[spec[`${key}Env`]] : undefined);

/**
 * Build the adapters that are configured AND have their secrets/bindings present in env.
 * `channels` is a channels config object ({ telegram, bale, email, webhook }); a key set to false/absent is off.
 * Returns [] when nothing is configured (the channels are dormant).
 */
export function resolveChannels(env = {}, channels = {}, { fetch: f } = {}) {
  const out = [];
  for (const name of ["telegram", "bale"]) {
    if (!channels[name]) continue;
    const spec = { ...DEFAULT_ENV[name], ...(channels[name] === true ? {} : channels[name]) };
    const token = pick(env, spec, "token"), chatId = pick(env, spec, "chatId");
    const apiBase = pick(env, spec, "apiBase") || DEFAULT_ENV[name].apiBase;
    if (token && chatId) out.push(botApiAdapter({ name, apiBase, token, chatId, media: Boolean(spec.media), ...(f ? { fetch: f } : {}) }));
  }
  if (channels.email) {
    const spec = { ...DEFAULT_ENV.email, ...(channels.email === true ? {} : channels.email) };
    const binding = env[spec.serviceBinding];
    const to = spec.to ?? env[spec.toEnv];
    const templates = { ...(spec.templates || {}), ...(spec.template ? { alert: spec.template } : {}) };
    if (binding && to && Object.keys(templates).length) out.push(emailAdapter({ binding, endpoint: spec.endpoint, to, templates }));
  }
  if (channels.webhook) {
    const spec = { ...DEFAULT_ENV.webhook, ...(channels.webhook === true ? {} : channels.webhook) };
    const url = pick(env, spec, "url");
    if (url) out.push(webhookAdapter({ url, secret: pick(env, spec, "secret"), keyId: pick(env, spec, "keyId"), headers: spec.headers, ...(f ? { fetch: f } : {}) }));
  }
  return out;
}

/** Send one message to every adapter. Returns { refs: {name: ref}, errors: {name: message} }. */
export async function broadcast(adapters, message) {
  const refs = {}, errors = {};
  for (const a of adapters) {
    try {
      const ref = await a.send(message);
      if (ref != null) refs[a.name] = ref;
    } catch (e) {
      errors[a.name] = String(e?.message || e).slice(0, 300);
    }
  }
  return { refs, errors };
}
