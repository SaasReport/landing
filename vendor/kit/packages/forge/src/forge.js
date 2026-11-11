// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/forge.ts (origin commit: ../ORIGIN.json). Copyright Cloudflare, Inc.
// Modifications copyright 2026 Iran Open Finance:
//   - TypeScript to JavaScript (JSDoc types); no openapi-types dependency (the method list is http.js HTTP_METHODS).
//   - A Forge instance owns its resolver (forge.resolveOperation, forge.resolveDocRef) instead of the module-wide one.
//   - Operations without an operationId are indexed under their derived id (openapi-resolver.js operationIdOf).
//   - Duplicate operationIds throw with every duplicate named and nothing printed (upstream logged them to stderr).
//   - finalize() refuses a path that only shares a prefix with the output directory ("out-evil" beside "out").
//   - Not ported: getMissingDescriptions (a console report for Cloudflare's overlay work).

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";
import { HTTP_METHODS } from "./http.js";
import { createResolver, matchResponseStatusKey, operationIdOf } from "./openapi-resolver.js";
import { walkAllMethods } from "./schema-utils.js";

/**
 * A transformer receives a Forge instance and calls `forge.emit(path, content)` for every file it generates.
 * @typedef {(forge: Forge) => Promise<void> | void} TransformerFn
 */

/** A leaf (method name) or a branch ({ groupName: children }) of the method map. @typedef {string | Record<string, any[]>} MethodMapEntry */

/** A generated file: a relative path and its content. */
export class SourceFile {
  /**
   * @param {string} path relative file path ("index.mjs", "python/pkg/__init__.py")
   * @param {string} content
   */
  constructor(path, content) {
    /** @readonly */ this.path = path;
    /** @readonly */ this.content = content;
  }

  toString() {
    return this.content;
  }
}

/**
 * Forge: the plugin host for code-generation transformers.
 *
 *   const forge = initFromOpenApi(contract);       // command tree from the contract
 *   const files = await forge.transform(target);   // a transformer emits files
 *   await forge.finalize("./out", files);          // or write them yourself
 */
export class Forge {
  #openapi;
  /** @type {Record<string, any>} */
  #byOperationId = {};
  /** @type {Record<string, string>} */
  #verbPathByOperationId = {};
  /** @type {SourceFile[]} */
  #files = [];

  /**
   * @param {object} openapi an OpenAPI 3.x document
   * @param {ReturnType<typeof createResolver>} [resolver] a resolver already built over the same document
   */
  constructor(openapi, resolver) {
    this.#openapi = openapi;
    /** Command schemas by command name. @type {Map<string, import("./schema.js").Command>} */
    this.commands = new Map();
    /** The resolver over this instance's document. */
    this.resolver = resolver ?? createResolver(openapi);
    this.#createByOperationId();
  }

  /** The document this instance was built from. */
  get openapi() {
    return this.#openapi;
  }

  /** @param {string} operationId */
  resolveOperation(operationId) {
    return this.resolver.resolveOperation(operationId);
  }

  /** @template T @param {T} value @returns {T} */
  resolveDocRef(value) {
    return this.resolver.resolveDocRef(value);
  }

  // ── method introspection ──────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The command tree as nested lists: [{ command: [method, { group: [...] }] }], sorted by name at every level.
   * @returns {Record<string, MethodMapEntry[]>[]}
   */
  methodMap() {
    const mkNode = () => ({ methods: [], groups: new Map() });
    const pushUnique = (arr, v) => {
      if (!arr.includes(v)) arr.push(v);
    };
    const addToTree = (root, groupPath, methodName) => {
      if (!groupPath) return pushUnique(root.methods, methodName);
      let cursor = root;
      for (const seg of groupPath.split(".").filter(Boolean)) {
        const child = cursor.groups.get(seg) ?? mkNode();
        cursor.groups.set(seg, child);
        cursor = child;
      }
      pushUnique(cursor.methods, methodName);
    };
    const treeToList = (node) =>
      [
        ...node.methods.map((m) => ({ key: m, item: m })),
        ...[...node.groups.entries()].map(([name, child]) => ({ key: name, item: { [name]: treeToList(child) } })),
      ]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((e) => e.item);
    const trees = new Map();
    for (const [commandName, schema] of this.commands) {
      const root = trees.get(commandName) ?? mkNode();
      trees.set(commandName, root);
      walkAllMethods(schema.methods, (method, groupPath) => addToTree(root, groupPath, method.name));
    }
    return [...trees.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, node]) => ({ [name]: treeToList(node) }));
  }

  /**
   * How many methods there are, and how often each name is used (most frequent first).
   * @returns {{ total: number, byMethod: Record<string, number> }}
   */
  methodStats() {
    const counts = {};
    let total = 0;
    for (const [, schema] of this.commands) {
      walkAllMethods(schema.methods, (method) => {
        counts[method.name] = (counts[method.name] ?? 0) + 1;
        total++;
      });
    }
    return { total, byMethod: Object.fromEntries(Object.entries(counts).sort(([a, ca], [b, cb]) => cb - ca || a.localeCompare(b))) };
  }

  // ── output ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Buffer a generated file (call it from a transformer).
   * @param {string} path
   * @param {string} content
   */
  emit(path, content) {
    this.#files.push(new SourceFile(path, content));
  }

  /**
   * Run a transformer, then drain the buffer: every file it emitted, in emit order. The instance can run another.
   * @param {TransformerFn} fn
   * @returns {Promise<SourceFile[]>}
   */
  async transform(fn) {
    await fn(this);
    const snapshot = [...this.#files];
    this.#files.length = 0;
    return snapshot;
  }

  /**
   * Write files under outputDir (directories created as needed; `clean` empties it first). Every path must land inside.
   * @param {string} outputDir
   * @param {SourceFile[]} files
   * @param {{ clean?: boolean }} [options]
   */
  async finalize(outputDir, files, options) {
    const root = resolve(outputDir);
    const resolvedFiles = new Map();
    for (const file of files) {
      const fullPath = resolve(root, normalize(file.path));
      if (!fullPath.startsWith(`${root}${sep}`)) throw new Error(`Path traversal detected: "${file.path}" resolves outside output directory`);
      resolvedFiles.set(fullPath, file.content);
    }
    if (options?.clean) await rm(root, { recursive: true, force: true });
    await Promise.all([...new Set([...resolvedFiles.keys()].map((p) => dirname(p)))].map((dir) => mkdir(dir, { recursive: true })));
    await Promise.all([...resolvedFiles.entries()].map(([fullPath, content]) => writeFile(fullPath, content)));
    return files;
  }

  // ── OpenAPI queries ───────────────────────────────────────────────────────────────────────────────────────────────

  #createByOperationId() {
    const byOperationId = {};
    const duplicates = new Map();
    for (const [path, pathItem] of Object.entries(this.#openapi.paths ?? {})) {
      if (!pathItem) continue;
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;
        const { operationId } = operationIdOf(method, path, operation);
        const where = `${method.toUpperCase()} ${path}`;
        if (operationId in byOperationId) {
          duplicates.set(operationId, [...(duplicates.get(operationId) ?? [this.#verbPathByOperationId[operationId]]), where]);
        } else {
          byOperationId[operationId] = operation;
          this.#verbPathByOperationId[operationId] = where;
        }
      }
    }
    this.#byOperationId = Object.fromEntries(Object.entries(byOperationId).sort((a, b) => a[0].localeCompare(b[0])));
    if (duplicates.size > 0) {
      throw new Error(`Duplicate operation ids found: ${[...duplicates].map(([id, where]) => `${id} (${where.join(", ")})`).join("; ")}`);
    }
  }

  /** Lookup keys have apostrophes stripped (as the resolver's); callers may pass the literal id. */
  #normalizeOperationId(operationId) {
    return String(operationId).replace(/'/g, "");
  }

  /** The operation's description (else summary); throws when it has neither or does not exist. */
  getDescription(operationId) {
    const operation = this.#byOperationId[this.#normalizeOperationId(operationId)];
    if (!operation) throw new Error(`Operation id ${operationId} not found`);
    const description = operation.description ?? operation.summary;
    if (!description) throw new Error(`Operation id ${operationId} has no description`);
    return description;
  }

  /** The operation's description (else summary), or undefined. */
  getOperationDescription(operationId) {
    const operation = this.#byOperationId[this.#normalizeOperationId(operationId)];
    return operation ? (operation.description ?? operation.summary) : undefined;
  }

  /** The operation's one-line summary, or undefined. */
  getOperationSummary(operationId) {
    return this.#byOperationId[this.#normalizeOperationId(operationId)]?.summary;
  }

  /** Every operationId, sorted. */
  getOperationIds() {
    return Object.keys(this.#byOperationId).sort();
  }

  /** "GET /path" of an operation. */
  getVerbPath(operationId) {
    return this.#verbPathByOperationId[this.#normalizeOperationId(operationId)];
  }

  /**
   * Parameter name → description for an operation (parameters, then JSON body properties), $refs followed.
   * @param {string} operationId
   * @returns {Map<string, string>}
   */
  getParameterDescriptions(operationId) {
    const operation = this.#byOperationId[this.#normalizeOperationId(operationId)];
    if (!operation) throw new Error(`Operation id ${operationId} not found`);
    const descriptions = new Map();
    for (const paramOrRef of operation.parameters ?? []) {
      const param = this.#resolveRef(paramOrRef);
      if (!param || !param.name) continue;
      if (param.description) {
        descriptions.set(param.name, param.description);
        continue;
      }
      const schema = param.schema ? this.#resolveRef(param.schema) : undefined;
      if (schema?.description) descriptions.set(param.name, schema.description);
    }
    const body = operation.requestBody ? this.#resolveRef(operation.requestBody) : undefined;
    const jsonSchema = body?.content?.["application/json"]?.schema;
    if (jsonSchema) this.#collectPropertyDescriptions(jsonSchema, descriptions);
    return descriptions;
  }

  /**
   * The response declared for an actual HTTP status: exact, then its range ("4XX"), then "default"; else undefined.
   * @param {string} operationId
   * @param {number} status
   */
  matchResponseStatus(operationId, status) {
    const info = this.resolveOperation(this.#normalizeOperationId(operationId));
    if (!info) return undefined;
    const key = matchResponseStatusKey(status, Object.keys(info.responses));
    return key === undefined ? undefined : info.responses[key];
  }

  #resolveRef(obj) {
    if (!obj || typeof obj !== "object" || !obj.$ref) return obj;
    let current = this.#openapi;
    for (const part of obj.$ref.replace(/^#\//, "").split("/")) {
      if (!current || typeof current !== "object") return undefined;
      current = current[decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")];
    }
    return current;
  }

  #collectPropertyDescriptions(schemaOrRef, descriptions, visited = new Set()) {
    const schema = this.#resolveRef(schemaOrRef);
    if (!schema || visited.has(schema)) return;
    visited.add(schema);
    for (const [name, propOrRef] of Object.entries(schema.properties ?? {})) {
      if (descriptions.has(name)) continue;
      const prop = this.#resolveRef(propOrRef);
      if (prop?.description) descriptions.set(name, prop.description);
    }
    for (const item of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
      this.#collectPropertyDescriptions(item, descriptions, visited);
    }
  }
}
