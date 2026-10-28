// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance. Portions ported from Cloudflare Forge, Copyright Cloudflare, Inc. (NOTICE).
/**
 * @saasreport/forge: schema-first OpenAPI code generation, native to the kit (docs/SDK.md).
 *
 * Forge's core, ported from Cloudflare Forge and owned here (origin: ORIGIN.json): the OpenAPI resolver, the plugin
 * host (Forge, SourceFile, transform/emit), the command tree (initFromOpenApi) and its naming rules; and the native
 * targets that replace upstream's Docker and Fern generators: a JavaScript client with TypeScript declarations, a Node
 * CLI and a typed Python client.
 */
export { Forge, SourceFile } from "./forge.js";
export { initFromOpenApi, groupSegments, groupSegment } from "./init-from-openapi.js";
export {
  createResolver, populateOperationMap, resolveOperation, resolveDocRef, resolveSchemaRef, getAllOperationIds, hasOperation,
  matchResponseStatusKey, operationIdOf, isJsonMediaType,
} from "./openapi-resolver.js";
export * from "./schema.js";
export * from "./schema-utils.js";
export { ensureUniqueSdkMethodNames, sdkMethodName } from "./method-names.js";
export { camelToPascal, pascalToCamel, toCamelCase, toKebabCase, toPascalCase, toSnakeCase } from "./naming.js";
export { escapeString, generatedFileHeader, indent, pluralize, singularize, toIdentifier, trimBlankLines, wrapText } from "./strings.js";
export { HTTP_METHODS, isDestructiveMethod, isIdempotentMethod, isMutatingMethod, isSafeMethod, methodHasBody, responseHasNoContent } from "./http.js";
export { admitsNull, buildModel, paramSpec, responseKinds, STYLES, DEFAULT_STYLE } from "./model.js";
export { generate, TARGETS } from "./generate.js";
export { tsType, tsKey } from "./targets/ts-types.js";
export { pyType, pySchemaNames } from "./targets/py-types.js";
export { pyModuleName, pyName, pyArgNames } from "./targets/python.js";
export { ORIGIN, PACKAGE } from "./origin.js";
