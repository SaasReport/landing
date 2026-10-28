/**
 * @saasreport/sim: pure, seeded, replayable simulation engines. See docs/SIM.md.
 *   runScenario(scenario) -> SimRun        toSimResult(scenario, run) -> SimResult        badgeFor(kind)
 * Building blocks: curves (curveFromInput, bootstrapPar, fitNss, nssRate), pricing (generateCashflows, priceInstrument,
 * solveYield), risk (riskMeasures), IRRBB (runIrrbb, shockAt, generateLadder), money (BigInt minor units), createRng.
 */
export { SimError } from "./errors.js";
export { LIMITS } from "./limits.js";
export { createRng } from "./prng.js";
export { hashOf, canonicalJson, sha256Hex, roundTo } from "./util.js";
export * as money from "./money.js";
export { parseDate, addMonths, daysBetween, yearFraction, DAY_COUNTS } from "./daycount.js";
export { bootstrapPar } from "./bootstrap.js";
export { nssRate, fitNss, validateNss, NSS_BOUNDS } from "./nss.js";
export { curveFromInput, zeroRate, discountFactor, forwardRate, shiftCurve, toContinuous, fromContinuous, CURVE_LIMITS } from "./curve.js";
export { buildPeriods, generateCashflows, presentValue, priceInstrument, solveYield, INSTRUMENT_LIMITS } from "./cashflows.js";
export { riskMeasures, tent, RISK_LIMITS } from "./risk.js";
export { runIrrbb, shockAt, bucketIndex, generateLadder, EVE_SCENARIOS } from "./irrbb.js";
export { irrbbParams, loadTables, TABLES, PROFILES } from "./data.js";
export { buildTables } from "./tables.js";
export { runSaccr, supervisoryDelta, SACCR_LIMITS, SACCR_CLASSES, CREDIT_RATINGS, COMMODITY_SETS } from "./saccr.js";
export { runSma, SMA_YEARS, SMA_ITEMS } from "./sma.js";
export { runLcr, runNsfr, HQLA_CLASSES } from "./liquidity.js";
export { normalCdf } from "./normal.js";
export { runScenario, ENGINE_VERSION } from "./run.js";
export { toSimResult, toSourceEnvelope, badgeFor, BADGES } from "./result.js";
export { SCHEMAS, validateScenario, validateRun, validateResult, validateCurveInput, validateLadder, validateIrrbbParams, validateFactorTable, validateProfile } from "./schemas.js";
