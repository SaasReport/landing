/** WCAG 2.x contrast of two colours, re-exported from @saasreport/core/colour: the one formula (colours are #RRGGBB or [r, g, b]). */
import { relativeLuminance, contrast } from "@saasreport/core/colour";
export const luminance = relativeLuminance;
export { contrast };

/** WCAG AA: 4.5 for text, 3 for large text (24 px, or 18.66 px and bold). */
export const AA = 4.5, AA_LARGE = 3;
export const isLarge = (px, bold) => px >= 24 || (bold && px >= 18.66);
export const needed = (px, bold) => (isLarge(px, bold) ? AA_LARGE : AA);

/** The candidate with the highest contrast against `bg`, or throws when none reaches AA. */
export function bestText(bg, candidates, what = "text") {
  const ranked = candidates.map((c) => [c, contrast(c, bg)]).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < AA) throw new Error(`no ${what} colour reaches ${AA}:1 on ${bg} (best ${ranked[0] ? `${ranked[0][0]} at ${ranked[0][1].toFixed(2)}:1` : "none"}): change the brand colour or add a darker or lighter text colour to the tokens`);
  return ranked[0][0];
}
