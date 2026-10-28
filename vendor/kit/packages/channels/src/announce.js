/**
 * announce(): send rows (posts, events, podcast episodes) to every configured channel, exactly once.
 *
 * Idempotency lives in the row's `channel_state` column ('pending' | 'sent' | 'skipped' | 'failed') and
 * `channel_ref`. A row is claimed with a conditional UPDATE (pending → sent) BEFORE anything is sent, so two
 * overlapping cron runs can never post the same row twice (at-most-once). A delivery that fails on every
 * channel turns the row into 'failed'. Rows older than `freshDays` are marked 'skipped', so enabling a
 * channel later never floods it with the back catalogue. When no channel is configured, nothing is touched.
 */
import { resolveChannels, broadcast } from "./adapters.js";
import { BUILDERS } from "./messages.js";

export const TABLE_KIND = { posts: "post", events: "event", podcast_episodes: "episode", episodes: "episode" };
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DAY = 864e5;

/** True when at least one channel has its secrets/bindings present. */
export const channelsConfigured = (env, config = {}) => resolveChannels(env, config.channels || {}).length > 0;

const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);

/**
 * @param env      Worker env (DB = D1 binding, plus channel secrets/bindings)
 * @param config   kit config (site, channels, strings, …)
 * @param opts     { table, rows, kind?, when?(row) → string, now?: Date|number, adapters?, db? }
 * @returns        { configured, sent, skipped, failed, deferred, duplicate, errors: [{slug, channel, error}] }
 */
export async function announce(env, config = {}, { table, rows = [], kind, when, now = Date.now(), adapters, db } = {}) {
  const report = { configured: false, sent: 0, skipped: 0, failed: 0, deferred: 0, duplicate: 0, errors: [] };
  const list = adapters || resolveChannels(env, config.channels || {});
  if (!list.length) return report;
  report.configured = true;
  if (!SAFE_IDENT.test(String(table))) throw new Error(`announce: invalid table name ${table}`);
  const k = kind || TABLE_KIND[table];
  const builder = BUILDERS[k];
  if (!builder) throw new Error(`announce: unknown kind for table ${table}; pass { kind: "post" | "event" | "episode" }`);
  const DB = db || env.DB;
  const t = typeof now === "number" ? now : new Date(now).getTime();
  const maxPerRun = Number(config.channels?.maxPerRun ?? 3);
  const cutoff = t - Number(config.channels?.freshDays ?? 7) * DAY;
  const setState = (state, slug, from) =>
    DB.prepare(`UPDATE ${table} SET channel_state = ? WHERE slug = ?${from ? " AND channel_state = ?" : ""}`).bind(...[state, slug, from].filter(Boolean)).run();

  let attempted = 0;
  for (const row of rows) {
    if (!row?.slug || (row.channel_state && row.channel_state !== "pending")) continue;
    const stamp = Date.parse(row.published_at || row.created_at || "");
    if (Number.isFinite(stamp) && stamp < cutoff) { report.skipped += changes(await setState("skipped", row.slug, "pending")); continue; }
    if (attempted >= maxPerRun) { report.deferred++; continue; }
    // Claim first: only the run whose UPDATE changes the row may send it.
    if (!changes(await setState("sent", row.slug, "pending"))) { report.duplicate++; continue; }
    attempted++;
    let message;
    try {
      message = { ...builder(config, row, when ? when(row) : undefined), idempotencyKey: `${table}:${row.slug}` };
    } catch (e) {
      await setState("failed", row.slug);
      report.failed++; report.errors.push({ slug: row.slug, channel: "builder", error: String(e?.message || e) });
      continue;
    }
    const { refs, errors } = await broadcast(list, message);
    for (const [channel, error] of Object.entries(errors)) {
      console.error("[kit/channels] send failed", table, row.slug, channel, error);
      report.errors.push({ slug: row.slug, channel, error });
    }
    const names = Object.keys(refs);
    if (names.length) {
      const ref = names.length === 1 && list.length === 1 ? refs[names[0]] : JSON.stringify(refs);
      await DB.prepare(`UPDATE ${table} SET channel_ref = ? WHERE slug = ?`).bind(ref, row.slug).run();
      report.sent++;
    } else if (Object.keys(errors).length) {
      await setState("failed", row.slug);
      report.failed++;
    } else {
      await setState("skipped", row.slug); // no channel had anything to send for this kind
      report.skipped++;
    }
  }
  return report;
}

/** The default pending queries (legacy schema); override per table with config.channels.queries[table]. */
export const PENDING_QUERIES = {
  posts: "SELECT * FROM posts WHERE channel_state = 'pending' AND status = 'published' AND published_at <= ?1 ORDER BY published_at LIMIT ?2",
  events: "SELECT * FROM events WHERE channel_state = 'pending' AND status = 'scheduled' AND starts_at > ?1 ORDER BY created_at LIMIT ?2",
  podcast_episodes: "SELECT * FROM podcast_episodes WHERE channel_state = 'pending' AND status = 'published' AND published_at <= ?1 ORDER BY published_at LIMIT ?2",
};

/**
 * Convenience for the daily cron: read pending rows of each table and announce them.
 * Tables default to those enabled by config.features (blog → posts, events → events, podcasts → podcast_episodes).
 * Stale rows (older than freshDays) are also marked skipped in bulk so they never linger as 'pending'.
 */
export async function announcePending(env, config = {}, { now = Date.now(), when, tables } = {}) {
  const f = config.features || {};
  const on = (x) => f[x] !== false;
  const list = tables || [on("blog") && "posts", on("events") && "events", on("podcasts") && "podcast_episodes"].filter(Boolean);
  const adapters = resolveChannels(env, config.channels || {});
  const total = { configured: adapters.length > 0, sent: 0, skipped: 0, failed: 0, deferred: 0, duplicate: 0, errors: [] };
  if (!adapters.length) return total;
  const t = typeof now === "number" ? now : new Date(now).getTime();
  const iso = new Date(t).toISOString();
  const cutoff = new Date(t - Number(config.channels?.freshDays ?? 7) * DAY).toISOString();
  for (const table of list) {
    if (!SAFE_IDENT.test(table)) continue;
    const stamp = table === "events" ? "created_at" : "published_at";
    total.skipped += changes(await env.DB.prepare(`UPDATE ${table} SET channel_state = 'skipped' WHERE channel_state = 'pending' AND ${stamp} < ?`).bind(cutoff).run());
    const sql = config.channels?.queries?.[table] || PENDING_QUERIES[table];
    if (!sql) continue;
    const rows = (await env.DB.prepare(sql).bind(iso, Number(config.channels?.maxPerRun ?? 3)).all()).results || [];
    const r = await announce(env, config, { table, rows, now: t, adapters, when: table === "events" ? when : undefined });
    for (const k of ["sent", "skipped", "failed", "deferred", "duplicate"]) total[k] += r[k];
    total.errors.push(...r.errors);
  }
  return total;
}
