/**
 * The browser runtime as one plain script (CSP script-src 'self'): the kit's JSON Schema validator, core.js (pure) and
 * ui.js (DOM), in one closure. `loadRuntime()` evaluates the same text in a bare vm context for the build and the
 * tests, so what the browser runs is what is tested.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
export const RUNTIME_FILES = ["../../core/src/schema.js", "../assets/core.js", "../assets/ui.js"];

export function runtimeSource() {
  const validator = read("../../core/src/schema.js").replace(/^export /gm, "");
  if (/^\s*(import|export)\b/m.test(validator)) throw new Error("core/src/schema.js must stay free of imports and default exports to be inlined");
  return `/* @saasreport/workbench runtime (core/src/schema.js + assets/core.js + assets/ui.js) */\n(() => {\n"use strict";\n${validator}\n${read("../assets/core.js")}\n${read("../assets/ui.js")}\nglobalThis.KitWorkbench = KitWorkbench;\n})();\n`;
}

/** The pure API (fold, grammar, layout, envelope, BYO checks) without a DOM. */
export function loadRuntime(extra = {}) {
  const ctx = vm.createContext({ console, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, atob, btoa, Date, Intl, crypto: globalThis.crypto, ...extra });
  vm.runInContext(runtimeSource(), ctx, { filename: "workbench.js" });
  return ctx.KitWorkbench;
}
