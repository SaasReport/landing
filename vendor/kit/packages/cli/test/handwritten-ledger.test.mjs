// wo-0016 (owner, 2026-10-07): hand-written checks are not permitted. Every module of the canon checks is declared in the
// ledger as the engine or as a hand-written check frozen on 2026-10-07 with the work order that migrates it; anything else
// fails here, so no hand-written check can be added, and the ledger only shrinks.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { bundled } from "../src/bundled.js";

const ROOT = new URL("../../../", import.meta.url);
const ledger = JSON.parse(readFileSync(new URL("packages/core/registry/handwritten-ledger.json", ROOT), "utf8"));

/** Problems of a ledger against the modules on disk: undeclared modules, entries for missing files, late or orphan freezes. */
export function ledgerProblems(led, onDisk, workOrders) {
  const out = [];
  const declared = new Map(led.modules.map((m) => [m.path, m]));
  for (const f of onDisk) if (!declared.has(f)) out.push(`${f}: a canon module the ledger does not declare (a new hand-written check is not permitted: declare its rule as a contract in the finding-class registry)`);
  for (const m of led.modules) {
    if (!onDisk.includes(m.path)) out.push(`${m.path}: declared in the ledger but not on disk (remove the entry)`);
    if (m.role !== "handwritten") continue;
    if (m.frozen > led.frozen_on) out.push(`${m.path}: a hand-written check frozen ${m.frozen}, after ${led.frozen_on}: the ledger only shrinks`);
    if (!workOrders.includes(m.work_order)) out.push(`${m.path}: work order ${m.work_order} does not exist in work-orders/`);
  }
  return out;
}

const modulesIn = (scope) => scope.flatMap((dir) => readdirSync(new URL(dir, ROOT)).filter((f) => f.endsWith(".js")).map((f) => `${dir}${f}`)).sort();
const workOrders = () => readdirSync(new URL("work-orders/", ROOT)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(new URL(`work-orders/${f}`, ROOT), "utf8")).id);

test("the ledger is valid, declares every canon module, and freezes no hand-written check after 2026-10-07", () => {
  const kit = bundled();
  assert.deepEqual(kit.validator.validate(ledger, kit.byName("handwritten-ledger")), [], "the ledger against kit.handwritten-ledger.v1");
  assert.deepEqual(ledgerProblems(ledger, modulesIn(ledger.scope), workOrders()), []);
});

test("a new hand-written module, a late freeze, a missing file and an unknown work order each fail (must-fail)", () => {
  const onDisk = modulesIn(ledger.scope);
  const wos = workOrders();
  assert.ok(ledgerProblems(ledger, [...onDisk, "packages/cli/src/canon/hygiene.js"], wos).some((p) => p.startsWith("packages/cli/src/canon/hygiene.js: a canon module the ledger does not declare")), "kit #112's hygiene.js");
  const late = structuredClone(ledger);
  late.modules.push({ path: "packages/cli/src/canon/new.js", role: "handwritten", why: "added after the freeze", parses: "x", migrate_to: "y", work_order: "wo-0016-every-check-a-contract", frozen: "2026-10-08" });
  assert.ok(ledgerProblems(late, [...onDisk, "packages/cli/src/canon/new.js"], wos).some((p) => /after 2026-10-07: the ledger only shrinks/.test(p)));
  assert.ok(ledgerProblems(ledger, onDisk.filter((f) => !f.endsWith("lockfile.js")), wos).some((p) => /declared in the ledger but not on disk/.test(p)));
  assert.ok(ledgerProblems(ledger, onDisk, []).some((p) => /does not exist in work-orders/.test(p)));
});
