/** Where the engine's runtime and theme live (shared by index.js, theme.js and the sites). */
import { fileURLToPath } from "node:url";

/** The client runtime core (a plain script) and the theme stylesheet template (site theme placeholders). */
export const RUNTIME_FILE = fileURLToPath(new URL("../assets/widgets.js", import.meta.url));
export const THEME_FILE = fileURLToPath(new URL("../theme/widgets.css", import.meta.url));
/** The runtime's module tree (widgets/plugins/<id>.js, widgets/lib/*.js), served next to widgets.js. */
export const RUNTIME_DIR = fileURLToPath(new URL("../assets/widgets/", import.meta.url));
/** Where the kit's own plugin modules live (their relative `runtime` and `styles` paths start here). */
export const KIT_PLUGIN_DIR = fileURLToPath(new URL("./plugins/", import.meta.url));
