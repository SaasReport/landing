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

Credentials: the production workflow reads the GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` of the `production` environment (the kit
template's names). The owner's decision is to use the existing repository secrets `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ZONE_ID`, the names
of the kit-head workflow in SaasReport/toolkit. Their state is **pending-verified-on-first-run**: nobody has listed them. The mapping, a first step that checks
the three by boolean only, and a gate that keeps push runs from failing and mailing until the first dispatch passes all need a change to the kit's production
template, which `kit check release` holds byte for byte; the proposed change is in the pull request. Until then, disable the `production` workflow in the
Actions settings, or dispatch it by hand once the secrets are in place.

DNS: the proxied record for `api.saasreport.ai` already exists; the Worker takes the route `api.saasreport.ai/*` on the zone `saasreport.ai`.

Still pending: the `API_HEALTH_URL` variable and the Telegram route secrets of the watcher, the rate limit namespace in the account (id kept as is), the first
production run (`release.json` state `bootstrap`) and its drills.
