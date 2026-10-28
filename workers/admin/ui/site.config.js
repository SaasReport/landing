// The admin interface as a kit site project (docs/SITE.md): one workbench page, generated from the admin API contract and the pane
// declarations (scripts/admin-ui.mjs, kit widgets build). Tokens are the landing's. The Worker serves the output behind Cloudflare Access.
import tokens from "../../../tokens.json" with { type: "json" };
import generated from "./generated/widgets.generated.json" with { type: "json" };
import snapshot from "../generated/snapshot.json" with { type: "json" };

const { _note, ...color } = tokens;
export const brand = { color: color.color };

export default {
  name: "SaasReport admin",
  url: `https://admin.${snapshot.domain}`,
  locales: [{ code: "en", path: "/" }],
  timeZone: "UTC",
  namespace: { global: "SaasReportAdmin", key: "saasreport-admin" },
  landing: false,
  content: {},
  // the brand files are the landing's (public/brand, written by scripts/generate.mjs); the build copies them next to the pages
  tokens: {
    ...color,
    logo: { nav: { src: "/brand/logo.svg", width: 198, height: 45 }, footer: { src: "/brand/logo.svg", width: 198, height: 45 }, icon: { src: "/brand/icon.svg", width: 45, height: 45 } },
    icons: [{ rel: "icon", href: "/brand/icon.svg", type: "image/svg+xml" }],
    manifest: null,
  },
  out: "dist",
  styles: [],
  scripts: [],
  sitemap: false,
  assets: { "totop.js": {} },
  pages: [{ type: "workbench", path: "/workbench/", generated, content: { en: { meta: { title: "SaasReport admin", description: "The SaasReport admin workbench." } } } }],
};
