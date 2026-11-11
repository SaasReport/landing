/**
 * The plugin scaffolder behind `kit plugin new`: a Claude Code plugin whose skills are plain Agent Skills files.
 *   scaffoldPlugin({ prefix, displayName, description, skills: ["saasreport-settlement", …] | [{ name, description }],
 *                    mcp: { name, url } | null, api: url | null, author, license, homepage }) → { "<path>": "<content>" }
 * Every skill gets SKILL.md (inputs, steps, output folder, status rules) and a helper script that already writes
 * the run folder and compile-report.json; until it is implemented it reports one not_confirmed item, never a guess.
 */
import { RUNTIME_FILE, CHECK_FILE, runtimeSource, checkSource } from "./runtime.js";
import { PREFIXES, FULL_PREFIXES } from "./validate.js";

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function skillMd({ prefix, name, description, inputs = ["(describe each input)"], script = `${name}.mjs`, backend = "engine" }) {
  return `---
name: ${name}
description: ${JSON.stringify(description)}
argument-hint: "[inputs]"
allowed-tools: Bash(node *) Read
metadata:
  prefix: ${prefix}
  output: ./${prefix}-out/${name}/<run-id>/
---

# ${name}

## Inputs

${inputs.map((i) => `- ${i}`).join("\n")}

## Steps

1. Read the inputs from \`$ARGUMENTS\`; ask for any required input that is missing. Do not guess one.
2. Run the helper, which computes with the project's ${backend === "mcp" ? "engine (or its MCP server with --via mcp)" : backend} and writes the files:

   \`\`\`bash
   node "\${CLAUDE_PLUGIN_ROOT}/scripts/${script}" <inputs>
   \`\`\`

3. Read \`compile-report.json\` in the run folder it prints and answer from it, quoting each item's status.

## Output

\`./${prefix}-out/${name}/<run-id>/\`: the result files and \`compile-report.json\` (schema \`kit.compile-report.v1\`).

## Status rules

- \`confirmed\`: computed by the engine or quoted from a cited source, with nothing predicted.
- \`not_confirmed\`: depends on a predicted date, an unverified source, or has no source. Say so in the answer.
- \`flagged\`: needs a person (a known gap in the data, sources that disagree). Never present it as settled.
- Never add a fact that is not in the report.
- A \`flagged\` item may carry \`risk\` (1-10): how bad acting on it unchecked would be. Quote it.

## Critic and learnings

- With \`--critic\`, a second pass tries to falsify every \`confirmed\` item (another source, an edge case, the engine asked
  the other way round). Its verdict only lowers a status: refuted → \`flagged\`, inconclusive → \`not_confirmed\`.
- What a run learnt (a false positive, a pattern, a gap in the sources, a correction) goes to
  \`./${prefix}-out/learnings.jsonl\` (\`kit.plugin-learning.v1\`). Read it before a run; never edit past lines.
`;
}

const helper = ({ prefix, name }) => `#!/usr/bin/env node
// ${name}: helper for skills/${name}/SKILL.md. Writes ./${prefix}-out/${name}/<run-id>/ and compile-report.json.
import { cli, createRun } from "./lib/${RUNTIME_FILE}";

cli(async ({ _, flags }) => {
  const inputs = { args: _, ...flags };
  const run = createRun({ prefix: "${prefix}", skill: "${name}", inputs, engine: { name: "(the project's engine)", via: "engine" }, out: flags.out, critic: Boolean(flags.critic) });
  run.item({ id: "result", label: "${name}", value: null, status: "not_confirmed", sources: [], note: "Not implemented yet: the helper does not compute this result." });
  return run.finish();
});
`;

export function scaffoldPlugin({ prefix, displayName, description, skills = [], mcp = null, api = null, author, license = "Apache-2.0", homepage } = {}) {
  if (!PREFIXES.includes(prefix)) throw new Error(`prefix "${prefix}" is not in the naming constitution (${PREFIXES.join(", ")})`);
  const list = skills.map((s) => (typeof s === "string" ? { name: s } : s));
  if (!list.length) throw new Error("give at least one skill");
  for (const s of list) if (!KEBAB.test(s.name) || !s.name.startsWith(`${prefix}-`)) throw new Error(`skill "${s.name}" must be kebab-case and start with "${prefix}-"`);
  if (mcp && !(mcp.name === prefix || mcp.name.startsWith(`${prefix}-`) || mcp.name.startsWith(`${FULL_PREFIXES[prefix]}-`))) throw new Error(`MCP server "${mcp.name}" must carry the prefix "${prefix}" (or "${FULL_PREFIXES[prefix]}-")`);
  if (!author) throw new Error("give the author: the project's name (kit plugin new takes it from the project registry)");
  const backend = mcp ? { kind: "mcp", server: mcp.name, url: mcp.url } : api ? { kind: "api", url: api, note: "The project runs no MCP server; skills call its public API." } : { kind: "engine", note: "The project runs no MCP server or API; skills run the engine in-process." };
  const manifest = {
    name: prefix, displayName: displayName || prefix, version: "0.1.0",
    description: description || `${displayName || prefix}: skills that write working files and a compile report into ./${prefix}-out/.`,
    author: { name: author }, license, ...(homepage ? { homepage } : {}), keywords: ["kit", prefix],
    metadata: { kit: { prefix, outputDir: `${prefix}-out`, reportSchema: "kit.compile-report.v1", backend } },
  };
  const files = { ".claude-plugin/plugin.json": `${JSON.stringify(manifest, null, 2)}\n`, [`scripts/lib/${RUNTIME_FILE}`]: runtimeSource(), [`scripts/lib/${CHECK_FILE}`]: checkSource() };
  if (mcp) files[".mcp.json"] = `${JSON.stringify({ mcpServers: { [mcp.name]: { type: "http", url: mcp.url } } }, null, 2)}\n`;
  for (const s of list) {
    files[`skills/${s.name}/SKILL.md`] = skillMd({ prefix, name: s.name, description: s.description || `${s.name}: describe what it does and when to use it (at least one sentence).`, backend: backend.kind });
    files[`scripts/${s.name}.mjs`] = helper({ prefix, name: s.name });
  }
  files["README.md"] = `# ${displayName || prefix} agent plugin

A Claude Code plugin (\`.claude-plugin/plugin.json\`) whose skills are plain Agent Skills files (\`skills/<name>/SKILL.md\`),
so other agent runtimes can use them too. Every skill writes into \`./${prefix}-out/<skill>/<run-id>/\` with a
\`compile-report.json\` (kit.compile-report.v1): each item is confirmed, not_confirmed or flagged, with its sources.

| Skill | What it does |
| --- | --- |
${list.map((s) => `| \`${s.name}\` | ${s.description || "(describe)"} |`).join("\n")}

Backend: ${backend.kind === "mcp" ? `MCP server \`${mcp.name}\` at ${mcp.url}` : backend.note}

\`\`\`bash
claude --plugin-dir ./plugins/${prefix}     # try it locally
claude plugin validate ./plugins/${prefix}  # the manifest check
node ./plugins/${prefix}/scripts/lib/kit-plugin-check.mjs ./plugins/${prefix}   # the kit's checks, standalone
\`\`\`
`;
  return files;
}
