/**
 * Operational alerts (e.g. failed monitor journeys) sent to private destinations, never to the public
 * announcement channel: bot adapters use their own chat id (default env MONITOR_TELEGRAM_CHAT_ID /
 * MONITOR_BALE_CHAT_ID) and email uses its own recipients (default env MONITOR_NOTIFY_TO) and `alert` template.
 * Tokens, API bases and the email service binding are inherited from config.channels.
 */
import { resolveChannels, broadcast, CHANNEL_DEFAULTS } from "./adapters.js";
import { escHtml } from "./messages.js";

const OWN = {
  telegram: { chatIdEnv: "MONITOR_TELEGRAM_CHAT_ID" },
  bale: { chatIdEnv: "MONITOR_BALE_CHAT_ID" },
  email: { toEnv: "MONITOR_NOTIFY_TO" },
  webhook: { urlEnv: "MONITOR_WEBHOOK_URL", secretEnv: "MONITOR_WEBHOOK_SECRET" },
};
const PRIVATE_KEYS = { telegram: ["chatId", "chatIdEnv"], bale: ["chatId", "chatIdEnv"], email: ["to", "toEnv", "templates"], webhook: ["url", "urlEnv", "secret", "secretEnv"] };

/** The alert channels the kit knows. */
export const ALERT_CHANNELS = Object.freeze(Object.keys(OWN));

/**
 * The failure domain each channel's delivery depends on (the resilience check derives a route's root from its channel; a label in a
 * config cannot claim a second root). email goes through the project's comms Worker and Cloudflare Email; github is the scheduled
 * watcher's own failed run.
 */
export const CHANNEL_ROOTS = Object.freeze({ email: "cloudflare", telegram: "telegram", bale: "bale", webhook: "webhook-endpoint", github: "github" });

/**
 * What the runtime READS for one alert channel (the one source for the resilience check and the deploy-time secret check):
 * { secrets: [env names that must be set as Worker secrets], optional: [...], bindings: [service bindings] }.
 */
export function alertVariables(channel, config = {}) {
  const c = alertConfig(config, { [channel]: config.monitor?.alerts?.[channel] ?? true })[channel];
  if (!c) throw new Error(`unknown alert channel "${channel}" (${ALERT_CHANNELS.join(", ")})`);
  const d = CHANNEL_DEFAULTS[channel];
  if (channel === "email") return { secrets: [c.toEnv], optional: [], bindings: [c.serviceBinding || d.serviceBinding] };
  if (channel === "webhook") return { secrets: [c.urlEnv], optional: [c.secretEnv], bindings: [] };
  return { secrets: [c.chatIdEnv, c.tokenEnv || d.tokenEnv], optional: [], bindings: [] };
}

/** The channels config used for alerts: `alerts` (default config.monitor.alerts, else email only) merged over config.channels. */
export function alertConfig(config = {}, alerts = config.monitor?.alerts ?? { email: true }) {
  const out = {};
  for (const name of Object.keys(OWN)) {
    if (!alerts?.[name]) continue;
    const base = { ...(typeof config.channels?.[name] === "object" ? config.channels[name] : {}) };
    for (const k of PRIVATE_KEYS[name]) delete base[k];
    const own = alerts[name] === true ? {} : alerts[name];
    out[name] = { ...base, ...OWN[name], ...own };
    if (name === "email") {
      const template = own.template || config.channels?.email?.templates?.alert;
      out.email.templates = template ? { alert: template } : {};
      delete out.email.template;
    }
  }
  return out;
}

/** The message an alert becomes (the same for every channel; sendAlert and the monitor's per-route sends build it here). */
export function alertMessage(config, alert, spec = config.monitor?.alerts ?? { email: true }) {
  const lines = alert.lines || [];
  const plain = [alert.subject, "", ...lines, alert.url ? `\n${alert.url}` : ""].join("\n").trim();
  const text = [`<b>${escHtml(alert.subject)}</b>`, "", `<pre>${escHtml(lines.join("\n"))}</pre>`, alert.url ? escHtml(alert.url) : ""].join("\n").trim();
  const message = {
    kind: "alert", title: alert.subject, subject: alert.subject, text, plain,
    params: {
      subject: alert.subject, reference: alert.reference || "", site_name: config.site?.name || "", url: alert.url || "",
      lines_text: lines.join("\n"), lines_html: `<pre dir="ltr">${escHtml(lines.join("\n"))}</pre>`,
    },
    idempotencyKey: alert.idempotencyKey || `alert:${alert.reference || alert.subject}`,
  };
  // alerts.email.params(alert) → extra template params (e.g. to fill an existing template's own fields).
  const extra = spec?.email && typeof spec.email === "object" && typeof spec.email.params === "function" ? spec.email.params({ ...alert, lines, plain }) : null;
  if (extra) Object.assign(message.params, extra);
  return message;
}

/**
 * Send an alert. alert: { subject, lines: [string], url?, reference?, idempotencyKey? }.
 * alerts.email.params: optional (alert) → extra params for the email template.
 * Returns { configured, refs, errors }; dormant (configured: false) when no alert destination is set up.
 */
export async function sendAlert(env, config, alert, { alerts, fetch } = {}) {
  const spec = alerts ?? config.monitor?.alerts ?? { email: true };
  const adapters = resolveChannels(env, alertConfig(config, spec), fetch ? { fetch } : {});
  if (!adapters.length) return { configured: false, refs: {}, errors: {} };
  const r = await broadcast(adapters, alertMessage(config, alert, spec));
  return { configured: true, ...r };
}
