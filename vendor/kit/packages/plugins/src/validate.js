/**
 * Validators for agent plugins and their compile reports (the standalone checker in runtime/kit-plugin-check.mjs),
 * plus the byte-for-byte check of each plugin's copies of the runtime and the checker against the kit's.
 *   validatePlugin(dir, { prefix, servers, prefixes }) → problems[]   ([] when the plugin is fine)
 *   validateReport(report) → problems[]   (statuses, critic verdicts, risk 1-10)
 *   validateLearnings(jsonlText) → problems[]   (kit.plugin-learning.v1, one object per line)
 */
import * as check from "../runtime/kit-plugin-check.mjs";
import { runtimeSource, checkSource } from "./runtime.js";

export const { PREFIXES, FULL_PREFIXES, REPORT_SCHEMA, LEARNING_SCHEMA, STATUSES, VERDICTS, LEARNING_KINDS, validateReport, validateLearnings } = check;
export const validatePlugin = (dir, opts = {}) => check.validatePlugin(dir, { runtimeSource: runtimeSource(), checkSource: checkSource(), ...opts });
