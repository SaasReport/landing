/**
 * @saasreport/sdk — contract-first SDKs through @saasreport/forge, the kit's native Forge (docs/SDK.md).
 *   generateTarget(root, target) → { files, manifest, operations, problems }   in memory
 *   writeTarget(root, target, files)                                           to target.out
 *   checkSdk(root, { canon, registry, validate })                              kit check sdk
 */
export { adapt, generateTarget, writeTarget, loadContract, FORGE, MANIFEST_FILE, MARK } from "./generate.js";
export { checkSdk, loadSdkConfig, declaredContracts, fetchCalls, ownNames, ownedBy, CONFIG_FILE } from "./check.js";
