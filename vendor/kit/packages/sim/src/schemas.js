/** The simulation contracts, from the kit's schema registry (packages/core/schemas): one source, imported here, never copied. */
import { createValidator, formatProblems } from "@saasreport/core/schema";
import SCENARIO from "@saasreport/core/schemas/sim-scenario.schema.json" with { type: "json" };
import RUN from "@saasreport/core/schemas/sim-run.schema.json" with { type: "json" };
import RESULT from "@saasreport/core/schemas/sim-result.schema.json" with { type: "json" };
import CURVE from "@saasreport/core/schemas/curve-input.schema.json" with { type: "json" };
import LADDER from "@saasreport/core/schemas/cashflow-ladder.schema.json" with { type: "json" };
import FACTOR from "@saasreport/core/schemas/sim-factor-table.schema.json" with { type: "json" };
import PROFILE from "@saasreport/core/schemas/sim-profile.schema.json" with { type: "json" };
import OUTPUTS from "@saasreport/core/schemas/sim-outputs.schema.json" with { type: "json" };
import IRRBB from "@saasreport/core/schemas/sim-irrbb-params.schema.json" with { type: "json" };

export const SCHEMAS = Object.freeze({ scenario: SCENARIO, run: RUN, result: RESULT, curve: CURVE, ladder: LADDER, irrbbParams: IRRBB, factorTable: FACTOR, profile: PROFILE, outputs: OUTPUTS });
export const validator = createValidator(Object.values(SCHEMAS));
const check = (value, schema) => formatProblems(validator.validate(value, schema.$id));
export const validateScenario = (s) => check(s, SCENARIO);
export const validateRun = (r) => check(r, RUN);
export const validateResult = (r) => check(r, RESULT);
export const validateCurveInput = (c) => check(c, CURVE);
export const validateLadder = (l) => check(l, LADDER);
export const validateIrrbbParams = (p) => check(p, IRRBB);
export const validateFactorTable = (t) => check(t, FACTOR);
export const validateProfile = (p) => check(p, PROFILE);
