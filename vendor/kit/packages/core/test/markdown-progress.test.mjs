// The Markdown renderer always makes progress (review finding): a line that starts with "|" but is not a table row used to
// match no branch and consume nothing, so renderMarkdown("|not a table") never returned. Run under a timeout in a child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./fixtures/render-markdown-once.mjs", import.meta.url));
const run = (inputs, timeout, mode = "") => spawnSync(process.execPath, [CHILD, JSON.stringify(inputs), mode], { encoding: "utf8", timeout });
const htmlOf = (md) => { const r = run([md], 5000, "html"); assert.equal(r.status, 0, `rendering ${JSON.stringify(md)} must terminate (signal: ${r.signal})`); return JSON.parse(r.stdout).html[0]; };

test("a pipe line that is not a table row is a paragraph, and rendering terminates", () => {
  const r = run(["|not a table", "text\n|also not\nmore", "|", "| a |\n|---|\n| b |", "a|b"], 5000);
  assert.equal(r.status, 0, `the renderer must terminate (signal: ${r.signal})`);
  assert.deepEqual(JSON.parse(r.stdout), { done: 5, of: 5 });
});

test("the paragraph keeps its text", () => {
  assert.match(htmlOf("|not a table"), /<p>\|not a table<\/p>/);
  assert.match(htmlOf("intro\n|half row\nnext"), /\|half row/);
});

test("every well-formed table is still a table", () => {
  assert.match(htmlOf("| a | b |\n|---|---|\n| 1 | 2 |"), /<table>/);
});

test("termination holds for any mix of block-starting characters (generated, 4000 documents)", () => {
  let seed = 11;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const alphabet = ["|", ">", "-", "*", "#", " ", "a", "1", ".", "`", "۱", "\t"];
  const docs = Array.from({ length: 4000 }, () => Array.from({ length: 1 + rnd(5) }, () => Array.from({ length: rnd(7) }, () => alphabet[rnd(alphabet.length)]).join("")).join("\n"));
  const r = run(docs, 30000);
  assert.equal(r.status, 0, `some document made the renderer loop (signal: ${r.signal})`);
  assert.deepEqual(JSON.parse(r.stdout), { done: 4000, of: 4000 });
});
