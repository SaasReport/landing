# @saasreport/sim

Pure, seeded, replayable simulation engines. Engines and archetypes only: no project content, scenarios or demo data.
Full description, diagram and validation table: [docs/SIM.md](../../docs/SIM.md).

```js
import { runScenario, toSimResult } from "@saasreport/sim";
const run = runScenario(scenario);          // kit.sim-scenario.v1 -> kit.sim-run.v1 (validated, or refused with reasons)
const result = toSimResult(scenario, run);  // kit.sim-result.v1 with the SYNTHETIC / YOURS / COMPUTED provenance
```

Rules: no I/O, no clock, no `Math.random` (a seeded sfc32 is passed explicitly); money is integer minor units in BigInt;
every input is checked against a validated range and **refused** (never a wrong number); every run lists its assumptions.
CLI: `kit sim run <scenario.json> [--json]`.
