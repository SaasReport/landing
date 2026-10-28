/**
 * The podcast workflow body, independent of the Workers runtime (the base class is injected):
 *   script → tts-0…tts-n (each a retried step) → assemble and publish
 * Each step is idempotent, so a replay after a crash resumes where it stopped. Episodes longer than
 * their series' podcast.maxSeconds are parked with status 'review' instead of being published.
 * D1 table podcast_episodes / posts and R2 layout as in the original migrations (0003 + 0005).
 */
import { chunkFor, synthesize } from "./providers/index.js";
import { id3Tag, id3Lang } from "./audio/id3.js";
import { concat } from "./audio/concat.js";
import { seriesById, showFor, maxMsFor, durationDecision } from "./config.js";
import { episodeFromItem } from "./episodes.js";
import { articleScript as defaultArticleScript } from "./article.js";
import { withRender } from "@saasreport/core/podcast-provenance";
import { providerName, voiceFor, hostKeys } from "./config.js";
import { geminiModel } from "./providers/gemini.js";
import { persianGate, persianError, feedbackOf } from "./persian.js";

export const DEFAULT_STORAGE = { db: "DB", bucket: "PODCASTS", ai: "AI", prefix: "podcasts/", table: "podcast_episodes", posts: "posts" };

const now = () => new Date().toISOString();

/** Line start times across chunks, for the transcript player. */
export function timedLines(lines, chunks, parts) {
  let offset = 0;
  const timed = [];
  chunks.forEach((idx, i) => {
    idx.forEach((j, k) => timed.push({ ...lines[j], start_ms: offset + (parts[i].starts?.[k] ?? 0) }));
    offset += parts[i].durationMs;
  });
  return { timed, durationMs: offset };
}

/** Find the content item behind an episode row and rebuild its lines (used when script_json is empty). */
async function linesFromContent(content, config, row, env, calendarBit) {
  if (!content) return null;
  if (typeof content === "function") {
    const r = await content(row, env);
    return Array.isArray(r) ? r : r?.lines ?? null;
  }
  const series = seriesById(config, row.series);
  let items = content[row.series];
  if (typeof items === "function") items = await items();
  items = items?.default ?? items;
  items = Array.isArray(items) ? items : items?.items;
  const item = items?.find((it) => (it.slug ?? it.date) === row.source_ref || it.date === row.source_ref);
  if (!series || !item) return null;
  return episodeFromItem(config, series, item, { number: row.number, calendarBit, categories: content.categories?.[row.series] ?? content[`${row.series}Categories`] }).lines;
}

/**
 * Run one episode through the pipeline.
 * @param {{env, event: {payload: {slug: string}}, step, config, content?, storage?, calendarBit?, articleScript?, persian?}} ctx
 *   persian: the project's { config, packs } for the Persian gate before TTS (docs/PERSIAN.md)
 */
export async function runEpisode({ env, event, step, config, content, storage, calendarBit, articleScript = defaultArticleScript, persian = null }) {
  const project = persianGate(config, persian);
  const st = { ...DEFAULT_STORAGE, ...(storage || {}) };
  const db = env[st.db], bucket = env[st.bucket], T = st.table;
  const { slug } = event.payload;
  const gate = project && ((lines) => project(lines, slug));
  const row = () => db.prepare(`SELECT * FROM ${T} WHERE slug = ?`).bind(slug).first();
  const setStatus = (status, extra = {}) => {
    const cols = Object.keys(extra);
    return db.prepare(`UPDATE ${T} SET status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE slug = ?`)
      .bind(status, now(), ...cols.map((c) => extra[c]), slug).run();
  };
  try {
    const lines = await step.do("script", { retries: { limit: 2, delay: "20 seconds", backoff: "linear" }, timeout: "6 minutes" }, async () => {
      const ep = await row();
      if (!ep) throw new Error(`episode ${slug} not found`);
      if (ep.script_json) return JSON.parse(ep.script_json).map(({ speaker, text }) => ({ speaker, text }));
      if (ep.source_type === "post") {
        await setStatus("scripting");
        const post = await db.prepare(`SELECT * FROM ${st.posts} WHERE slug = ?`).bind(ep.source_ref).first();
        if (!post) throw new Error(`source post ${ep.source_ref} not found`);
        const r = await articleScript(env, config, post, { ai: env[st.ai], check: gate, feedback: feedbackOf(ep.error) });
        if (r.error) return { review: r.error };
        await db.prepare(`UPDATE ${T} SET script_json = ?, script_model = ?, updated_at = ? WHERE slug = ?`).bind(JSON.stringify(r.lines), r.model, now(), slug).run();
        return r.lines;
      }
      const rebuilt = await linesFromContent(content, config, ep, env, calendarBit);
      if (!rebuilt) throw new Error("episode has no script");
      await db.prepare(`UPDATE ${T} SET script_json = ?, script_model = ?, updated_at = ? WHERE slug = ?`).bind(JSON.stringify(rebuilt), "content", now(), slug).run();
      return rebuilt;
    });
    if (!Array.isArray(lines)) {
      // No model draft passed the factual checks: park it for an editor instead of publishing.
      await step.do("park for review", async () => setStatus("review", { error: String(lines.review).slice(0, 1000) }));
      return { slug, status: "review" };
    }

    // The Persian gate (docs/PERSIAN.md): a script with errors is not voiced. The episode fails with the findings; the cron's
    // re-queue keeps them, and a model script is rewritten with them fed back. Content scripts are fixed at the source
    // (kit check persian in npm test).
    if (gate) {
      const verdict = gate(lines);
      if (!verdict.ok) {
        await step.do("persian check", async () => db.prepare(`UPDATE ${T} SET script_json = CASE WHEN source_type = 'post' THEN NULL ELSE script_json END WHERE slug = ?`).bind(slug).run());
        throw new Error(persianError(verdict.findings));
      }
    }
    await step.do("mark rendering", async () => setStatus("rendering", { error: null }));
    const chunks = chunkFor(config, env, lines);
    const parts = [];
    for (const [i, idx] of chunks.entries()) {
      parts.push(await step.do(`tts-${i}`, { retries: { limit: 6, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
        const r = await synthesize(env, idx.map((j) => lines[j]), { config, first: i === 0, last: i === chunks.length - 1 });
        const key = `${st.prefix}tmp/${slug}/${i}.mp3`;
        await bucket.put(key, r.bytes, { httpMetadata: { contentType: "audio/mpeg" } });
        return { key, durationMs: r.durationMs, starts: r.starts, bytes: r.bytes.length, pace: r.pace ?? null };
      }));
    }

    return await step.do("assemble and publish", { retries: { limit: 3, delay: "10 seconds" } }, async () => {
      const ep = await row();
      const cleanup = () => Promise.all(parts.map((p) => bucket.delete(p.key)));
      const series = seriesById(config, ep.series);
      const { timed, durationMs } = timedLines(lines, chunks, parts);
      const limit = maxMsFor(config, series);
      const decision = durationDecision(durationMs, limit == null ? null : limit / 1000);
      if (!decision.ok) {
        await setStatus("review", { error: decision.reason });
        await cleanup();
        return { slug, status: "review", duration_ms: durationMs };
      }
      const bodies = [];
      for (const p of parts) {
        const obj = await bucket.get(p.key);
        if (!obj) throw new Error(`missing chunk ${p.key}`);
        bodies.push(new Uint8Array(await obj.arrayBuffer()));
      }
      const published = ep.published_at || now();
      const tag = id3Tag({
        title: ep.title, artist: config?.site?.name ?? "", album: showFor(config, series ?? { id: ep.series }).title,
        year: String(new Date(published).getUTCFullYear()), // players expect a Gregorian year
        comment: ep.summary, track: ep.number ?? undefined, lang: id3Lang(config?.site?.locale),
      });
      const audio = concat([tag, ...bodies]);
      const key = `${st.prefix}${slug}.mp3`;
      await bucket.put(key, audio, { httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=86400" } });
      // Numbering is per series: the first publish takes the next free number.
      // The render facts join the provenance record the cron wrote (provider, model, voices, pacing, measured duration, longest pause).
      let prov = null;
      try { prov = ep.provenance_json ? JSON.parse(ep.provenance_json) : null; } catch { prov = null; /* a provenance record that is not JSON is treated as none; its check reports it */ }
      const paced = parts.filter((p) => p.pace);
      // Pacing is a promise of podcast.config.json: a provider that returns finished MP3 (Piper, Gradio) cannot keep it, so the episode
      // fails loudly instead of publishing unpaced audio with a null pause measurement.
      if (config?.tts?.pacing && paced.length !== parts.length) throw new Error(`tts provider "${providerName(config, env)}" cannot apply pacing (podcast.config.json pacing is set; only gemini paces)`);
      if (prov) prov = withRender(prov, {
        provider: providerName(config, env), model: providerName(config, env) === "gemini" ? geminiModel(config, env) : null,
        voices: Object.fromEntries(hostKeys(config).map((h) => [h, String(voiceFor(config, h))])),
        ...(config?.tts?.pacing ? { pacing: config.tts.pacing } : {}), chunks: parts.length, duration_ms: durationMs,
        longest_pause_ms: paced.length ? Math.max(...paced.map((p) => p.pace.longestPauseMs)) : null, rendered_at: now(),
      });
      await db.prepare(`UPDATE ${T} SET status = 'published', audio_key = ?, audio_bytes = ?, duration_ms = ?, script_json = ?, error = NULL,
        number = COALESCE(number, (SELECT COALESCE(MAX(p2.number), 0) + 1 FROM ${T} p2 WHERE p2.series = ${T}.series)), published_at = ?, updated_at = ?${prov ? ", provenance_json = ?" : ""} WHERE slug = ?`)
        .bind(key, audio.length, durationMs, JSON.stringify(timed), published, now(), ...(prov ? [JSON.stringify(prov)] : []), slug).run();
      await cleanup();
      return { slug, status: "published", bytes: audio.length, duration_ms: durationMs };
    });
  } catch (e) {
    await step.do("mark failed", async () => setStatus("failed", { error: String(e?.message || e).slice(0, 1000) }));
    throw e;
  }
}

/**
 * A Workflow class for the given base (WorkflowEntrypoint in Workers; any class with this.env in tests).
 * A multi-locale site passes `locales: { ar: { config, content?, calendarBit? } }`: an event whose payload names a locale
 * ({ slug, locale: "ar" }) runs with that locale's config (voices, strings, speech) and content; other events use `opts`.
 * @param {Function} Base
 * @param {{config, content?, storage?, calendarBit?, articleScript?, locales?: Record<string, object>}} opts
 */
export function podcastWorkflowClass(Base, opts) {
  if (!opts?.config) throw new Error("createPodcastWorkflow: config is required");
  const { locales, ...base } = opts;
  return class PodcastWorkflow extends Base {
    async run(event, step) {
      const per = locales?.[event?.payload?.locale];
      return runEpisode({ ...base, ...(per || {}), env: this.env, event, step });
    }
  };
}
