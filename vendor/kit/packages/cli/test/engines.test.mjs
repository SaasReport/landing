// One Node floor for the whole kit (Codex review of #122): every package declares the root's engines.node, and that floor
// carries the Node APIs the kit imports (node:path matchesGlob arrived in Node 20.17.0), so no package installs on a Node
// where `kit` cannot start.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);
const read = (u) => JSON.parse(readFileSync(u, "utf8"));
const API_FLOOR = { "node:path matchesGlob": "20.17.0" };
const floorOf = (range) => (/^>=(\d+\.\d+\.\d+)$/.exec(range) || [])[1];
const atLeast = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return true; };

test("every package declares the root's Node floor, and the floor carries the APIs the kit imports", () => {
  const root = read(new URL("package.json", ROOT)).engines.node;
  const floor = floorOf(root);
  assert.ok(floor, `the root engines.node must be a >=x.y.z floor (got ${root})`);
  for (const [api, min] of Object.entries(API_FLOOR)) assert.ok(atLeast(floor, min), `${api} needs Node ${min}; the floor is ${floor}`);
  for (const d of readdirSync(new URL("packages/", ROOT))) {
    const u = new URL(`packages/${d}/package.json`, ROOT);
    if (!existsSync(u)) continue;
    const e = read(u).engines?.node;
    if (e !== undefined) assert.equal(e, root, `packages/${d} declares engines.node ${e}, the root ${root}`);
  }
});
