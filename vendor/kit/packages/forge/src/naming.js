// SPDX-License-Identifier: Apache-2.0
// Ported from Cloudflare Forge, packages/forge/shared/naming.ts (origin commit: ../ORIGIN.json). Copyright Cloudflare, Inc.
// Modifications copyright 2026 Iran Open Finance: TypeScript to JavaScript (JSDoc types); behaviour unchanged.

/**
 * Shared naming utilities: consistent case conversion used by every target.
 */

/**
 * Convert a kebab-case or snake_case string to camelCase.
 *
 * @example
 * toCamelCase('my-variable') // 'myVariable'
 * toCamelCase('my_variable') // 'myVariable'
 * toCamelCase('MyVariable') // 'myVariable'
 * @param {string} str
 * @returns {string}
 */
export function toCamelCase(str) {
  // Handle already camelCase strings
  if (!str.includes("-") && !str.includes("_")) {
    return str.charAt(0).toLowerCase() + str.slice(1);
  }
  return str.toLowerCase().replace(/[-_](.)/g, (_, char) => char.toUpperCase());
}

/**
 * Convert a kebab-case, snake_case, or camelCase string to PascalCase.
 *
 * @example
 * toPascalCase('my-variable') // 'MyVariable'
 * @param {string} str
 * @returns {string}
 */
export function toPascalCase(str) {
  const camel = toCamelCase(str);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Convert a camelCase or PascalCase string to kebab-case.
 *
 * @example
 * toKebabCase('myVariable') // 'my-variable'
 * toKebabCase('my_variable') // 'my-variable'
 * @param {string} str
 * @returns {string}
 */
export function toKebabCase(str) {
  // First replace underscores with hyphens, then insert hyphens before uppercase letters
  return str.replace(/_/g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Convert a camelCase or PascalCase string to snake_case.
 *
 * @example
 * toSnakeCase('myVariable') // 'my_variable'
 * toSnakeCase('my-variable') // 'my_variable'
 * @param {string} str
 * @returns {string}
 */
export function toSnakeCase(str) {
  // First replace hyphens with underscores, then insert underscores before uppercase letters
  return str.replace(/-/g, "_").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Convert camelCase to PascalCase (capitalize first letter).
 * @param {string} str
 * @returns {string}
 */
export function camelToPascal(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert PascalCase to camelCase (lowercase first letter).
 * @param {string} str
 * @returns {string}
 */
export function pascalToCamel(str) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
