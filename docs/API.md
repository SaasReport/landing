# The SaasReport public API

`https://api.saasreport.ai`, contract `contracts/api.openapi.json` (OpenAPI 3.1, JSON Schema 2020-12), rendered at `/developers/api/` on the landing.
Read-only, no key, open to browsers (CORS `*`), cacheable. Nothing is stored. Every error is one `application/problem+json` shape.

| Operation | What it answers |
| --- | --- |
| `GET /v1/health` | `ok` when the Worker runs |
| `GET /v1/build` | the commit the production workflow deployed (the release verifier reads `/api/build`) |
| `GET /v1/registries`, `GET /v1/registries/{name}` | the core registries: stakeholders, metrics, report-types, cadences, findings, commitments, roles, currencies |
| `GET /v1/sample/stakeholders/{id}`, `/v1/sample/findings`, `/v1/sample/report?type=&stakeholder=` | the core engine on the core SAMPLE dataset; every answer carries `"sample": true` and the sample label |
| `POST /v1/guard` | the number guard: `{text, facts[]}` to `{ok, decision, unsupported[]}` |

Limits, declared in the contract's `x-limits` and enforced by the Worker: 60 requests per 60 seconds per client address (Cloudflare rate limiting binding
`RATE_LIMITER`; a test holds `wrangler.toml` equal to the contract; without the binding the API answers 503), and 8192 bytes of request body (413; the body is
read as a stream and never past the cap).

## Use it

```js
import { createClient } from "./sdk/saasreport/index.mjs"; // generated: kit sdk generate
const api = createClient();
const report = await api.sample.getSampleReport({ type: "revenue-health", stakeholder: "ceo_founder" });
```

## What is live on the landing, and what is not

The Developers section and the reference page link to the live API. The widgets still show figures computed when the page is built, labelled `Engine on
sample data`: the kit's widget runtime has no live `openapi` source (the `playground` archetype only simulates a send), so a widget cannot call the API at view
time without hand-written JavaScript, which the constitution forbids. The proposed kit change is in the pull request.

## Owner-pending (never invented here)

The `production` GitHub environment and its secrets, the `api` DNS hostname and zone, the Telegram route secrets of the watcher, the `API_HEALTH_URL` variable, the
rate limiter namespace in the account, the first production run (`release.json` state `bootstrap`) and its drills.
