#!/usr/bin/env node
/**
 * The project table in docs/NAMING.md is generated from the project registry (packages/core/registry/projects.json),
 * between <!-- generated:registry --> and <!-- /generated:registry -->. Never edit the table by hand.
 *   node packages/core/scripts/registry-table.mjs          rewrite the table
 *   node packages/core/scripts/registry-table.mjs --check  exit 1 when the table differs from the registry (kit check freshness)
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replaceBlock } from "./generated-blocks.mjs";

const root = new URL("../../../", import.meta.url);
const DOC = new URL("docs/NAMING.md", root);
const registry = JSON.parse(readFileSync(new URL("packages/core/registry/projects.json", root), "utf8"));
const START = "<!-- generated:registry (packages/core/registry/projects.json; node packages/core/scripts/registry-table.mjs) -->";
const END = "<!-- /generated:registry -->";

export function table(reg) {
  const short = (p) => (!p.short ? (p.shortPolicy === "none" ? "(none, by decision)" : "(none yet)") : p.short === p.prefix ? `\`${p.short}\` (the full prefix is already short)` : `\`${p.short}\``);
  return ["| Project | Domain | Full prefix | Short prefix |", "|---|---|---|---|",
    ...reg.projects.map((p) => `| ${p.name} | ${p.domain} | \`${p.prefix}\` | ${short(p)} |`)].join("\n");
}

export function render(doc, reg) {
  return replaceBlock(doc, "registry", `${table(reg)}\n`);      // the shared reader: the block appears exactly once, or this throws
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -e): not run directly */ } })();
if (isMain) {
  const doc = readFileSync(DOC, "utf8");
  let next;
  try { next = render(doc, registry); } catch (e) { console.error(e.message); process.exit(1); }
  if (process.argv.includes("--check")) {
    if (next !== doc) { console.error("docs/NAMING.md: the project table is stale (run node packages/core/scripts/registry-table.mjs)"); process.exit(1); }
    console.log("ok: docs/NAMING.md project table = registry");
  } else if (next !== doc) { writeFileSync(DOC, next); console.log("docs/NAMING.md: project table rewritten from the registry"); }
}
