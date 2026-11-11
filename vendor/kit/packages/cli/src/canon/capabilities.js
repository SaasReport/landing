/**
 * Canonical Capability-as-Code/Service gate. Optional until a project adopts
 * contracts/capabilities.json; once present, no waiver and no silent skipping.
 * The SAME OpenAPI operation must be used by API, generated Forge SDK, Widget.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pathInside = (root, path) => typeof path === "string" && !path.includes("..")
  && !path.startsWith("/") && existsSync(join(root, path));
const P = (file, problem) => ({ file, problem });

export function capabilityContractProblems(root, kit) {
  const path = "contracts/capabilities.json";
  if (!existsSync(join(root, path))) return [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, path), "utf8")); }
  catch { return [P(path, "capabilities manifest is not parseable JSON")]; }
  const problems = kit.validator.validate(manifest, kit.byName("capability-manifest"))
    .map((p) => P(path, "capability-manifest: " + p.path + " " + p.message));
  if (problems.length) return problems; // do not dereference untrusted fields until validated
  const ids = new Set(), specs = new Map();
  for (const cap of manifest.capabilities) {
    if (ids.has(cap.id)) problems.push(P(path, "duplicate capability ID " + cap.id));
    ids.add(cap.id);
    for (const f of [cap.as_code.definition, cap.as_code.schema, cap.sdk.module,
      cap.widget.module, ...cap.failures.negativeTests]) {
      if (!pathInside(root, f)) problems.push(P(path, cap.id + ": missing declared artifact " + f));
    }
    let spec = specs.get(cap.api.contract);
    if (!spec) {
      if (!pathInside(root, cap.api.contract)) {
        problems.push(P(path, cap.id + ": missing OpenAPI contract " + cap.api.contract));
        continue;
      }
      try { spec = JSON.parse(readFileSync(join(root, cap.api.contract), "utf8")); }
      catch { problems.push(P(path, cap.id + ": OpenAPI contract is not JSON")); continue; }
      specs.set(cap.api.contract, spec);
    }
    const endpoint = spec.paths?.[cap.api.path]?.[cap.api.method];
    if (endpoint?.operationId !== cap.api.operationId) problems.push(P(path,
      cap.id + ": API operationId/path/method do not match canonical OpenAPI"));
    if (cap.sdk.operationId !== cap.api.operationId || cap.widget.operationId !== cap.api.operationId)
      problems.push(P(path, cap.id + ": API, SDK and Widget must name the SAME operationId"));
    // Forge maps OpenAPI operation IDs to callable method names. Repeating an
    // operation ID in the manifest alone is not a parity proof: the actual
    // generated SDK must contain that operation, and the widget must invoke
    // its mapped method rather than inventing a parallel HTTP client.
    const methodName = typeof endpoint?.["x-fern-sdk-method-name"] === "string" &&
      endpoint["x-fern-sdk-method-name"] ? endpoint["x-fern-sdk-method-name"] :
      cap.api.operationId.split(/[-_]+/).pop();
    if (pathInside(root, cap.sdk.module)) {
      const client = readFileSync(join(root, cap.sdk.module), "utf8");
      if (!client.includes(cap.api.operationId)) problems.push(P(path,
        cap.id + ": generated SDK artifact does not expose the OpenAPI operation " + cap.api.operationId));
    }
    if (pathInside(root, cap.widget.module)) {
      const js = readFileSync(join(root, cap.widget.module), "utf8");
      const validMethod = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(methodName);
      if (!validMethod || !new RegExp("\\b" + methodName + "\\b").test(js)) problems.push(P(path,
        cap.id + ": Widget must invoke generated SDK method " + methodName));
      if (!js.includes("/sdk/")) problems.push(P(path,
        cap.id + ": Widget must import the generated browser SDK, never a parallel fetch implementation"));
      if (/\bfetch\s*\(/.test(js)) problems.push(P(path,
        cap.id + ": Widget must not implement a parallel fetch client"));
    }
    if (cap.kind === "media" && (!cap.media?.rangeRequests || !cap.media?.byteSmoke))
      problems.push(P(path, cap.id + ": media requires byte-range and media-byte smoke"));
  }
  return problems;
}
