export interface Button { label: string; url: string }
export interface Message {
  kind: "post" | "event" | "episode" | "alert" | string;
  title?: string; subject?: string; text: string; plain?: string;
  button?: Button; photo?: string; audio?: string; params?: Record<string, unknown>; idempotencyKey?: string;
}
export interface Adapter { name: string; send(message: Message): Promise<string | null> }
export interface ChannelsConfig {
  telegram?: boolean | { tokenEnv?: string; token?: string; chatIdEnv?: string; chatId?: string; apiBase?: string; apiBaseEnv?: string; media?: boolean };
  bale?: ChannelsConfig["telegram"];
  email?: boolean | { serviceBinding?: string; endpoint?: string; to?: string | string[]; toEnv?: string; templates?: Partial<Record<"post" | "event" | "episode" | "alert", string>>; template?: string };
  webhook?: boolean | { url?: string; urlEnv?: string; secret?: string; secretEnv?: string; headers?: Record<string, string> };
  paths?: Partial<Record<"post" | "event" | "episode", string>>;
  hashtags?: false | string | string[];
  maxPerRun?: number; freshDays?: number;
  queries?: Record<string, string>;
}
export interface AnnounceReport { configured: boolean; sent: number; skipped: number; failed: number; deferred: number; duplicate: number; errors: { slug: string; channel: string; error: string }[] }

export function botApiAdapter(o: { name?: string; apiBase?: string; token: string; chatId: string; media?: boolean; fetch?: typeof fetch }): Adapter;
export function dispatchOperationalEmail(env: { COMMS?: { fetch: typeof fetch } }, options: {
  templateId: string; to: string; params: Record<string, unknown>;
  idempotencyKey: string; binding?: string
}): Promise<{ status: "sent" | "suppressed"; dispatchId: string | null }>;
export function emailAdapter(o: { name?: string; binding: { fetch: typeof fetch }; endpoint?: string; to: string | string[]; templates: Record<string, string> }): Adapter;
export function webhookAdapter(o: { name?: string; url: string; secret?: string; headers?: Record<string, string>; fetch?: typeof fetch }): Adapter;
export function resolveChannels(env: object, channels: ChannelsConfig, o?: { fetch?: typeof fetch }): Adapter[];
export function broadcast(adapters: Adapter[], message: Message): Promise<{ refs: Record<string, string>; errors: Record<string, string> }>;
export function sign(secret: string, body: string): Promise<string>;

export function postMessage(config: object, row: object): Message;
export function eventMessage(config: object, row: object, when?: string): Message;
export function episodeMessage(config: object, row: object): Message;
export function formatWhen(config: object, iso: string): string;
export function channelStrings(config: object): Record<string, any>;
export function fill(template: string, vars: Record<string, unknown>, esc?: (s: unknown) => string): string;
export function escHtml(s: unknown): string;
export function toPlain(html: string): string;

export function announce(env: object, config: object, opts: { table: string; rows: object[]; kind?: "post" | "event" | "episode"; when?: (row: any) => string; now?: number | Date; adapters?: Adapter[]; db?: any }): Promise<AnnounceReport>;
export function announcePending(env: object, config: object, opts?: { now?: number | Date; when?: (row: any) => string; tables?: string[] }): Promise<AnnounceReport>;
export function channelsConfigured(env: object, config: object): boolean;
export function sendAlert(env: object, config: object, alert: { subject: string; lines?: string[]; url?: string; reference?: string; idempotencyKey?: string }, o?: { alerts?: ChannelsConfig; fetch?: typeof fetch }): Promise<{ configured: boolean; refs: Record<string, string>; errors: Record<string, string> }>;
export function alertConfig(config: object, alerts?: ChannelsConfig): ChannelsConfig;
export function alertMessage(config: object, alert: { subject: string; lines?: string[]; url?: string; reference?: string; idempotencyKey?: string }, spec?: ChannelsConfig): object;
export function alertVariables(channel: string, config?: object): { secrets: string[]; optional: string[]; bindings: string[] };
export const ALERT_CHANNELS: readonly string[];
export const CHANNEL_ROOTS: Readonly<Record<string, string>>;
export const TABLE_KIND: Record<string, string>;
export const PENDING_QUERIES: Record<string, string>;
export const DEFAULT_STRINGS: Record<"fa" | "en", Record<string, any>>;
export const DEFAULT_PATHS: Record<"post" | "event" | "episode", string>;
export const BUILDERS: Record<"post" | "event" | "episode", (config: object, row: object, when?: string) => Message>;
export const CHANNEL_DEFAULTS: Record<string, Record<string, string>>;

// Signed two-layer webhooks (webhooks.js)
export type WebhookKey = { id: string; secret: string; active?: boolean };
export type WebhookKeys = WebhookKey[] | Record<string, string>;
export interface WebhookEvent { schema: "kit.webhook-event.v1"; id: string; type: string; occurred_at: string; source: string; subject?: string; data: unknown;
  upstream: null | { provider: string; event_type: string; event_id: string | null; received_at?: string; verified?: boolean; payload?: unknown }; caused_by: string | null }
export interface WebhookSubscriber { id: string; url: string; keys: WebhookKeys; headers?: Record<string, string>; types?: string[]; headerNames?: { id: string; timestamp: string; signature: string } }
export const WEBHOOK_SCHEMA: "kit.webhook-event.v1";
export const WEBHOOK_HEADERS: { id: string; timestamp: string; signature: string };
export const DEFAULT_TOLERANCE_S: number;
export function signWebhook(o: { body: string | object; id: string; keys: WebhookKeys; timestamp?: number; headers?: { id: string; timestamp: string; signature: string } }): Promise<Record<string, string>>;
export function verifyWebhook(d: { headers: Headers | Record<string, string>; body: string }, o: { keys: WebhookKeys; tolerance?: number; now?: number; seen?: (id: string) => boolean | Promise<boolean>; headers?: { id: string; timestamp: string; signature: string } }): Promise<{ ok: true; id: string; timestamp: number; keyId: string } | { ok: false; reason: "missing_headers" | "bad_timestamp" | "too_old" | "too_new" | "unknown_key" | "bad_signature" | "replayed" }>;
export function parseSignatures(header: string): { version: string; kid: string; sig: string }[];
export function normaliseKeys(keys: WebhookKeys): WebhookKey[];
export function webhookEvent(o: { type: string; source: string; data?: unknown; id?: string; occurredAt?: string; upstream?: { provider: string; event_type?: string; eventType?: string; event_id?: string; eventId?: string } | null; causedBy?: string | null; subject?: string }): WebhookEvent;
export function twoLayerEvents(upstream: { provider: string; eventType: string; eventId?: string; payload: unknown; verified?: boolean; receivedAt?: string }, o: { source: string; normalise?: (payload: any, upstream: any) => { type: string; data?: unknown; subject?: string } | null; now?: string }): WebhookEvent[];
export function backoffDelay(attempt: number, o?: { base?: number; cap?: number; jitter?: boolean; random?: () => number }): number;
export function retryable(status: number): boolean;
export function deliverWebhook(event: WebhookEvent, sub: WebhookSubscriber, o?: { fetch?: typeof fetch; now?: number; timeoutMs?: number; userAgent?: string }): Promise<{ ok: boolean; status: number; retryable: boolean; error?: string }>;
