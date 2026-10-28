/** The upload contracts, from the kit's schema registry (packages/core/schemas): one source, imported here, never copied. */
import { createValidator, formatProblems } from "@saasreport/core/schema";
import RECORD from "@saasreport/core/schemas/upload-record.schema.json" with { type: "json" };
import POLICY from "@saasreport/core/schemas/upload-policy.schema.json" with { type: "json" };
import CONFIG from "@saasreport/core/schemas/uploads-config.schema.json" with { type: "json" };
import ERROR from "@saasreport/core/schemas/upload-error.schema.json" with { type: "json" };
import EVIDENCE from "@saasreport/core/schemas/upload-evidence.schema.json" with { type: "json" };
import SERVE from "@saasreport/core/schemas/upload-serve.schema.json" with { type: "json" };

export const SCHEMAS = Object.freeze({ record: RECORD, policy: POLICY, config: CONFIG, error: ERROR, evidence: EVIDENCE, serve: SERVE });
const v = createValidator([RECORD, POLICY, CONFIG, ERROR, EVIDENCE, SERVE]);

const check = (value, schema) => v.validate(value, schema.$id);
export const validateRecord = (r) => formatProblems(check(r, RECORD));
export const validatePolicy = (p) => formatProblems(check(p, POLICY));
export const validateConfig = (c) => formatProblems(check(c, CONFIG));
export const validateError = (e) => formatProblems(check(e, ERROR));
export const validateEvidence = (e) => formatProblems(check(e, EVIDENCE));
export const validateServeHeaders = (headers) => formatProblems(check(Object.fromEntries(headers instanceof Headers ? headers.entries() : Object.entries(headers)), SERVE));
