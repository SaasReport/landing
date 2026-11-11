# @saasreport/broker

The agent credential broker for Workers: agents hold no GitHub credential. A signed, fresh, single-use request from a
registered agent (kit agent id, its own Ed25519 key) gets an installation token scoped to one repository and one action's
permissions; a merge happens only through the broker, after green checks on the exact head and a signed review by a
different agent. Every authenticated allow and deny is a hash-chained Evidence record in D1.

Design, flow diagram, config and the owner's deploy steps: [docs/BROKER.md](../../docs/BROKER.md).

```js
// worker.js of a project's broker (bindings: BROKER_CONFIG, APP_PRIVATE_KEY secret, DB)
export { default } from "@saasreport/broker/worker";

// an agent
import { signRequest } from "@saasreport/broker";
const body = await signRequest({ aud: "saasreport", agent: "kit:agent:saasreport:coder", action: "push", repo: "app" }, agentKey);
```

Contracts: `contracts/openapi.json`, `kit.broker-config.v1`, `kit.broker-request.v1`, `kit.broker-evidence.v1`.
Generated client: `sdk/kit-broker`. Migration: `migrations/0001_broker.sql`.
