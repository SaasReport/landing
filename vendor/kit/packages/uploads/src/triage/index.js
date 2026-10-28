/**
 * Static triage dispatch by sniffed type. The result is evidence for the verdict, never "safe":
 *   { engine, engine_version, complete, markers[{ name, severity, count, first_ref }], statement, verdict, reason_code }
 * `verdict` is the triage's own contribution: block, needs_sandbox, or allow_with_limits (nothing found and the analysis
 * complete: still "opening needs a sandbox"). A type with no triage is needs_sandbox (nothing was checked).
 */
import { TYPES } from "../sniff.js";
import { resolveLimits } from "../limits.js";
import { collector, STATEMENTS } from "./collector.js";
import { triagePdf, PDF_MARKERS, PDF_STRUCTURAL } from "./pdf.js";
import { triageZip, ZIP_MARKERS, OOXML_MARKERS } from "./zip.js";
import { triageOle, OLE_MARKERS } from "./ole.js";
import { triageSvg, SVG_MARKERS } from "./svg.js";
import { triageImage, IMAGE_MARKERS } from "./image.js";
import { triageText, TEXT_MARKERS } from "./text.js";

export { collector, STATEMENTS, PDF_MARKERS, PDF_STRUCTURAL, ZIP_MARKERS, OOXML_MARKERS, OLE_MARKERS, SVG_MARKERS, IMAGE_MARKERS, TEXT_MARKERS };
export { triagePdf, triageZip, triageOle, triageSvg, triageImage, triageText };

const OOXML = new Set([TYPES.docx, TYPES.xlsx, TYPES.pptx]);
const OLE = new Set([TYPES.doc, TYPES.xls, TYPES.ppt, TYPES.ole]);
const IMAGES = new Set([TYPES.png, TYPES.jpeg, TYPES.gif, TYPES.webp]);

export async function triage(bytes, type, limitOverrides) {
  const limits = resolveLimits(limitOverrides);
  if (type === TYPES.pdf) return triagePdf(bytes, limits);
  if (type === TYPES.zip) return triageZip(bytes, limits);
  if (OOXML.has(type)) return triageZip(bytes, limits, { ooxml: true });
  if (OLE.has(type)) return triageOle(bytes, limits);
  if (type === TYPES.svg) return triageSvg(bytes, limits);
  if (IMAGES.has(type)) return triageImage(bytes, type, limits);
  if (type === TYPES.text || type === TYPES.json) return triageText(bytes, limits);
  const c = collector();
  c.incomplete(`no triage for ${type}`);
  return c.finish();
}
