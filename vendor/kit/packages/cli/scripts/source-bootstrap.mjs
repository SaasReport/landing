#!/usr/bin/env node
// The site bootstrap of the kit at t=0 (docs/FRESHNESS.md) is ONE implementation, packages/cli/src/source-bootstrap.mjs; the file a
// site commits, templates/site/scripts/kit.mjs, is its copy, written here and checked by kit check canon › freshness (never hand-edited).
//   node packages/cli/scripts/source-bootstrap.mjs            write templates/site/scripts/kit.mjs
//   node packages/cli/scripts/source-bootstrap.mjs --check    exit 1 when the template differs from the implementation
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../src/source-bootstrap.mjs"), OUT = resolve(here, "../../../templates/site/scripts/kit.mjs");
const want = readFileSync(SRC, "utf8");
if (process.argv.includes("--check")) {
  const have = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  if (have !== want) { console.error("templates/site/scripts/kit.mjs differs from packages/cli/src/source-bootstrap.mjs: run node packages/cli/scripts/source-bootstrap.mjs"); process.exit(1); }
  console.log("ok: templates/site/scripts/kit.mjs is the bootstrap implementation");
} else { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, want); console.log("written: templates/site/scripts/kit.mjs"); }
