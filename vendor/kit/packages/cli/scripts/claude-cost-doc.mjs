#!/usr/bin/env node
/**
 * docs/COST.md carries two generated blocks, both from the policy (packages/core/registry/claude.policy.json):
 * the defaults table and the admin-console JSON. Never edit them by hand.
 *   node packages/cli/scripts/claude-cost-doc.mjs          rewrite the blocks
 *   node packages/cli/scripts/claude-cost-doc.mjs --check  exit 1 when a block differs from the policy (kit check freshness)
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replaceBlock } from "../../core/scripts/generated-blocks.mjs";
import { bundled } from "../src/canon/index.js";
import { loadPolicy, managedSettings, resolveModel } from "../src/claude.js";

const DOC = new URL("../../../docs/COST.md", import.meta.url);
const kit = bundled();
const { policy, problems } = loadPolicy(new URL("../../../", import.meta.url).pathname, kit);
if (!policy) { console.error(problems.map((p) => `${p.file}: ${p.problem}`).join("\n")); process.exit(1); }

export const blocks = {
  "claude-defaults": () => ["| Setting | Default | Where it lands |", "|---|---|---|",
    `| Main model | \`${policy.model}\` | \`.claude/settings.json\` \`model\` |`,
    `| Effort | \`${policy.effort}\` | \`effortLevel\` |`,
    `| Subagent model | \`${policy.subagents.model}\` (search: \`${policy.subagents.searchModel}\`) | \`env.CLAUDE_CODE_SUBAGENT_MODEL\` |`,
    `| Concurrent subagents | ${policy.subagents.maxConcurrent} | \`env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS\` |`,
    `| Subagent cache lifetime | \`${policy.subagents.promptCacheTtl}\` | \`env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL\` |`,
    `| CLAUDE.md | at most ${policy.claudeMd.maxLines} lines | \`kit check claude\` |`,
    `| Agent \`maxTurns\` | required, at most ${policy.agents.maxTurnsCeiling}; models ${policy.agents.allowedModels.map((m) => `\`${m}\``).join(", ")} | \`kit check claude\` |`,
    ...Object.entries(policy.agents.standard).map(([n, a]) => `| Agent \`${n}\` | \`${resolveModel(policy, a.model)}\`, maxTurns ${a.maxTurns}, ${a.tools ? `tools ${a.tools.join(" ")}` : "all tools"} | \`.claude/agents/${n}.md\` |`),
    `| Agent loops | at most ${policy.loops.maxIterations} iterations and ${policy.loops.wallClockMinutes} minutes, declared in the script | \`kit check claude\` |`].join("\n"),
  "claude-managed": () => `\`\`\`json\n${JSON.stringify(managedSettings(policy), null, 2)}\n\`\`\``,
  "claude-spend": () => ["| Where | Proposed monthly limit |", "|---|---|",
    `| Member (Claude Teams or Enterprise, admin settings) | ${policy.managed.spendLimitsUsd.member} USD |`,
    `| Organisation (admin settings, usage credits) | ${policy.managed.spendLimitsUsd.organization} USD |`,
    `| Console workspace \`Claude Code\` (API organisations) | ${policy.managed.spendLimitsUsd.workspace} USD |`].join("\n"),
};

/** docs/COST.md with every block rewritten from the policy, through the shared reader (each block exactly once, or this throws). */
export function renderDoc(doc) {
  let next = doc;
  for (const [name, body] of Object.entries(blocks)) next = replaceBlock(next, name, `${body()}\n`);
  return next;
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; /* argv[1] names no file (node -e): not run directly */ } })();
if (isMain) {
  const doc = readFileSync(DOC, "utf8");
  let next;
  try { next = renderDoc(doc); } catch (e) { console.error(`docs/COST.md: ${e.message}`); process.exit(1); }
  if (process.argv.includes("--check")) {
    if (next !== doc) { console.error("docs/COST.md: a generated block is stale (run node packages/cli/scripts/claude-cost-doc.mjs)"); process.exit(1); }
    console.log("ok: docs/COST.md generated blocks = policy");
  } else if (next !== doc) { writeFileSync(DOC, next); console.log("docs/COST.md: generated blocks rewritten from the policy"); }
}
