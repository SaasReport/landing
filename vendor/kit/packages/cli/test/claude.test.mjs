// The Claude Code cost standard (docs/COST.md): the policy schema and its bounds, the generator (idempotent, keeps
// foreign keys), and every failure of kit check claude.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bundled } from "../src/canon/index.js";
import { checkClaude, loadPolicy, syncClaude, loopBudget, managedSettings, parseAgent, deepMerge, desiredAgents, codeOf, agentEfforts, kitCommand, GENERATED } from "../src/claude.js";
import { main } from "../src/index.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const kit = bundled();
const defaults = JSON.parse(readFileSync(new URL("../../core/registry/claude.policy.json", import.meta.url), "utf8"));
const complete = (v) => kit.validator.validate(v, { $ref: `${kit.byName("claude-policy").$id}#/$defs/complete` });
const partial = (v) => kit.validator.validate({ $schema: "x", extends: "kit", ...v }, kit.byName("claude-policy"));

let n = 0;
const TMP = fileTempDir("kit-claude-");
const repo = (files = {}) => {
  const root = join(TMP, `r${n++}`);
  mkdirSync(root, { recursive: true });
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), typeof body === "string" ? body : JSON.stringify(body)); }
  return root;
};
const synced = (files = {}) => { const root = repo(files); const { policy } = loadPolicy(root, kit); syncClaude(root, policy); return root; };
const problems = (root) => checkClaude(root, {}, kit).problems.map((p) => `${p.file}: ${p.problem}`);

test("schema: the kit defaults are complete and carry the declared standard", () => {
  assert.deepEqual(complete(defaults), []);
  assert.equal(defaults.subagents.model, "sonnet");
  assert.equal(defaults.subagents.searchModel, "haiku");
  assert.equal(defaults.subagents.maxConcurrent, 4);
  assert.equal(defaults.effort, "medium");
  assert.equal(defaults.claudeMd.maxLines, 200);
  assert.deepEqual(Object.entries(defaults.agents.standard).map(([k, a]) => [k, a.model, a.maxTurns]), [["kit-explore", "search", 8], ["kit-review", "subagent", 15], ["kit-implement", "subagent", 40]]);
  assert.deepEqual(defaults.agents.standard["kit-explore"].tools, ["Read", "Grep", "Glob"]);
  assert.ok(defaults.loops.maxIterations > 0 && defaults.loops.wallClockMinutes > 0);
});

test("schema: an incomplete defaults file, and every bound, are rejected", () => {
  const { claudeMd, ...noMd } = defaults;
  assert.ok(complete(noMd).length, "claudeMd missing");
  const noTurns = structuredClone(defaults); delete noTurns.agents.standard["kit-review"].maxTurns;
  assert.ok(complete(noTurns).some((p) => /standard\/kit-review\/maxTurns: is required/.test(p.path + ": " + p.message)));
  assert.deepEqual(partial({ claudeMd: { maxLines: 120 }, effort: "low" }), []);
  for (const bad of [{ claudeMd: { maxLines: 201 } }, { effort: "xhigh" }, { effort: "max" }, { model: "opus" }, { subagents: { model: "opus" } },
    { subagents: { maxConcurrent: 9 } }, { subagents: { maxConcurrent: 0 } }, { agents: { maxTurnsCeiling: 51 } },
    { agents: { standard: { x: { maxTurns: 51 } } } }, { loops: { maxIterations: 51 } }, { loops: { wallClockMinutes: 121 } },
    { agents: { allowedModels: ["gpt"] } }, { managed: { maxEffortLevel: "high" } }, { surprise: 1 }])
    assert.ok(partial(bad).length, JSON.stringify(bad));
});

test("policy: a project's override merges over the defaults; out-of-bounds, unknown and non-extending files are refused", () => {
  const ok = repo({ "claude.policy.json": { $schema: "x", extends: "kit", claudeMd: { maxLines: 120 }, subagents: { maxConcurrent: 2 }, agents: { standard: { "kit-review": { maxTurns: 10 } } } } });
  const { policy, problems: p } = loadPolicy(ok, kit);
  assert.deepEqual(p, []);
  assert.equal(policy.claudeMd.maxLines, 120);
  assert.equal(policy.subagents.maxConcurrent, 2);
  assert.equal(policy.subagents.model, "sonnet");
  assert.equal(policy.agents.standard["kit-review"].maxTurns, 10);
  assert.equal(policy.agents.standard["kit-review"].tools.length, 3);
  assert.equal(policy.extends, undefined);
  for (const own of [{ extends: "kit", claudeMd: { maxLines: 500 } }, { claudeMd: { maxLines: 100 } }, { extends: "kit", managed: { maxEffortLevel: "low" } },
    { extends: "kit", agents: { maxTurnsCeiling: 10 } }, { extends: "kit", agents: { standard: { "kit-explore": { model: "opus" } } } }]) {
    const r = loadPolicy(repo({ "claude.policy.json": { $schema: "x", ...own } }), kit);
    assert.equal(r.policy, null, JSON.stringify(own));
    assert.ok(r.problems.length);
  }
  assert.equal(loadPolicy(repo({ "claude.policy.json": "{nope" }), kit).policy, null);
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), { a: { b: 1, c: [2] } });
});

test("generator: writes the cost keys and standard agents, idempotent", () => {
  const root = repo();
  const { policy } = loadPolicy(root, kit);
  const r1 = syncClaude(root, policy);
  assert.equal(r1.changed.length, 4);
  const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert.deepEqual(s, { model: "sonnet", effortLevel: "medium", env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m" } });
  const explore = parseAgent(readFileSync(join(root, ".claude/agents/kit-explore.md"), "utf8"));
  assert.deepEqual([explore.fm.model, explore.fm.maxTurns, explore.fm.tools, explore.fm.omitClaudeMd], ["haiku", "8", "Read, Grep, Glob", "true"]);
  assert.equal(parseAgent(readFileSync(join(root, ".claude/agents/kit-review.md"), "utf8")).fm.model, "sonnet");
  assert.equal(parseAgent(readFileSync(join(root, ".claude/agents/kit-implement.md"), "utf8")).fm.tools, undefined);
  const before = readFileSync(join(root, ".claude/settings.json"), "utf8");
  const r2 = syncClaude(root, policy);
  assert.deepEqual(r2.changed, []);
  assert.equal(readFileSync(join(root, ".claude/settings.json"), "utf8"), before);
  assert.deepEqual(syncClaude(root, policy, { check: true }).changed, []);
});

test("generator: foreign settings keys, other env variables and the project's own agents are never touched", () => {
  const own = { permissions: { allow: ["Bash(npm test)"] }, hooks: { Stop: [] }, model: "opus", env: { MY_VAR: "1", CLAUDE_CODE_SUBAGENT_MODEL: "opus" }, zzz: true };
  const mine = "---\nname: mine\nmodel: haiku\nmaxTurns: 5\n---\nbody\n";
  const root = repo({ ".claude/settings.json": own, ".claude/agents/mine.md": mine });
  const { policy } = loadPolicy(root, kit);
  syncClaude(root, policy);
  const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
  assert.deepEqual(s.permissions, own.permissions);
  assert.deepEqual(s.hooks, own.hooks);
  assert.equal(s.zzz, true);
  assert.equal(s.env.MY_VAR, "1");
  assert.equal(s.model, "sonnet");
  assert.equal(s.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.deepEqual(Object.keys(s).slice(0, 4), ["permissions", "hooks", "model", "env"]);
  assert.equal(readFileSync(join(root, ".claude/agents/mine.md"), "utf8"), mine);
  assert.deepEqual(problems(root), []);
});

test("generator: an agent file of a standard name without the marker is the project's: reported, not overwritten", () => {
  const mine = "---\nname: kit-explore\nmodel: haiku\nmaxTurns: 3\n---\nmine\n";
  const root = repo({ ".claude/agents/kit-explore.md": mine });
  const { policy } = loadPolicy(root, kit);
  const r = syncClaude(root, policy);
  assert.equal(r.problems.length, 1);
  assert.equal(readFileSync(join(root, ".claude/agents/kit-explore.md"), "utf8"), mine);
});

test("generator: a standard agent dropped from the policy has its generated file removed, never a foreign one", () => {
  const root = synced({ ".claude/agents/mine.md": "---\nname: mine\nmodel: haiku\nmaxTurns: 5\n---\nx\n" });
  const slim = structuredClone(loadPolicy(root, kit).policy);
  delete slim.agents.standard["kit-review"];
  const r = syncClaude(root, slim);
  assert.deepEqual(r.changed, [".claude/agents/kit-review.md"]);
  assert.ok(!existsSync(join(root, ".claude/agents/kit-review.md")));
  assert.ok(existsSync(join(root, ".claude/agents/mine.md")));
});

test("check: a synced repository passes", () => {
  const r = checkClaude(synced(), {}, kit);
  assert.deepEqual(r.problems, []);
  assert.match(r.summary, /3 agents, 0 CLAUDE.md files \(limit 200\), 0 loop scripts/);
});

test("check fails: settings and agents drift from the policy, or are missing", () => {
  assert.ok(problems(repo()).some((p) => /settings\.json: drifts/.test(p)));
  const root = synced();
  const f = join(root, ".claude/settings.json");
  const s = JSON.parse(readFileSync(f, "utf8"));
  s.effortLevel = "high"; writeFileSync(f, JSON.stringify(s));
  assert.ok(problems(root).some((p) => /settings\.json: drifts/.test(p)));
  const root2 = synced();
  writeFileSync(join(root2, ".claude/agents/kit-explore.md"), readFileSync(join(root2, ".claude/agents/kit-explore.md"), "utf8").replace("maxTurns: 8", "maxTurns: 9"));
  assert.ok(problems(root2).some((p) => /kit-explore\.md: drifts/.test(p)));
  const root3 = synced();
  rmSync(join(root3, ".claude/agents/kit-review.md"));
  assert.ok(problems(root3).some((p) => /kit-review\.md: drifts/.test(p)));
  const root4 = synced();
  const g = JSON.parse(readFileSync(join(root4, ".claude/settings.json"), "utf8")); g.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = "20"; writeFileSync(join(root4, ".claude/settings.json"), JSON.stringify(g));
  assert.ok(problems(root4).some((p) => /settings\.json: drifts/.test(p)));
});

test("check fails: an agent without model, without maxTurns, over the ceiling, or on a disallowed model", () => {
  const agent = (fm) => `---\nname: a\ndescription: d\n${fm}---\nbody\n`;
  const root = synced({
    ".claude/agents/nomodel.md": agent("maxTurns: 5\n"),
    ".claude/agents/noturns.md": agent("model: sonnet\n"),
    ".claude/agents/big.md": agent("model: sonnet\nmaxTurns: 99\n"),
    ".claude/agents/opus.md": agent("model: opus\nmaxTurns: 5\n"),
    ".claude/agents/fine.md": agent("model: haiku\nmaxTurns: 5\n"),
    ".claude/agents/nofm.md": "no frontmatter\n",
  });
  const p = problems(root);
  assert.ok(p.some((x) => /nomodel\.md: .*no `model`/.test(x)));
  assert.ok(p.some((x) => /noturns\.md: .*no `maxTurns`/.test(x)));
  assert.ok(p.some((x) => /big\.md: maxTurns 99/.test(x)));
  assert.ok(p.some((x) => /opus\.md: model opus is not allowed/.test(x)));
  assert.ok(p.some((x) => /nofm\.md: no YAML frontmatter/.test(x)));
  assert.ok(!p.some((x) => /fine\.md/.test(x)));
});

test("check fails: CLAUDE.md over the limit (any directory), and the limit follows a project override", () => {
  const lines = (n) => `${"line\n".repeat(n)}`;
  const root = synced({ "CLAUDE.md": lines(200), "packages/a/CLAUDE.md": lines(201) });
  const p = problems(root);
  assert.equal(p.length, 1);
  assert.match(p[0], /packages\/a\/CLAUDE\.md: 201 lines, over the limit of 200/);
  const tight = repo({ "claude.policy.json": { $schema: "x", extends: "kit", claudeMd: { maxLines: 50 } }, "CLAUDE.md": lines(60) });
  const { policy } = loadPolicy(tight, kit); syncClaude(tight, policy);
  assert.ok(problems(tight).some((x) => /CLAUDE\.md: 60 lines, over the limit of 50/.test(x)));
  const ex = synced({ "docs/CLAUDE.md": lines(300) });
  assert.deepEqual(checkClaude(ex, { claude: { exclude: ["docs/**"] } }, kit).problems, []);
});

test("check fails: an agent loop with no budget, a budget over the limits, or `policy` that never reads it", () => {
  const loop = (hdr, extra = "") => `#!/bin/sh\n${hdr}\n${extra}while true; do\n  claude -p "next task" --max-turns 5\ndone\n`;
  const root = synced({
    "scripts/ralph.sh": loop(""),
    "scripts/big.sh": loop("# claude-loop-budget: iterations=500 minutes=30"),
    "scripts/long.sh": loop("# claude-loop-budget: iterations=5 minutes=600"),
    "scripts/liar.sh": loop("# claude-loop-budget: policy"),
    "scripts/junk.sh": loop("# claude-loop-budget: lots"),
    "scripts/good-policy.sh": loop("# claude-loop-budget: policy", 'eval "$(kit claude budget)"\n'),
    "scripts/good-explicit.sh": loop("# claude-loop-budget: iterations=10 minutes=30"),
    "scripts/once.sh": "#!/bin/sh\nclaude -p 'one shot'\n",
    "scripts/other.sh": "#!/bin/sh\nwhile read l; do echo $l; done\n",
    "scripts/loop.mjs": 'import { spawnSync } from "node:child_process";\nfor (let i = 0; i < 3; i++) spawnSync("claude", ["-p", "go"]);\n',
  });
  const p = problems(root);
  assert.ok(p.some((x) => /ralph\.sh: agent loop without a declared budget/.test(x)));
  assert.ok(p.some((x) => /big\.sh: iterations=500 is outside 1 to 20/.test(x)));
  assert.ok(p.some((x) => /long\.sh: minutes=600 is outside 1 to 60/.test(x)));
  assert.ok(p.some((x) => /liar\.sh: .*never runs `kit claude budget`/.test(x)));
  assert.ok(p.some((x) => /junk\.sh: unreadable budget/.test(x)));
  assert.ok(p.some((x) => /loop\.mjs: agent loop without a declared budget/.test(x)));
  for (const ok of ["good-policy", "good-explicit", "once", "other"]) assert.ok(!p.some((x) => x.includes(`${ok}.sh`)), ok);
  assert.equal(p.length, 6);
});

test("budget and managed settings come from the policy", () => {
  const { policy } = loadPolicy(repo(), kit);
  assert.deepEqual(loopBudget(policy), { KIT_LOOP_MAX_ITERATIONS: 20, KIT_LOOP_WALL_CLOCK_SECONDS: 3600 });
  assert.deepEqual(managedSettings(policy), { env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m" }, maxEffortLevel: "xhigh" });
  assert.deepEqual(Object.keys(desiredAgents(policy)), [".claude/agents/kit-explore.md", ".claude/agents/kit-review.md", ".claude/agents/kit-implement.md"]);
});

test("kit check claude and kit claude run through the CLI (and kit check canon includes claude)", async () => {
  const root = repo({ "kit.canon.json": { $schema: "x", project: "kit" } });
  const run = async (...argv) => { const out = [], err = []; const code = await main(argv, { cwd: root, out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join("\n"), err: err.join("\n") }; };
  assert.equal((await run("check", "claude")).code, 1);
  assert.equal((await run("claude", "sync", "--check")).code, 1);
  assert.equal((await run("claude", "sync")).code, 0);
  assert.equal((await run("claude", "sync", "--check")).code, 0);
  assert.equal((await run("check", "claude")).code, 0);
  assert.equal(JSON.parse((await run("claude", "budget", "--json")).out).KIT_LOOP_MAX_ITERATIONS, 20);
  assert.match((await run("claude", "budget")).out, /KIT_LOOP_WALL_CLOCK_SECONDS=3600/);
  assert.equal(JSON.parse((await run("claude", "managed")).out).maxEffortLevel, "xhigh");
  assert.equal((await run("claude", "nope")).code, 2);
  rmSync(join(root, ".claude/settings.json"));
  const canon = await run("check", "canon", "--only", "claude");
  assert.equal(canon.code, 1);
  assert.match(canon.err, /FAIL claude/);
});

test("B1: comments, echoed text and quoted strings never make a loop; `claude` must be in command position", () => {
  const sh = (body) => `#!/bin/sh\n${body}\n`;
  const root = synced({
    "scripts/comment.sh": sh('# we run claude -p in a while loop elsewhere\nwhile true; do\n  echo ok\ndone'),
    "scripts/echo.sh": sh('while read l; do\n  echo "next: claude -p $l"\n  echo claude -p again\n  printf %s "claude -p x"\ndone'),
    "scripts/grep.sh": sh('for f in a b; do\n  grep -n "claude -p" $f\ndone'),
    "scripts/doc.mjs": '// spawn("claude", ["-p"]) in a loop\n/* for (;;) spawnSync("claude", ["-p"]) */\nfor (const x of [1]) console.log("claude -p", x);\n',
    "scripts/real-sh.sh": sh('i=0\nwhile [ $i -lt 3 ]; do\n  claude -p "go" # budget?\n  i=$((i+1))\ndone'),
    "scripts/real-npx.sh": sh('for i in 1 2; do npx claude --print "x"; done'),
    "scripts/real-sub.sh": sh('for i in 1 2; do\n  out="$(claude -p next)"\ndone'),
    "scripts/real-env.sh": sh('until false; do\n  FOO=1 claude -p x\ndone'),
    "scripts/real.mjs": 'import { spawnSync } from "node:child_process";\nfor (let i = 0; i < 3; i++) spawnSync("claude", ["-p", "go"]);\n',
    "scripts/real-py.py": 'import subprocess\nwhile True:\n    subprocess.run(["claude", "-p", "go"])\n',
  });
  const p = problems(root);
  for (const quiet of ["comment.sh", "echo.sh", "grep.sh", "doc.mjs"]) assert.ok(!p.some((x) => x.includes(`scripts/${quiet}`)), `${quiet} is not an agent loop`);
  for (const loud of ["real-sh.sh", "real-npx.sh", "real-sub.sh", "real-env.sh", "real.mjs", "real-py.py"]) assert.ok(p.some((x) => x.includes(`scripts/${loud}: agent loop without a declared budget`)), `${loud} is an agent loop`);
  assert.equal(p.length, 6);
  assert.ok(codeOf('echo "a # b" # c\nx=${#y}', "a.sh").includes("${#y}"));
});

test("B2: nothing under .claude/worktrees is scanned (CLAUDE.md, loop scripts, agents)", () => {
  const long = "line\n".repeat(500);
  const root = synced({
    ".claude/worktrees/w1/CLAUDE.md": long,
    ".claude/worktrees/w1/scripts/ralph.sh": '#!/bin/sh\nwhile true; do claude -p x; done\n',
    ".claude/worktrees/w1/.claude/agents/bad.md": "---\nname: bad\n---\nno model\n",
    ".claude/worktrees/w1/.claude/agents/bad2.md": "---\nname: bad\n---\nno model\n",
  });
  assert.deepEqual(problems(root), []);
  assert.equal(checkClaude(root, {}, kit).summary.includes("3 agents, 0 CLAUDE.md files"), true);
  // the same files outside the worktrees are caught
  const out = synced({ "CLAUDE.md": long, "scripts/ralph.sh": '#!/bin/sh\nwhile true; do claude -p x; done\n' });
  assert.equal(problems(out).length, 2);
});

test("agent names carry the kit- prefix, so they never shadow a built-in agent", () => {
  assert.ok(Object.keys(defaults.agents.standard).every((n) => n.startsWith("kit-")));
  const root = synced();
  assert.deepEqual(readdirSync(join(root, ".claude/agents")).sort(), ["kit-explore.md", "kit-implement.md", "kit-review.md"]);
  assert.equal(parseAgent(readFileSync(join(root, ".claude/agents/kit-explore.md"), "utf8")).fm.name, "kit-explore");
  // an old generated explore.md (from before the rename) is removed by sync, a foreign one never
  const old = repo({ ".claude/agents/explore.md": `---\nname: explore\nmodel: haiku\nmaxTurns: 8\n---\n<!-- ${GENERATED} -->\nx\n`, ".claude/agents/review.md": "---\nname: review\nmodel: haiku\nmaxTurns: 3\n---\nmine\n" });
  syncClaude(old, loadPolicy(old, kit).policy);
  assert.ok(!existsSync(join(old, ".claude/agents/explore.md")));
  assert.ok(existsSync(join(old, ".claude/agents/review.md")));
});

test("agent effort: any level the schema allows passes, anything else fails; the schema is the one bound", () => {
  assert.deepEqual(agentEfforts(kit), ["low", "medium", "high", "xhigh", "max"]);
  const agent = (e) => `---\nname: a\ndescription: d\nmodel: sonnet\nmaxTurns: 5\neffort: ${e}\n---\nx\n`;
  const files = Object.fromEntries(["low", "medium", "high", "xhigh", "max", "turbo"].map((e) => [`.claude/agents/e-${e}.md`, agent(e)]));
  const p = problems(synced(files));
  assert.equal(p.length, 1);
  assert.match(p[0], /e-turbo\.md: effort turbo is not one of low, medium, high, xhigh, max/);
  assert.deepEqual(partial({ agents: { standard: { "kit-review": { effort: "max" } } } }), []);
});

test("sync is all or nothing: a conflict writes no settings.json and no agent", () => {
  const mine = "---\nname: kit-review\nmodel: haiku\nmaxTurns: 3\n---\nmine\n";
  const root = repo({ ".claude/agents/kit-review.md": mine });
  const r = syncClaude(root, loadPolicy(root, kit).policy);
  assert.equal(r.problems.length, 1);
  assert.ok(!existsSync(join(root, ".claude/settings.json")));
  assert.ok(!existsSync(join(root, ".claude/agents/kit-explore.md")));
  assert.equal(readFileSync(join(root, ".claude/agents/kit-review.md"), "utf8"), mine);
  const bad = repo({ ".claude/settings.json": "{nope" });
  assert.equal(syncClaude(bad, loadPolicy(bad, kit).policy).problems.length, 1);
  assert.ok(!existsSync(join(bad, ".claude/agents/kit-explore.md")));
});

test("model ownership: the policy owns `model`; sync reports what it overwrote and an override in the policy is the one source", async () => {
  const root = repo({ ".claude/settings.json": { model: "opus", effortLevel: "medium", env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" } } });
  const r = syncClaude(root, loadPolicy(root, kit).policy);
  assert.deepEqual(r.overwritten, [{ key: "model", from: "opus", to: "sonnet" }]);
  const out = [], err = [];
  const mine = repo({ ".claude/settings.json": { model: "haiku" }, "claude.policy.json": { $schema: "x", extends: "kit", model: "haiku" } });
  const r2 = syncClaude(mine, loadPolicy(mine, kit).policy);
  assert.deepEqual(r2.overwritten, [], "the project's own override is not an overwrite");
  assert.equal(JSON.parse(readFileSync(join(mine, ".claude/settings.json"), "utf8")).model, "haiku");
  const cli = repo({ ".claude/settings.json": { model: "opus" } });
  assert.equal(await main(["claude", "sync"], { cwd: cli, out: (s) => out.push(s), err: (s) => err.push(s) }), 0);
  assert.match(out.join("\n"), /model was "opus", now "sonnet": the policy owns this key \(override it in claude\.policy\.json/);
});

test("the drift message names the exact invocation: the kit itself, a vendored snapshot, or npx", () => {
  const msg = (root, canon) => checkClaude(root, canon, kit).problems.find((p) => /settings\.json/.test(p.file)).problem;
  assert.match(msg(repo(), {}), /run `npx kit claude sync` and commit/);
  assert.match(msg(repo(), { vendor: { path: "vendor/kit" } }), /run `node vendor\/kit\/packages\/cli\/bin\/kit\.js claude sync` and commit/);
  assert.match(msg(repo({ "packages/cli/bin/kit.js": "" }), {}), /run `node packages\/cli\/bin\/kit\.js claude sync`/);
  assert.equal(kitCommand(repo(), { vendor: { path: "vendor/kit/" } }), "node vendor/kit/packages/cli/bin/kit.js");
});
