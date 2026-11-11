/**
 * Triage limits: one place for the defaults and the hard ceilings (a policy's `limits` may tighten or loosen a default but
 * never pass a ceiling). The schema (upload-policy.schema.json `limits`) states the same ceilings; the tests compare them.
 */
export const TRIAGE_DEFAULTS = Object.freeze({
  max_zip_entries: 1000,
  max_uncompressed_bytes: 100 * 1024 * 1024,
  max_ratio: 100,
  max_pdf_objects: 100000,
  max_pdf_decoded_bytes: 50 * 1024 * 1024,
  max_filter_chain: 3,
  max_xml_part_bytes: 5 * 1024 * 1024,
  max_parts_inspected: 256,
  max_nested_depth: 0,           // an archive inside an archive is never opened: 0 nested levels
  min_ratio_bytes: 1024 * 1024,  // a ratio only counts for an entry (or archive) that inflates to more than this
});

export const TRIAGE_CEILING = Object.freeze({
  max_zip_entries: 10000,
  max_uncompressed_bytes: 1024 * 1024 * 1024,
  max_ratio: 1000,
  max_pdf_objects: 1000000,
  max_pdf_decoded_bytes: 256 * 1024 * 1024,
  max_filter_chain: 8,
});

export function resolveLimits(overrides = {}) {
  const out = { ...TRIAGE_DEFAULTS };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in TRIAGE_CEILING)) throw new Error(`unknown triage limit ${k}`);
    if (!Number.isInteger(v) || v < 1 || v > TRIAGE_CEILING[k]) throw new Error(`triage limit ${k} must be an integer from 1 to ${TRIAGE_CEILING[k]}`);
    out[k] = v;
  }
  return out;
}
