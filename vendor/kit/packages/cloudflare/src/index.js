/**
 * @saasreport/cloudflare — the kit runtime on Cloudflare Workers.
 *
 *   import { createKit } from "@saasreport/cloudflare";
 *   import config from "./kit.config.js";
 *   import content from "./content/index.js";
 *   const kit = createKit(config, content);
 *   export default kit; export const PodcastWorkflow = kit.PodcastWorkflow;
 *
 * Wires @saasreport/core (config, content, planner, reports), @saasreport/calendar, @saasreport/podcast (episodes,
 * PodcastWorkflow, TTS check) and @saasreport/channels (announcements) into buildKit(); options.deps overrides any of them.
 */
import { defineConfig, loadContent, planner, buildPost } from "@saasreport/core";
import * as calendar from "@saasreport/calendar";
import { episodeFromItem, articleEpisode, createPodcastWorkflow, ttsConfigured } from "@saasreport/podcast";
import { announcePending } from "@saasreport/channels";
import { buildKit } from "./kit.js";

export const DEFAULT_DEPS = { defineConfig, loadContent, planner, buildPost, calendar, episodeFromItem, articleEpisode, createPodcastWorkflow, ttsConfigured, announcePending };

/**
 * @param {object} config   kit.config.js default export (validated with @saasreport/core defineConfig)
 * @param {object} [content] content pack { [seriesId]: items | { categories, terms } } (series.source modules are loaded lazily)
 * @param {object} [options] Worker-only options: { share, reactions, events, blog, podcasts, assets, nav, footer, security, storage, deps }
 */
export function createKit(config, content = {}, options = {}) {
  return buildKit(config, content, { ...options, deps: { ...DEFAULT_DEPS, ...(options.deps || {}) } });
}

export { buildKit } from "./kit.js";
export { STRINGS } from "./strings.js";
export { POST_UPSERT, POST_UPSERT_LOCALE, postValues } from "./scheduled.js";
export { VERSION } from "./shell.js";
