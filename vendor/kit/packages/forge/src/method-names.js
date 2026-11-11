// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/shared/sdk-method-names.ts (origin commit: ../ORIGIN.json).
// Copyright Cloudflare, Inc. Modifications copyright 2026 Iran Open Finance: TypeScript to JavaScript (JSDoc types);
// fernMethodName is exported as sdkMethodName (the normalisation every SDK target applies); behaviour unchanged.
import { createHash } from "node:crypto";

/**
 * @typedef {object} SdkMethodMetadata
 * @property {string} [operationId]
 * @property {string} x-fern-sdk-group-name   dotted group path ("items.reviews")
 * @property {string} x-fern-sdk-method-name  the method name inside the group
 * @property {boolean} [x-fern-ignore]
 */

/**
 * A method name as SDK generators normalise it: words joined in camelCase.
 * @param {string} value
 */
export function sdkMethodName(value) {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase()}${word.slice(1)}`)).join("");
  return joined ? `${joined[0]?.toLowerCase()}${joined.slice(1)}` : "operation";
}

/**
 * Ensure every generated method name is unique within its group.
 *
 * Contracts occasionally give several operations of one group the same generic name (`get`, `create`). Every member of
 * a collision is renamed from its operationId, so the result is deterministic and independent of traversal order;
 * names that still collide get a stable sha256 suffix. Mutates the metadata; returns how many names changed.
 *
 * @template {SdkMethodMetadata} T
 * @param {Map<string, T[]>} metadataByOperationId
 * @returns {number}
 */
export function ensureUniqueSdkMethodNames(metadataByOperationId) {
  /** @type {Map<string, { metadata: T, identity: string, hashIdentity: string }[]>} */
  const byKey = new Map();

  for (const [mapIdentity, variants] of metadataByOperationId) {
    variants.forEach((metadata, index) => {
      if (metadata["x-fern-ignore"]) return;
      const group = metadata["x-fern-sdk-group-name"].split(".").map(sdkMethodName).join("\0");
      const method = sdkMethodName(metadata["x-fern-sdk-method-name"]);
      const key = `${group}\0${method}`;
      const entries = byKey.get(key) ?? [];
      const operationIdentity = metadata.operationId ?? mapIdentity;
      const identity = index === 0 ? operationIdentity : `${operationIdentity}-alias-${index}`;
      entries.push({ metadata, identity, hashIdentity: `${mapIdentity}\0${identity}` });
      byKey.set(key, entries);
    });
  }

  const collisions = [...byKey.values()].filter((entries) => entries.length > 1);
  const collidingEntries = new Set(collisions.flat());
  const used = new Set([...byKey.entries()].filter(([, entries]) => entries.length === 1).map(([key]) => key));
  let renamed = 0;
  const candidates = [...collidingEntries]
    .map((entry) => ({ entry, base: sdkMethodName(entry.identity) }))
    .sort((a, b) => a.entry.hashIdentity.localeCompare(b.entry.hashIdentity));
  const baseCounts = new Map();
  for (const { base } of candidates) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);

  for (const { entry, base } of candidates) {
    const group = entry.metadata["x-fern-sdk-group-name"].split(".").map(sdkMethodName).join("\0");
    let next = base;
    let key = `${group}\0${sdkMethodName(next)}`;
    if ((baseCounts.get(base) ?? 0) > 1 || used.has(key)) {
      const hash = createHash("sha256").update(entry.hashIdentity).digest("hex");
      let suffixLength = 8;
      do {
        const suffix = hash.slice(0, suffixLength);
        next = `${base}${suffix[0]?.toUpperCase()}${suffix.slice(1)}`;
        key = `${group}\0${sdkMethodName(next)}`;
        suffixLength += 2;
      } while (used.has(key) && suffixLength <= hash.length);
      if (used.has(key)) throw new Error(`Could not derive a unique SDK method name for ${entry.identity}`);
    }
    used.add(key);
    if (entry.metadata["x-fern-sdk-method-name"] === next) continue;
    entry.metadata["x-fern-sdk-method-name"] = next;
    renamed += 1;
  }
  return renamed;
}
