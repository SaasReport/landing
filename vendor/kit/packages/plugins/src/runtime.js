/** The files `kit plugin new` copies into <plugin>/scripts/lib/: the skill runtime and the standalone checker. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export { RUNTIME_FILE, CHECK_FILE } from "../runtime/kit-plugin-check.mjs";
export const RUNTIME_PATH = fileURLToPath(new URL("../runtime/kit-plugin-runtime.mjs", import.meta.url));
export const CHECK_PATH = fileURLToPath(new URL("../runtime/kit-plugin-check.mjs", import.meta.url));
export const SCHEMA_PATH = fileURLToPath(new URL("../schema/compile-report.schema.json", import.meta.url));
export const LEARNINGS_SCHEMA_PATH = fileURLToPath(new URL("../schema/learnings.schema.json", import.meta.url));
export const runtimeSource = () => readFileSync(RUNTIME_PATH, "utf8");
export const checkSource = () => readFileSync(CHECK_PATH, "utf8");
