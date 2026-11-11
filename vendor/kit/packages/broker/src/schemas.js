/** The broker's contracts, from the kit's schema registry (packages/core/schemas): one source, imported here, never copied. */
import { createValidator, formatProblems } from "@saasreport/core/schema";
import CONFIG from "@saasreport/core/schemas/broker-config.schema.json" with { type: "json" };
import REQUEST from "@saasreport/core/schemas/broker-request.schema.json" with { type: "json" };
import EVIDENCE from "@saasreport/core/schemas/broker-evidence.schema.json" with { type: "json" };

export const SCHEMAS = Object.freeze({ config: CONFIG, request: REQUEST, evidence: EVIDENCE });
const v = createValidator([CONFIG, REQUEST, EVIDENCE]);

const check = (value, schema) => formatProblems(v.validate(value, schema.$id));
export const validateConfig = (c) => check(c, CONFIG);
export const validateRequest = (r) => check(r, REQUEST);
export const validateEvidence = (e) => check(e, EVIDENCE);
