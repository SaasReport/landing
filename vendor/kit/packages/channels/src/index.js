/**
 * @saasreport/channels — announce posts, events and podcast episodes on Telegram, Bale (Bot API compatible),
 * email (service binding to a comms/mail worker) and generic webhooks. Dormant until configured. webhooks.js: signed
 * two-layer webhooks (relayed upstream + normalised events, HMAC-SHA256 with timestamp and key id, verify, backoff).
 */
export { botApiAdapter, emailAdapter, dispatchOperationalEmail, webhookAdapter, resolveChannels, broadcast, sign, CHANNEL_DEFAULTS } from "./adapters.js";
export { postMessage, eventMessage, episodeMessage, formatWhen, channelStrings, fill, escHtml, toPlain, DEFAULT_STRINGS, DEFAULT_PATHS, BUILDERS } from "./messages.js";
export { announce, announcePending, channelsConfigured, TABLE_KIND, PENDING_QUERIES } from "./announce.js";
export { sendAlert, alertConfig, alertVariables, alertMessage, ALERT_CHANNELS, CHANNEL_ROOTS } from "./alert.js";
export { signWebhook, verifyWebhook, parseSignatures, normaliseKeys, webhookEvent, twoLayerEvents, deliverWebhook, backoffDelay, retryable, WEBHOOK_SCHEMA, DEFAULT_HEADERS as WEBHOOK_HEADERS, DEFAULT_TOLERANCE_S } from "./webhooks.js";
