import { createKit } from "@saasreport/cloudflare";
import config from "../kit.config.js";
import content from "../content/index.js";
import persian from "../persian.config.json" with { type: "json" };
// The Persian gate before TTS reads this project's own persian.config.json (docs/PERSIAN.md), the same file `kit check persian` reads.
const kit = createKit(config, content, { persian: { config: persian, packs: [] } });
export default kit; export const PodcastWorkflow = kit.PodcastWorkflow;
