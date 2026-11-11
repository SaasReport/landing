/** Workers-only entry: the PodcastWorkflow class on top of Cloudflare's WorkflowEntrypoint. */
import { WorkflowEntrypoint } from "cloudflare:workers";
import { podcastWorkflowClass } from "./pipeline.js";

/**
 * @param {{config: object, content?: object|Function, storage?: object, calendarBit?: Function, articleScript?: Function}} opts
 * @returns {typeof WorkflowEntrypoint}
 */
export const createPodcastWorkflow = (opts) => podcastWorkflowClass(opts?.Base ?? WorkflowEntrypoint, opts);
