// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/shared/schema-utils.ts (origin commit: ../ORIGIN.json). Copyright Cloudflare, Inc.
// Modifications copyright 2026 Iran Open Finance: TypeScript to JavaScript (JSDoc types). Not ported: the resource-id
// heuristics for Cloudflare's CLI routes (RESOURCE_ID_OPERATIONS, COLLECTION_OPERATIONS, IDENTIFIER_ARG_NAMES with
// "zone", methodNeedsResourceId, getResourceIdArg, getAllResourceIdArgs): routes come from the contract's paths.

/** @typedef {import("./schema.js").Arg} Arg */
/** @typedef {import("./schema.js").MethodArg} MethodArg */
/** @typedef {import("./schema.js").Method} Method */
/** @typedef {import("./schema.js").MethodGroup} MethodGroup */
/** @typedef {import("./schema.js").Command} Command */

/**
 * Required arguments of a method (nested required/oneOf structures flattened).
 * @param {MethodArg[]} args
 * @returns {Arg[]}
 */
export function getRequiredArgs(args) {
  const required = [];
  for (const arg of args) {
    if ("name" in arg) {
      if (arg.required === true) required.push(arg);
    } else {
      for (const a of arg.required ?? []) if (a.required === true) required.push(a);
      // oneOf args are mutually exclusive required args
      for (const a of arg.oneOf ?? []) if (a.required === true) required.push(a);
    }
  }
  return required;
}

/**
 * Optional arguments of a method (deduplicated by name, nested structures flattened).
 * @param {MethodArg[]} args
 * @returns {Arg[]}
 */
export function getOptionalArgs(args) {
  const optional = [];
  const seen = new Set();
  const addIfNew = (arg) => {
    if (!seen.has(arg.name)) {
      seen.add(arg.name);
      optional.push(arg);
    }
  };
  for (const arg of args) {
    if ("name" in arg) {
      if (arg.required !== true) addIfNew(arg);
    } else {
      for (const a of arg.options ?? []) addIfNew(a);
      // required args with defaults are optional in the API
      for (const a of arg.required ?? []) if (a.required !== true) addIfNew(a);
    }
  }
  return optional;
}

/**
 * Every argument of a method (required, oneOf and optional), deduplicated by name.
 * @param {MethodArg[]} args
 * @returns {Arg[]}
 */
export function getAllArgs(args) {
  const allArgs = [];
  const seen = new Set();
  const addIfNew = (arg) => {
    if (!seen.has(arg.name)) {
      seen.add(arg.name);
      allArgs.push(arg);
    }
  };
  for (const arg of args) {
    if ("name" in arg) addIfNew(arg);
    else for (const a of [...(arg.required ?? []), ...(arg.oneOf ?? []), ...(arg.options ?? [])]) addIfNew(a);
  }
  return allArgs;
}

/**
 * Whether a method is backed by an operation of the contract.
 * @param {Method} method
 */
export function hasRemoteApi(method) {
  return !!method.operationId;
}

/**
 * A schema arg's type as a TypeScript type expression.
 * @param {Arg} arg
 * @returns {string}
 */
export function schemaTypeToTS(arg) {
  switch (arg.type) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "enum":
      return (arg.values ?? [])
        .map((v) => {
          if (typeof v === "string") return v;
          if ("literal" in v) {
            if (typeof v.literal === "string") return `'${v.literal}'`;
            return String(v.literal);
          }
          return "unknown";
        })
        .join(" | ");
    default:
      return "unknown";
  }
}

/**
 * Fill arg descriptions of one method from the contract's parameter descriptions.
 *
 * An arg that maps to a parameter with a description takes it (the contract is the single source of truth; a second
 * description in the schema is an error unless another, non-API method shares the arg). An arg without one must carry
 * its own. Mutates the args; returns the errors.
 *
 * @param {Method} method
 * @param {string} apiName
 * @param {Map<string, string>} openApiDescriptions
 * @param {string} [groupName]
 * @param {Set<string>} [sharedArgNames]
 * @param {Set<Arg>} [originallyDescribed]
 * @returns {string[]}
 */
export function resolveMethodArgDescriptions(method, apiName, openApiDescriptions, groupName, sharedArgNames, originallyDescribed) {
  const errors = [];
  const methodPath = groupName ? `${apiName}.${groupName}.${method.name}` : `${apiName}.${method.name}`;
  for (const arg of getAllArgs(method.args ?? [])) {
    const openApiDesc = openApiDescriptions.get(arg.name);
    if (openApiDesc) {
      const hadSchemaDescription = originallyDescribed?.has(arg) ?? !!arg.description;
      if (hadSchemaDescription && !sharedArgNames?.has(arg.name)) {
        errors.push(
          `${methodPath}: arg "${arg.name}" has a description in the schema but OpenAPI already provides one ` +
            `for "${arg.name}". Remove the description from the schema file (single source of truth).`,
        );
      }
      // the contract is the authoritative source; multi-line Markdown collapses to one line
      arg.description = openApiDesc.replace(/\s+/g, " ").trim();
    } else if (!arg.description) {
      errors.push(`${methodPath}: arg "${arg.name}" has no description and no OpenAPI description found for "${arg.name}". Add a description to the schema file.`);
    }
  }
  return errors;
}

/**
 * Names of the args used by methods without an operationId (they keep a schema description as fallback).
 * @param {Command} schema
 */
function collectNonApiArgNames(schema) {
  const names = new Set();
  walkAllMethods(schema.methods, (method) => {
    if (!method.operationId) for (const arg of getAllArgs(method.args ?? [])) names.add(arg.name);
  });
  return names;
}

/**
 * Fill arg descriptions of a whole command from the contract. Returns every error (empty: success).
 * @param {Command} schema
 * @param {(operationId: string) => Map<string, string>} getParameterDescriptions
 * @returns {string[]}
 */
export function resolveCommandArgDescriptions(schema, getParameterDescriptions) {
  const errors = [];
  const sharedArgNames = collectNonApiArgNames(schema);
  // which arg objects had a description in the schema itself (a shared arg filled by an earlier method is not one)
  const originallyDescribed = new Set();
  walkAllMethods(schema.methods, (method) => {
    for (const arg of getAllArgs(method.args ?? [])) if (arg.description) originallyDescribed.add(arg);
  });
  walkAllMethods(schema.methods, (method, groupPath) => {
    const path = groupPath ? `${schema.name}.${groupPath}.${method.name}` : `${schema.name}.${method.name}`;
    if (method.operationId) {
      errors.push(...resolveMethodArgDescriptions(method, schema.name, getParameterDescriptions(method.operationId), groupPath, sharedArgNames, originallyDescribed));
    } else {
      for (const arg of getAllArgs(method.args ?? [])) {
        if (!arg.description) errors.push(`${path}: arg "${arg.name}" has no description and no api.operationId to resolve from OpenAPI.`);
      }
    }
  });
  return errors;
}

/**
 * An arg's description, or a hard error (after resolution every arg has one).
 * @param {Arg} arg
 */
export function requireDescription(arg) {
  if (!arg.description) {
    throw new Error(`Bug: arg "${arg.name}" has no description after OpenAPI resolution. Either add a description to the schema or ensure the arg maps to an OpenAPI parameter with a description.`);
  }
  return arg.description;
}

/**
 * A method's description, or a hard error (after resolution every method has one).
 * @param {Method} method
 */
export function requireMethodDescription(method) {
  if (!method.description) {
    throw new Error(`Bug: method "${method.name}" has no description after OpenAPI resolution. Either add a description to the schema or ensure the method has an api.operationId with an OpenAPI description.`);
  }
  return method.description;
}

/**
 * Fill method descriptions (and one-line summaries) of a whole command from the contract.
 *
 * A method with an operationId takes the operation's description (else its summary); a description also written in the
 * schema is an error (single source of truth); neither is an error. Methods without an operationId must carry their
 * own. Mutates the methods; returns the errors.
 *
 * @param {Command} schema
 * @param {(operationId: string) => string | undefined} getOperationDescription
 * @param {(operationId: string) => string | undefined} [getOperationSummary]
 * @returns {string[]}
 */
export function resolveCommandDescriptions(schema, getOperationDescription, getOperationSummary) {
  const errors = [];
  walkAllMethods(schema.methods, (method, groupPath) => {
    const path = groupPath ? `${schema.name}.${groupPath}.${method.name}` : `${schema.name}.${method.name}`;
    if (!method.operationId) {
      if (!method.description) errors.push(`${path}: method has no description and no api.operationId to resolve from OpenAPI.`);
      return;
    }
    const openApiSummary = getOperationSummary?.(method.operationId);
    if (openApiSummary && !method.summary) method.summary = openApiSummary.replace(/\s+/g, " ").trim();
    const openApiDesc = getOperationDescription(method.operationId);
    if (openApiDesc) {
      if (method.description) {
        errors.push(`${path}: method has a description in the schema but OpenAPI already provides one for "${method.operationId}". Remove the description from the schema file (single source of truth).`);
      }
      method.description = openApiDesc.replace(/\s+/g, " ").trim();
    } else if (!method.description) {
      errors.push(`${path}: method has no description and no OpenAPI description found for "${method.operationId}". Add a description to the schema file.`);
    }
  });
  return errors;
}

/**
 * Whether an entry of a command's methods is a nested group.
 * @param {Method | MethodGroup} item
 * @returns {item is MethodGroup}
 */
export function isMethodGroup(item) {
  return "methods" in item;
}

/**
 * Walk every leaf method, descending into nested groups; the callback gets the dotted group path ("a.b").
 * @param {(Method | MethodGroup)[]} methods
 * @param {(method: Method, groupPath: string | undefined) => void} callback
 * @param {string} [parentGroupPath]
 */
export function walkAllMethods(methods, callback, parentGroupPath) {
  for (const item of methods) {
    if (isMethodGroup(item)) {
      walkAllMethods(item.methods, callback, parentGroupPath ? `${parentGroupPath}.${item.name}` : item.name);
    } else {
      callback(item, parentGroupPath);
    }
  }
}

/**
 * Every leaf method, nested groups flattened.
 * @param {(Method | MethodGroup)[]} methods
 * @returns {Method[]}
 */
export function collectAllMethods(methods) {
  const result = [];
  walkAllMethods(methods, (method) => result.push(method));
  return result;
}

/**
 * Every leaf method with its group path.
 * @param {(Method | MethodGroup)[]} methods
 * @returns {{ method: Method, groupPath: string | undefined }[]}
 */
export function collectAllMethodsWithGroup(methods) {
  const result = [];
  walkAllMethods(methods, (method, groupPath) => result.push({ method, groupPath }));
  return result;
}

/**
 * @param {Method} method
 */
export function isDeprecated(method) {
  return method.status === "deprecated";
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
