import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tempDir } from "../../core/test/support/temp.mjs";
import { validate } from "../../core/src/schema.js";
import { capabilityContractProblems } from "../src/canon/capabilities.js";
import { checkContracts, applicability } from "../src/canon/index.js";
import { bundled } from "../src/bundled.js";

const schema = JSON.parse(readFileSync(new URL("../../core/schemas/capability-manifest.schema.json", import.meta.url)));
const doc = () => ({
  $schema: schema.$id, version: 1, capabilities: [{
    id: "sandbox.transfer", kind: "service",
    as_code: { definition: "contracts/capabilities.json", schema: "contracts/openapi.json" },
    as_service: { binding: "web", environment: "sandbox" },
    api: { contract: "contracts/openapi.json", path: "/api/sandbox/v1/transfer", method: "post", operationId: "sandboxTransfer" },
    sdk: { generator: "forge", module: "sdk/client/index.mjs", operationId: "sandboxTransfer" },
    widget: { module: "site/widgets/transfer.mjs", operationId: "sandboxTransfer", usesGeneratedSdk: true },
    failures: { negativeTests: ["test/transfer-failure.test.mjs"], recovery: "idempotent-retry" },
    promotion: { sandboxFirst: true, contractHash: true, smokeProof: true, independentReview: true, productionGate: true },
    federation: "cross-tenant-policy-gated",
  }],
});
const temp = (t) => {
  const root = tempDir(t, "kit-capability-check-");
  const write = (p, s) => { mkdirSync(dirname(join(root,p)), {recursive:true}); writeFileSync(join(root,p),s); };
  write("contracts/capabilities.json", JSON.stringify(doc()));
  write("contracts/openapi.json", JSON.stringify({ paths: { "/api/sandbox/v1/transfer": {
    post: { operationId: "sandboxTransfer" } } } }));
  write("sdk/client/index.mjs", "export const sandboxTransfer = () => {}");
  write("site/widgets/transfer.mjs", 'import { sandboxTransfer } from "/sdk/client/index.mjs";');
  write("test/transfer-failure.test.mjs", "export const failureProof = true;");
  return { root, write };
};
test("canonical schema accepts an X-as-Code/X-as-Service API SDK Widget failure-first capability", () => {
  assert.deepEqual(validate(doc(), schema), []);
});
test("bad manifests fail before any contract path or artifact is inspected", () => {
  for (const bad of [
    (x) => { delete x.capabilities[0].widget; },
    (x) => { x.capabilities[0].promotion.smokeProof = false; },
    (x) => { x.capabilities[0].failures.negativeTests = []; },
    (x) => { x.capabilities[0].kind = "media"; },
  ]) { const x = doc(); bad(x); assert.ok(validate(x, schema).length, JSON.stringify(x)); }
});
test("contract check enforces all three surfaces, real paths, and negative evidence", (t) => {
  const { root, write } = temp(t);
  const kit = bundled();
  assert.deepEqual(capabilityContractProblems(root, kit), []);
  const wrong = doc(); wrong.capabilities[0].sdk.operationId = "independentHandwrittenOperation";
  write("contracts/capabilities.json", JSON.stringify(wrong));
  assert.match(JSON.stringify(capabilityContractProblems(root, kit)), /SAME operationId/);
  wrong.capabilities[0].sdk.operationId = "sandboxTransfer";
  wrong.capabilities[0].failures.negativeTests = ["test/absent.test.mjs"];
  write("contracts/capabilities.json", JSON.stringify(wrong));
  assert.match(JSON.stringify(capabilityContractProblems(root, kit)), /missing declared artifact/);
});
test("media capability requires real RSS and byte-range smoke claims in schema", () => {
  const x = doc();
  x.capabilities[0].kind = "media";
  assert.ok(validate(x, schema).length);
  x.capabilities[0].media = { feed: "/podcasts/feed.xml", rangeRequests: true, byteSmoke: true };
  assert.deepEqual(validate(x, schema), []);
});

test("capability-only repos are configured and errors survive the applicability gate", (t) => {
  const { root, write } = temp(t), kit = bundled();
  const c = { contracts: [] };
  const passing = checkContracts(root, c, kit);
  assert.equal(passing.configured, true);
  assert.equal(passing.checked, 1);
  const bad = doc();
  bad.capabilities[0].sdk.operationId = "differentOperation";
  write("contracts/capabilities.json", JSON.stringify(bad));
  const out = applicability("contracts", checkContracts(root, c, kit), c, { routes:false, openapi:false });
  assert.equal(out.ok, false);
  assert.notEqual(out.notApplicable, true);
  assert.match(JSON.stringify(out.problems), /SAME operationId/);
});
test("empty/stale SDK fails even when the manifest names the right operation", (t) => {
  const { root, write } = temp(t), kit = bundled();
  write("sdk/client/index.mjs", "");
  assert.match(JSON.stringify(capabilityContractProblems(root, kit)), /generated SDK artifact does not expose/);
});
test("Forge method overrides are respected in widgets rather than searching for operationId", (t) => {
  const { root, write } = temp(t), kit = bundled();
  write("contracts/openapi.json", JSON.stringify({ paths: {
    "/api/sandbox/v1/transfer": { post: { operationId: "sandboxTransfer", "x-fern-sdk-method-name": "transfer" } }
  } }));
  write("site/widgets/transfer.mjs", 'import { createClient } from "/sdk/client/index.mjs";\nconst client = createClient(); client.sandbox.transfer();');
  assert.deepEqual(capabilityContractProblems(root, kit), []);
  write("site/widgets/transfer.mjs", 'import { createClient } from "/sdk/client/index.mjs";\nfetch("/api/sandbox/v1/transfer")');
  assert.match(JSON.stringify(capabilityContractProblems(root, kit)), /parallel fetch client|invoke generated SDK method/);
});
