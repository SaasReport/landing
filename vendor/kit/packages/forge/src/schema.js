// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/schema/schema.ts (origin commit: ../ORIGIN.json). Copyright Cloudflare, Inc.
// Modifications copyright 2026 Iran Open Finance: the `Schema` TypeScript namespace becomes JSDoc typedefs; the factory
// helpers keep their behaviour; `command.hideCommand` no longer names Cloudflare's CF_HIDE_COMMANDS switch.

/**
 * Forge's command model: what `initFromOpenApi` builds from a contract and every target walks.
 *
 *   command      one top-level group of the API (an operation's first group segment: its tag)
 *   methodGroup  a nested group inside a command (further segments of a dotted group name)
 *   method       one operation: its name inside the group, its operationId and lifecycle status
 *
 * @typedef {"string" | "number" | "boolean"} PrimitiveType
 * @typedef {PrimitiveType | { literal: string, description: string } | { literal: number } | { literal: boolean }} PrimitiveArg
 *
 * @typedef {object} Arg
 * @property {string} name
 * @property {"string" | "number" | "boolean" | "enum"} type
 * @property {true | { default: string | number | boolean }} required
 * @property {PrimitiveArg[]} [values]      enum args only
 * @property {string} [alias]
 * @property {string} [description]       optional when the operation's parameter has one (filled from the contract)
 * @property {{ type: "none" } | { type: "choices" } | { type: "file", extensions?: string[] } | { type: "dynamic", listOperation: string, displayField: string }} [completion]
 *
 * @typedef {Arg | { required?: Arg[], oneOf?: Arg[], options?: Arg[] }} MethodArg
 *
 * @typedef {object} ParamOverride  per-parameter override of a contract-derived parameter (x-forge-params)
 * @property {string} [description]
 * @property {string | number | boolean | null} [default]
 * @property {boolean} [hidden]
 * @property {boolean} [required]
 * @property {ReadonlyArray<string | number | boolean>} [choices]
 * @property {boolean} [array]
 * @property {boolean} [positional]
 * @property {false | { format: "binary" | "base64" | "json" }} [fromFile]
 *
 * @typedef {"alpha" | "beta" | "preview" | "generally-available" | "deprecated"} MethodStatus  x-fern-availability values
 *
 * @typedef {object} Method
 * @property {string} name
 * @property {string} operationId
 * @property {MethodStatus} status
 * @property {string} [summary]          one line (the operation's summary), filled from the contract
 * @property {string} [description]      the long text (description, else summary), filled from the contract
 * @property {string} [epilogue]
 * @property {MethodArg[]} [args]
 * @property {Record<string, ParamOverride>} [params]
 * @property {string} [requireConfirmation]
 *
 * @typedef {object} MethodGroup
 * @property {string} name
 * @property {string} description
 * @property {string} [epilogue]
 * @property {(Method | MethodGroup)[]} methods
 *
 * @typedef {object} Command
 * @property {string} name
 * @property {string} description
 * @property {(Method | MethodGroup)[]} methods
 * @property {Arg[]} globalCliArgs
 * @property {boolean} hideCommand        every operation of the command is x-forge-hidden
 */

/**
 * A copy of an arg with its description rewritten.
 * @param {Arg} arg
 * @param {(original: string | undefined) => string} fn
 * @returns {Arg}
 */
export const modifyDescription = (arg, fn) => ({ ...arg, description: fn(arg.description) });

/**
 * An enum arg (sets `type: "enum"`).
 * @param {Omit<Arg, "type">} arg
 * @returns {Arg}
 */
export function enumArg(arg) {
  return { ...arg, type: "enum" };
}

/** @param {Command} command */
export const command = (command) => command;
/** @param {Method} method */
export const method = (method) => method;
/** @param {MethodGroup} methodGroup */
export const methodGroup = (methodGroup) => methodGroup;
/** @param {Arg} arg */
export const methodArg = (arg) => arg;
