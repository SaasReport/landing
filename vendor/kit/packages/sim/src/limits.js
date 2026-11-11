/**
 * Limits and defaults that more than one module (or a schema) uses, written once. The JSON Schemas in packages/core/schemas
 * carry the same bounds for the contracts; test/review.test.mjs asserts that they agree (JSON Schema cannot import a constant).
 * Module-specific bounds stay with their module (CURVE_LIMITS, NSS_BOUNDS, RISK_LIMITS, INSTRUMENT_LIMITS) and are covered by
 * the same agreement test.
 */
export const LIMITS = Object.freeze({
  oneBp: 0.0001, // one basis point as a decimal rate: the unit of DV01
  defaultBump: 0.0001, // the parallel bump a scenario uses when it names none (the engine functions require it explicitly)
  maxKeyTenors: 50,
  maxReportTenors: 200,
  maxLadderItems: 2000,
});
