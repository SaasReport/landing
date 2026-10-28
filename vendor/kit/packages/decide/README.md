# @saasreport/decide

Typed decisions on a small local model, so the big model reads only what needs it. One API:
`decide({ state, questions: [{ id, options, … }] }) → { [id]: { choice, probs, … } }`, where `choice` is `"escalate"`
below the confidence threshold or when the backend fails. Backends speak the System One API (local Kev on CPU, Kev-4B/9B
on a GPU, Bev self-hosted, Jev hosted); `fake` for CI. No dependencies.

- Contract: `contracts/decision.schema.json` (kit.decision.v1); config: `decide.config.json` (kit.decide-config.v1)
- Gates: `gates/*.json` (kit.decide-gate.v1); eval sets: `eval/*.json` (kit.decide-eval.v1)
- CLI: `kit decide`, `kit decide eval`

Design, tiers, the notification-triage gate and its measured results: [docs/DECIDE.md](../../docs/DECIDE.md).
