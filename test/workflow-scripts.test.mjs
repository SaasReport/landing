// Every script a workflow runs with `node <file>` exists in this repository. The daily staleness run called
// `node scripts/kit.mjs`, a file this repository never had (it vendors the kit under vendor/kit), and failed with
// "Cannot find module" on every tick for weeks; the kit's workflow-command-exists finding checks the kit COMMAND, not the file.
// This test reads every run step of .github/workflows/*.yml and fails on any `node` script path that is not a file here
// (a path under a checkout step's `path:` is resolved against this repository, since that checkout is this repository).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = new URL("..", import.meta.url).pathname;
const WORKFLOWS = join(ROOT, ".github/workflows");

/** The script paths a shell snippet runs with node: `node [flags] <file.js|.mjs|.cjs> ...`, comments and expressions ignored. */
export function nodeScripts(run) {
  const out = [];
  for (const raw of String(run).split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    for (const m of line.matchAll(/(?:^|[\s;&|(])node((?:\s+-[-\w=]+)*)\s+([^\s"'`;&|()$]+\.(?:mjs|cjs|js))(?=[\s;&|)]|$)/g)) {
      if (/(^|\s)-(e|p|-eval|-print)\b/.test(m[1])) continue;   // inline code, not a file
      out.push(m[2]);
    }
  }
  return out;
}

/** Every { file, job, path } a workflow document runs with node, with checkout `path:` prefixes resolved to this repository. */
export function workflowScripts(doc, file) {
  const found = [];
  for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
    const steps = def?.steps ?? [];
    const checkoutDirs = steps
      .filter((s) => typeof s?.uses === "string" && s.uses.startsWith("actions/checkout@") && s.with?.path)
      .map((s) => String(s.with.path).replace(/\/+$/, ""));
    for (const step of steps) {
      if (typeof step?.run !== "string") continue;
      const dir = step["working-directory"] ?? def?.defaults?.run?.["working-directory"] ?? "";
      for (const p of nodeScripts(step.run)) {
        let rel = join(dir, p).replace(/^\.\//, "");
        const under = checkoutDirs.find((d) => rel.startsWith(`${d}/`));
        if (under) rel = rel.slice(under.length + 1);
        found.push({ file, job, path: rel });
      }
    }
  }
  return found;
}

test("every `node <script>` in .github/workflows names a file this repository has", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, "no workflows read");
  const all = files.flatMap((f) => workflowScripts(parse(readFileSync(join(WORKFLOWS, f), "utf8")), f));
  assert.ok(all.length > 0, "no node script found in any workflow: the reader is broken");
  const missing = all.filter(({ path }) => !(existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isFile()));
  assert.deepEqual(missing, [], `workflows run scripts that do not exist:\n${missing.map((m) => `  ${m.file} (${m.job}): node ${m.path}`).join("\n")}`);
});

test("must fail: the class that broke staleness.yml is caught", () => {
  const doc = parse(`
jobs:
  staleness:
    steps:
      - uses: actions/checkout@v6
      - run: node scripts/kit.mjs check staleness --json > report.json
`);
  const found = workflowScripts(doc, "staleness.yml");
  assert.deepEqual(found.map((f) => f.path), ["scripts/kit.mjs"]);
  assert.equal(existsSync(join(ROOT, "scripts/kit.mjs")), false);
});

test("must pass: flags, checkout paths, comments and inline code are read correctly", () => {
  const doc = parse(`
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
        with: { path: base }
      - run: |
          # node scripts/not-a-command.mjs in a comment
          node -p 'require("./verdict.json").held'
          node --test test/forms-endpoint.test.mjs
          if [ -f x ]; then node base/vendor/kit/packages/cli/bin/kit.js agent-guard audit; fi
`);
  assert.deepEqual(workflowScripts(doc, "t.yml").map((f) => f.path), ["test/forms-endpoint.test.mjs", "vendor/kit/packages/cli/bin/kit.js"]);
});
