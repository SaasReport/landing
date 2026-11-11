/**
 * @saasreport/podcast — runtime-neutral entry (Node, tests, tooling). In Workers the "workerd" export
 * condition resolves to worker.js, whose createPodcastWorkflow defaults to Cloudflare's WorkflowEntrypoint.
 */
import { podcastWorkflowClass } from "./pipeline.js";

export * from "./audio/index.js";
export * from "./providers/index.js";
export { episodeFromItem, talkLines, wantsCalendar } from "./episodes.js";
export { articleScript, articleEpisode, checkDraft, articleSeries, DEFAULT_SCRIPT_MODELS } from "./article.js";
export { PODCAST_STRINGS, podcastStrings } from "./strings.js";
export { durationDecision, maxMsFor, showFor, voiceFor, speakerKey, providerName, envNames } from "./config.js";
export { runEpisode, timedLines, podcastWorkflowClass, DEFAULT_STORAGE } from "./pipeline.js";
export { persianGate, persianError, feedbackOf, findingsText } from "./persian.js";

/** Outside Workers pass `Base` (any class; the instance must get `env`). In Workers use the default export condition. */
export function createPodcastWorkflow(opts) {
  if (!opts?.Base) throw new Error("createPodcastWorkflow outside Workers needs opts.Base (or import from a Workers bundle)");
  return podcastWorkflowClass(opts.Base, opts);
}
