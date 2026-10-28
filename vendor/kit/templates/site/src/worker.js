import { createKit } from "@saasreport/cloudflare";
import config from "../kit.config.js";
import content from "../content/index.js";
const kit = createKit(config, content);
export default kit; export const PodcastWorkflow = kit.PodcastWorkflow;
