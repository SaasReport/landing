// The command table (src/commands/table.js) is the one list of `kit <command> [<subcommand>]`: proven equal to what each
// dispatcher accepts, and listed in HELP, so the workflow-command-exists gate checks against the truth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMAND_TABLE, commandEntry } from "../src/commands/table.js";
import { COMMANDS, HELP, main } from "../src/index.js";
import { deriveTable, handledSubs } from "../src/commands/derive-table.js";

const src = (name) => readFileSync(new URL(`../src/commands/${name}.js`, import.meta.url), "utf8");
const read = (p) => { try { return readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
test("every command of the CLI is in the table, and nothing else", () => {
  assert.deepEqual(Object.keys(COMMAND_TABLE).sort(), Object.keys(COMMANDS).sort());
});

test("each dispatcher has a branch for exactly the subcommands the table lists (read from the code: derive-table.js)", () => {
  const derived = deriveTable(read);
  assert.deepEqual(Object.keys(derived).sort(), Object.keys(COMMAND_TABLE).sort());
  for (const cmd of Object.keys(COMMAND_TABLE)) assert.deepEqual(derived[cmd], [...new Set(commandEntry(cmd).subs)].sort(), `kit ${cmd}`);
});

test("HELP lists every command and subcommand in the table", () => {
  for (const [cmd, e] of Object.entries(COMMAND_TABLE)) {
    const { subs } = commandEntry(cmd);
    assert.match(HELP, new RegExp(`\\n  ${cmd}\\b`), `HELP lists kit ${cmd}`);
    for (const s of cmd === "check" ? [] : subs) assert.ok(new RegExp(`\\n  ${cmd} [^\\n]*\\b${s}\\b`).test(HELP), `HELP lists kit ${cmd} ${s}`);
  }
});

test("the CLI refuses a subcommand the table does not list before any dispatcher runs", async () => {
  const errs = [];
  const io = { out: () => {}, err: (x) => errs.push(x) };
  for (const cmd of Object.keys(COMMAND_TABLE).filter((c) => commandEntry(c).subs.length)) {
    errs.length = 0;
    assert.equal(await main([cmd, "no-such-sub"], io), 2, `kit ${cmd} no-such-sub`);
    assert.match(errs.join("\n"), new RegExp(`kit ${cmd}: unknown subcommand "no-such-sub" \\(one of `), `kit ${cmd}`);
  }
});

test("a dispatcher that lost the branch of a listed subcommand is caught, though its message still names it", () => {
  const lost = src("site").replace(/\n\s*if \(sub === "visual-qa"\)[^\n]*/, "");
  assert.match(lost, /visual-qa/, "the unknown-command message still lists it");
  assert.ok(!handledSubs(lost, "site").includes("visual-qa"));
  assert.notDeepEqual(handledSubs(lost, "site"), [...commandEntry("site").subs].sort());
});
