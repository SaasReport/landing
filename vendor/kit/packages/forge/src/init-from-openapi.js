// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/init-from-openapi.ts (origin commit: ../ORIGIN.json). Copyright Cloudflare, Inc.
// Modifications copyright 2026 Iran Open Finance:
//   - TypeScript to JavaScript (JSDoc types).
//   - A standard OpenAPI document is enough: an operation's group is its x-fern-sdk-group-name if set, else its first
//     tag, else its first path segment (upstream required Cloudflare's x-fern-sdk-group-name on every operation and
//     skipped the rest); group segments become identifiers (groupSegments).
//   - Operations without an operationId are included under their derived id (openapi-resolver.js operationIdOf).
//   - Every OpenAPI method, HEAD, OPTIONS and TRACE included.
//   - The Forge instance and the module-level resolver share one resolver (built once).

import { Forge } from "./forge.js";
import { HTTP_METHODS } from "./http.js";
import { ensureUniqueSdkMethodNames } from "./method-names.js";
import { toCamelCase } from "./naming.js";
import { operationIdOf, populateOperationMap } from "./openapi-resolver.js";
import { resolveCommandArgDescriptions, resolveCommandDescriptions } from "./schema-utils.js";

const METHOD_STATUSES = new Set(["alpha", "beta", "preview", "generally-available", "deprecated"]);

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One group segment as an identifier: "Calendar events" → "calendarEvents", "lead-forms" → "leadForms".
 * @param {string} s
 */
export function groupSegment(s) {
  return toCamelCase(String(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")) || "default";
}

/**
 * The dotted group of an operation: x-fern-sdk-group-name (string "a.b" or ["a", "b"]), else the first tag, else the
 * first path segment that is not "api" or a version ("v1"), else "default".
 * @param {Record<string, any>} operation
 * @param {string} path
 * @returns {string[]}
 */
export function groupSegments(operation, path) {
  const raw = operation["x-fern-sdk-group-name"];
  if (Array.isArray(raw) && raw.some((s) => typeof s === "string" && s)) return raw.filter((s) => typeof s === "string" && s).map(groupSegment);
  if (typeof raw === "string" && raw.split(".").some(Boolean)) return raw.split(".").filter(Boolean).map(groupSegment);
  const tag = Array.isArray(operation.tags) ? operation.tags.find((t) => typeof t === "string" && t.trim()) : undefined;
  if (tag) return [groupSegment(tag)];
  const seg = String(path).split("/").find((x) => x && !/^\{.*\}$/.test(x) && x !== "api" && !/^v\d+$/i.test(x));
  return [groupSegment(seg ? seg.replace(/\.[A-Za-z0-9]+$/, "") : "default")];
}

/** Command descriptions from x-forge-commands. */
function loadCommandDescriptions(openapi) {
  const descriptions = new Map();
  const commands = openapi["x-forge-commands"];
  if (!isRecord(commands)) return descriptions;
  for (const [commandName, node] of Object.entries(commands)) {
    if (isRecord(node) && typeof node.description === "string") descriptions.set(commandName, node.description);
  }
  return descriptions;
}

/** x-forge-commands group metadata flattened to dotted group paths (nested `groups` and dotted keys are the same). */
function collectGroupInfo(groups, parentPath, into) {
  for (const [name, node] of Object.entries(groups)) {
    if (!isRecord(node)) continue;
    const groupPath = parentPath ? `${parentPath}.${name}` : name;
    const info = {};
    if (typeof node.description === "string") info.description = node.description;
    if (typeof node["x-forge-epilogue"] === "string") info["x-forge-epilogue"] = node["x-forge-epilogue"];
    into[groupPath] = info;
    if (isRecord(node.groups)) collectGroupInfo(node.groups, groupPath, into);
  }
}

function loadCommandGroupInfo(openapi) {
  const groupInfo = {};
  for (const [commandName, command] of Object.entries(openapi["x-forge-commands"] ?? {})) {
    if (isRecord(command) && isRecord(command.groups)) {
      const commandGroups = {};
      collectGroupInfo(command.groups, "", commandGroups);
      groupInfo[commandName] = commandGroups;
    }
  }
  return groupInfo;
}

function parseStatus(operationId, value) {
  if (value === undefined) return "alpha";
  if (typeof value !== "string" || !METHOD_STATUSES.has(value)) throw new Error(`${operationId}: invalid x-fern-availability ${String(value)}`);
  return value;
}

/**
 * The metadata of one operation (or one of its x-forge-aliases).
 * @param {string} operationId
 * @param {string[]} group
 * @param {Record<string, any>} source
 * @param {boolean} ignore
 */
function parseMetadata(operationId, group, source, ignore) {
  const [commandName, ...groupPath] = group;
  if (!commandName) throw new Error(`${operationId}: the group has no command segment`);
  const methodRaw = source["x-fern-sdk-method-name"];
  const methodName = typeof methodRaw === "string" && methodRaw ? methodRaw : operationId.split(/[-_]+/).pop() || "get";
  const metadata = {
    operationId,
    commandName,
    groupPath,
    methodName,
    status: parseStatus(operationId, source["x-fern-availability"] ?? (source.deprecated === true ? "deprecated" : undefined)),
    ignore,
    hidden: source["x-forge-hidden"] === true,
  };
  if (Array.isArray(source["x-forge-globals"])) metadata.globals = source["x-forge-globals"];
  if (typeof source["x-forge-epilogue"] === "string") metadata.epilogue = source["x-forge-epilogue"];
  if (Array.isArray(source["x-forge-args"])) metadata.args = source["x-forge-args"];
  if (isRecord(source["x-forge-params"]) && Object.keys(source["x-forge-params"]).length > 0) metadata.params = source["x-forge-params"];
  if (typeof source["x-forge-require-confirmation"] === "string") metadata.requireConfirmation = source["x-forge-require-confirmation"];
  return metadata;
}

/** Every operation's metadata (aliases expand to several entries). */
function collectOperationMetadata(openapi) {
  const metadata = [];
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
    if (!isRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const { operationId } = operationIdOf(method, path, operation);
      const aliases = operation["x-forge-aliases"];
      if (Array.isArray(aliases)) {
        for (const alias of aliases) if (isRecord(alias)) metadata.push(parseMetadata(operationId, groupSegments(alias, path), alias, false));
        continue;
      }
      metadata.push(parseMetadata(operationId, groupSegments(operation, path), operation, operation["x-fern-ignore"] === true));
    }
  }
  return metadata;
}

function toSchemaMethod(metadata) {
  return {
    name: metadata.methodName,
    operationId: metadata.operationId,
    ...(metadata.epilogue !== undefined ? { epilogue: metadata.epilogue } : {}),
    ...(metadata.args !== undefined ? { args: metadata.args } : {}),
    ...(metadata.params !== undefined ? { params: metadata.params } : {}),
    ...(metadata.requireConfirmation !== undefined ? { requireConfirmation: metadata.requireConfirmation } : {}),
    status: metadata.status,
  };
}

function groupNode(groupPath) {
  return { methods: [], children: new Map(), groupPath };
}

function addToGroup(root, path, method) {
  let children = root;
  let currentPath = "";
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    currentPath = currentPath ? `${currentPath}.${segment}` : segment;
    const node = children.get(segment) ?? groupNode(currentPath);
    children.set(segment, node);
    if (i === path.length - 1) node.methods.push(method);
    else children = node.children;
  }
}

function toMethodGroups(nodes, groupInfo) {
  return [...nodes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, node]) => {
      const info = groupInfo[node.groupPath] ?? {};
      return {
        name,
        description: info.description ?? `Operations for ${node.groupPath}`,
        ...(info["x-forge-epilogue"] !== undefined ? { epilogue: info["x-forge-epilogue"] } : {}),
        methods: [...node.methods, ...toMethodGroups(node.children, groupInfo)],
      };
    });
}

function toSchemaCommand(commandName, items, description, groupInfo) {
  const visible = items.filter((item) => !item.ignore);
  const topLevelMethods = [];
  const groups = new Map();
  for (const item of visible) {
    const method = toSchemaMethod(item);
    if (item.groupPath.length === 0) topLevelMethods.push(method);
    else addToGroup(groups, item.groupPath, method);
  }
  return {
    name: commandName,
    description,
    methods: [...topLevelMethods, ...toMethodGroups(groups, groupInfo)],
    globalCliArgs: items.find((item) => item.globals)?.globals ?? [],
    hideCommand: visible.every((item) => item.hidden),
  };
}

function groupByCommand(items) {
  const byCommand = new Map();
  for (const item of items) byCommand.set(item.commandName, [...(byCommand.get(item.commandName) ?? []), item]);
  return byCommand;
}

function validateCommandMetadata(forge) {
  const errors = [];
  for (const [, command] of forge.commands) {
    errors.push(...resolveCommandDescriptions(command, (opId) => forge.getOperationDescription(opId), (opId) => forge.getOperationSummary(opId)));
    errors.push(...resolveCommandArgDescriptions(command, (opId) => forge.getParameterDescriptions(opId)));
  }
  if (errors.length > 0) throw new Error(`OpenAPI command metadata validation errors:\n${errors.map((error) => `  ${error}`).join("\n")}`);
}

/**
 * A Forge instance from an OpenAPI document: the command tree (commands, nested groups, unique method names) and the
 * resolver of every operation. Throws on a duplicate operationId, an invalid x-fern-availability, or an operation
 * without a summary or description.
 * @param {object} openapi
 * @returns {Forge}
 */
export function initFromOpenApi(openapi) {
  const commandDescriptions = loadCommandDescriptions(openapi);
  const commandGroupInfo = loadCommandGroupInfo(openapi);
  const resolver = populateOperationMap(openapi);
  const forge = new Forge(openapi, resolver);
  const metadata = collectOperationMetadata(openapi);
  const metadataByOperationId = new Map();
  for (const item of metadata) {
    const entry = {
      operationId: item.operationId,
      "x-fern-sdk-group-name": [item.commandName, ...item.groupPath].join("."),
      "x-fern-sdk-method-name": item.methodName,
      "x-fern-ignore": item.ignore,
      _ref: item,
    };
    metadataByOperationId.set(item.operationId, [...(metadataByOperationId.get(item.operationId) ?? []), entry]);
  }
  ensureUniqueSdkMethodNames(metadataByOperationId);
  for (const entries of metadataByOperationId.values()) for (const entry of entries) entry._ref.methodName = entry["x-fern-sdk-method-name"];
  for (const [commandName, items] of [...groupByCommand(metadata).entries()].sort(([a], [b]) => a.localeCompare(b))) {
    forge.commands.set(commandName, toSchemaCommand(commandName, items, commandDescriptions.get(commandName) ?? commandName, commandGroupInfo[commandName] ?? {}));
  }
  validateCommandMetadata(forge);
  return forge;
}
