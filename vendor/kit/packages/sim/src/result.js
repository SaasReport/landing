/**
 * SimResult: the run plus a provenance block for workbench panes. Field names align with the workbench SourceEnvelope
 * (kit.source-envelope.v1: source.kind, asOf, licence, provenance.adapter / adapterVersion / asOfBasis / seed / rawHash) but
 * nothing here depends on it. The badge is derived from the kind, never stored:
 *   sandbox-mock -> SYNTHETIC    customer-dataset -> YOURS    computed -> COMPUTED
 */
import { SimError } from "./errors.js";
import { ENGINE_VERSION } from "./run.js";
import { hashOf } from "./util.js";
import { validateScenario, validateResult } from "./schemas.js";
import PKG from "../package.json" with { type: "json" };

export const BADGES = Object.freeze({ "sandbox-mock": "SYNTHETIC", "customer-dataset": "YOURS", computed: "COMPUTED" });
export const badgeFor = (kind) => {
  const b = BADGES[kind];
  if (!b) throw new SimError("bad-kind", "kind is sandbox-mock, customer-dataset or computed", "source/kind");
  return b;
};

const LICENCE = { line: "Output computed by an open engine from the inputs given; the inputs keep their own terms.", redistribution: "not-applicable" };

/** The result of a validated run of this scenario. Refuses a scenario off its schema, a refused run and a run of another scenario. */
export function toSimResult(scenario, run) {
  const sp = validateScenario(scenario);
  if (sp.length) throw new SimError("invalid-scenario", `the scenario is off kit.sim-scenario.v1: ${sp.join("; ")}`, "scenario");
  if (run?.validation?.status !== "validated") throw new SimError("run-refused", "a refused run has no result: its reasons are in the run", "run");
  if (run.scenarioId !== scenario.id || run.inputsHash !== hashOf(scenario)) throw new SimError("run-mismatch", "the run does not match this scenario (id or inputs hash)", "run");
  const generated = scenario.engine === "irrbb" && !scenario.inputs?.ladder;
  const kind = scenario.source.kind;
  const source = { id: scenario.source.id ?? `sim.${scenario.engine}`, kind };
  if (scenario.source.name) source.name = scenario.source.name;
  if (kind === "sandbox-mock") source.origin = generated ? "generated" : "computed";
  const result = {
    schema: "kit.sim-result.v1",
    run,
    source,
    asOf: run.asOf,
    licence: LICENCE,
    provenance: { adapter: PKG.name, adapterVersion: ENGINE_VERSION, asOfBasis: kind === "sandbox-mock" ? "seed" : "source", seed: run.seed, rawHash: run.inputsHash },
    data: run.outputs,
  };
  const rp = validateResult(result);
  if (rp.length) throw new SimError("output-contract", `the result does not match kit.sim-result.v1: ${rp.join("; ")}`, "result");
  return result;
}

/** Map to a workbench SourceEnvelope (kit.source-envelope.v1, kit PR "workbench archetype"); the caller supplies fetchedAt (no clock here). */
export function toSourceEnvelope(result, { fetchedAt, lang = "en" }) {
  if (typeof fetchedAt !== "string" || Number.isNaN(Date.parse(fetchedAt))) throw new SimError("bad-fetched-at", "fetchedAt is an ISO date-time supplied by the caller", "fetchedAt");
  const { source } = result;
  const kind = source.kind === "customer-dataset" ? "customer-dataset" : "sandbox-mock";
  const origin = source.kind === "customer-dataset" ? undefined : source.kind === "computed" ? "computed" : source.origin ?? "computed";
  return {
    schema: "kit.source-envelope.v1",
    source: { id: source.id, name: { [lang]: source.name ?? source.id }, kind, ...(origin ? { origin } : {}) },
    asOf: result.asOf,
    fetchedAt,
    licence: result.licence,
    freshness: { slaSeconds: 0, status: "mock" },
    reach: { fromBrowser: "not-applicable", testedOn: fetchedAt.slice(0, 10) },
    provenance: { ...result.provenance },
    data: result.data,
  };
}
