#!/usr/bin/env node
/**
 * The project codes of the diagram schemas are generated from the project registry (packages/core/registry/projects.json), never
 * hand-copied: a code is the `short` without its dash, the key itself when the project has no short form, and `kit` for the kit.
 * Written into the id / ref patterns and the `project` enum of diagram.schema.json and the id pattern of diagram-externals.schema.json.
 *   node packages/core/scripts/project-codes.mjs          rewrite the schema files
 *   node packages/core/scripts/project-codes.mjs --check  exit 1 when a schema file differs from the registry (kit check freshness)
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);

/** Every project code, in registry order, then kit. */
/** A project's code: its short prefix without the dash, or its key when it has none. */
const code = (p) => (p.short ? p.short.replace(/-$/, "") : p.key);
export const projectCodes = (reg) => [...reg.projects.map(code), "kit"];

/** The id body every code-carrying pattern is rendered from: "<code>.<slug>". */
const ID = (alt) => `(${alt})\\.[a-z0-9]+(?:[.-][a-z0-9]+)*`;

/**
 * Every field that carries project codes, by JSON pointer, with its whole value: the generator owns these values, so any hand edit
 * (a code added or removed, the rest of a pattern changed) differs from the render and --check fails. One canonical template per field.
 */
export const FIELDS = {
  "packages/core/schemas/diagram.schema.json": {
    "/properties/id/pattern": (codes) => `^${ID(codes.join("|"))}$`,
    "/$defs/id/pattern": (codes) => `^${ID(codes.join("|"))}$`,
    "/$defs/ref/pattern": (codes) => `^(?:${ID(codes.join("|"))}|https://\\S+)$`,
    "/properties/project/enum": (codes) => [...codes],
  },
  "packages/core/schemas/diagram-externals.schema.json": {
    "/$defs/id/pattern": (codes) => `^${ID(codes.join("|"))}$`,
  },
  // the kit capability engine's projects: the registry's capabilityEngine flag (a project with its own native engine has none)
  "packages/core/registry/finding-classes.json": {
    "/classes/[id=capability-id-prefix]/detect/0/schema/properties/id/pattern": (codes, reg) => `^(${reg.projects.filter((p) => p.capabilityEngine).map(code).join("|")})\\.capability\\.[a-z0-9]+(-[a-z0-9]+)*(\\.[a-z0-9]+(-[a-z0-9]+)*)+$`,
  },
};

/** The schema files the generator writes: the files of FIELDS. */
export const FILES = Object.keys(FIELDS);

const unescape = (s) => s.replace(/~1/g, "/").replace(/~0/g, "~");
const escape = (s) => s.replace(/~/g, "~0").replace(/\//g, "~1");
/** Every string in a document that names project codes (an alternation ending in kit), by pointer. */
const codeStrings = (node, at = "", out = []) => {
  if (typeof node === "string") { if (/\|kit\)/.test(node)) out.push(at); }
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) codeStrings(v, `${at}/${escape(k)}`, out);
  return out;
};

/** The schema files' new text for this registry: → { <file>: text } (`read(file)` gives the current text). Throws when a declared field is
 *  missing or a code-carrying string sits in a field nobody declared: a field the generator cannot see is never silently accepted. */
export function render(reg, read) {
  const codes = projectCodes(reg);
  const out = {};
  for (const file of FILES) {
    const doc = JSON.parse(read(file)), fields = FIELDS[file];
    for (const at of codeStrings(doc)) if (!(at in fields) && !at.startsWith("/properties/project/enum/")) throw new Error(`${file}${at}: carries project codes but is not declared in FIELDS (packages/core/scripts/project-codes.mjs)`);
    for (const [at, value] of Object.entries(fields)) {
      const keys = at.split("/").slice(1).map(unescape), last = keys.pop();
      let node = doc;
      // a segment [id=<x>] is the element of an array whose id is <x>: a field is found by what it is, never by its position
      for (const k of keys) { const sel = /^\[id=(.+)\]$/.exec(k); node = sel ? (Array.isArray(node) ? node.find((e) => e?.id === sel[1]) : undefined) : node?.[k]; }
      if (!node || typeof node !== "object" || !(last in node)) throw new Error(`${file}${at}: declared in FIELDS but missing from the file`);
      node[last] = value(codes, reg);
    }
    out[file] = `${JSON.stringify(doc, null, 2)}\n`;
  }
  return out;
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -e): not run directly */ } })();
if (isMain) {
  const read = (f) => readFileSync(new URL(f, root), "utf8");
  const reg = JSON.parse(read("packages/core/registry/projects.json"));
  const next = render(reg, read);
  const stale = FILES.filter((f) => next[f] !== read(f));
  if (process.argv.includes("--check")) {
    if (stale.length) { console.error(`${stale.join(", ")}: the project codes drifted from the registry (run node packages/core/scripts/project-codes.mjs)`); process.exit(1); }
    console.log("ok: the project codes in the diagram schemas and the finding classes = registry");
  } else {
    for (const f of stale) { writeFileSync(new URL(f, root), next[f]); console.log(`${f}: project codes rewritten from the registry`); }
  }
}
