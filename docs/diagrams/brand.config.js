// The diagram theme's token source: the site's own colour tokens (tokens.json) plus the diagram font.
// PROVISIONAL: SaasReport has no brand kit yet. docs/diagrams/theme.init is derived from this file:
//   node vendor/kit/packages/cli/bin/kit.js diagrams derive --config docs/diagrams/brand.config.js --project saasreport
import tokens from "../../tokens.json" with { type: "json" };
export default {
  name: "SaasReport",
  note: tokens._note,
  tokens: {
    color: { ...tokens.color, accentLine: tokens.color.accentBright },
    font: { sans: "Inter", faces: [{ family: "Inter", weight: 400, src: "/docs/diagrams/fonts/Inter-400.woff2" }] },
  },
};
