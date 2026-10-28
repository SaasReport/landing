/**
 * OLE2 (legacy .doc, .xls, .ppt, encrypted OOXML) triage from the container directory: VBA storages, embedded objects, the
 * Equation Editor object, encrypted packages. A legacy Office file is never better than needs_sandbox: Excel 4 macros and
 * exploit payloads live inside streams this triage does not parse, so "no VBA found" is not a pass.
 *
 *   triageOle(bytes, limits) → triage result
 */
import { readCfb } from "../cfb.js";
import { collector } from "./collector.js";

export const OLE_MARKERS = Object.freeze({
  ole_unreadable: "needs_sandbox", vba_macros: "block", embedded_object: "block", equation_editor_object: "block", encrypted_content: "block",
  legacy_office_format: "needs_sandbox", legacy_workbook_streams_not_parsed: "needs_sandbox",
});

export function triageOle(bytes) {
  const c = collector();
  const cfb = readCfb(bytes);
  if (!cfb.ok) { c.add("ole_unreadable", "needs_sandbox", "could_not_check", cfb.reason); c.incomplete(cfb.reason); return c.finish(); }
  c.add("legacy_office_format", "needs_sandbox", "needs_sandbox_review");
  for (const e of cfb.entries) {
    const n = e.name.replace(/^[\u0001-\u0009]/, "");
    if (n === "VBA" || n === "Macros" || n.startsWith("_VBA_PROJECT") || n === "PROJECTwm") c.add("vba_macros", "block", "active_content_found", n);
    else if (n === "ObjectPool" || n === "Ole10Native" || n === "Package" || n === "Ole10ItemName") c.add("embedded_object", "block", "active_content_found", n);
    else if (/^Equation Native$/i.test(n)) c.add("equation_editor_object", "block", "active_content_found", n);
    else if (n === "EncryptedPackage" || n === "EncryptionInfo") c.add("encrypted_content", "block", "active_content_found", n);
    else if (n === "Workbook" || n === "Book") c.add("legacy_workbook_streams_not_parsed", "needs_sandbox", "needs_sandbox_review", n);
  }
  return c.finish();
}
