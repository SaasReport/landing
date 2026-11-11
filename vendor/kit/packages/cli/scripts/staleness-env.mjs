#!/usr/bin/env node
/**
 * The env block of the staleness workflows' alert step has one source: the alert channels' own registry (alertVariables of @saasreport/channels), for the
 * routes a GitHub runner can reach (RUNNER_ROUTES of staleness.js). Every secret a reachable route reads is passed, so a Bale-only site reports a route.
 * It is never a hand list: the `generated:alert-env` block of each workflow is written from the registry.
 *   node packages/cli/scripts/staleness-env.mjs          rewrite the blocks
 *   node packages/cli/scripts/staleness-env.mjs --check  exit 1 when a block differs from the registry (kit check freshness)
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { blocksIn, replaceBlock } from "../../core/scripts/generated-blocks.mjs";
import { routeSecrets } from "../src/staleness.js";

export const FILES = [".github/workflows/staleness.yml", "templates/ci/staleness.yml"];
export const BLOCK = "alert-env";

/** The block's lines for an indent: one `NAME: ${{ secrets.NAME }}` per secret of every runner route, in registry order. */
export function envBody(indent) {
  return routeSecrets().map((s) => `${indent}${s.name}: \${{ secrets.${s.name} }}\n`).join("");
}

/** Problems of one workflow's text: the block missing, or different from what the registry says. */
export function envProblems(text) {
  let b;
  try { b = blocksIn(text).find((x) => x.name === BLOCK); } catch (e) { return [e.message]; }
  if (!b) return [`generated:${BLOCK} block is missing: the alert step's env must be generated from the route registry`];
  const have = text.slice(b.start, b.end), want = envBody(b.indent);
  return have === want ? [] : [`generated:${BLOCK} differs from the route registry (a route's secret is missing or one is hand-added): run node packages/cli/scripts/staleness-env.mjs`];
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -e): not run directly */ } })();
if (isMain) {
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const f of FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    if (check) { for (const m of envProblems(text)) { console.error(`${f}: ${m}`); bad++; } continue; }
    const b = blocksIn(text).find((x) => x.name === BLOCK);
    if (b) writeFileSync(p, replaceBlock(text, BLOCK, envBody(b.indent)));
  }
  process.exit(bad ? 1 : 0);
}
