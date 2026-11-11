# The landing's forms

The early-access form is declared once in `src/forms.js`. The modal, the endpoint's validation, the contract and the
generated client all come from that declaration through `scripts/generate.mjs`.

![How an early-access request is received, in the forms document (saasreport.landing.forms.doc)](diagrams/landing-forms.png)

<details><summary>Mermaid source (saasreport.landing.forms.doc)</summary>

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontFamily":"Inter, Arial, sans-serif","fontSize":"15px","textColor":"#0B0B0B","stateLabelColor":"#0B0B0B","transitionLabelColor":"#0B0B0B","background":"#F7F9FC","primaryColor":"#FFFFFF","primaryTextColor":"#0B0B0B","primaryBorderColor":"#0B0B0B","lineColor":"#4D5B70","secondaryColor":"#EDF1F6","tertiaryColor":"#F7F9FC","clusterBkg":"#EDF1F6","clusterBorder":"#B9C6D8","edgeLabelBackground":"#F7F9FC","titleColor":"#0B0B0B","actorBkg":"#0B0B0B","actorBorder":"#0B0B0B","actorTextColor":"#FFFFFF","actorLineColor":"#B9C6D8","signalColor":"#0B0B0B","signalTextColor":"#0B0B0B","labelBoxBkgColor":"#F7F9FC","labelBoxBorderColor":"#B9C6D8","noteBkgColor":"#EEF3F9","noteBorderColor":"#6F9BD8","sequenceNumberColor":"#FFFFFF","stateBkg":"#FFFFFF","stateBorder":"#0B0B0B","transitionColor":"#4D5B70","specialStateColor":"#12396B"}}}%%
%% kit:diagram {"id":"saasreport.landing.forms.doc","title":"How an early-access request is received, in the forms document","project":"saasreport","kind":"flow","summary":"The short form of the request flow for the forms document.","lineage":{"derives_from":["saasreport.landing.forms"],"supersedes":[],"version":"1"},"relates_to":[],"depicts":[{"kind":"file","ref":"the form endpoint","path":"src/form-intake.js"}],"reviewed":"2026-11-11"}
flowchart TB
  decl("Declared form src/forms.js")
  gen("Content generator scripts/generate.mjs")
  visitor("Visitor sends the early-access modal")
  script("Page script public/forms.js")
  fn("Pages Function POST /api/forms/id")
  check{"Declared form, same site, size and answers valid?"}
  refuse("Refused: 4xx with the field and its code, nothing stored")
  store[("D1 table landing_form_requests, production only")]
  done("Confirmation in the modal with the reference")
  later("Later: comms engine sends the receipt and the owner copy")
  decl --> gen
  gen --> script
  gen --> fn
  visitor --> script
  script --> fn
  fn --> check
  check -->|no| refuse
  check -->|yes| store
  store --> done
  store -.-> later
  class fn,store accent
  classDef accent fill:#12396B,stroke:#12396B,color:#FFFFFF,stroke-width:2px
```

</details>

## What happens to a request

1. The visitor sends the modal. `public/forms.js` posts the answers as JSON to `POST /api/forms/early-access` and never
   puts them in the address.
2. The Pages Function (`functions/api/forms/[id].js`, logic in `src/form-intake.js`) refuses an undeclared form, a
   request from another site, a body over 16 KiB, a body that is not JSON or a form post, and any answer the declaration
   does not allow. A refusal names the field and its code and stores nothing.
3. A valid request is stored as one row in the D1 table `landing_form_requests` and answered with its reference
   (`SR-<date>-<8 hex>`), which the modal shows.

The contract is `contracts/forms.openapi.json`. `test/forms-endpoint.test.mjs` answers every status it documents and
no other; `test/forms-browser.test.mjs` sends the real modal at 390x844 and 1280x800.

## This is an interim store

No email is sent. The comms engine is not deployed yet, so there is no confirmation email and no owner copy: the page
says "We write back by email", and the owner reads the requests from the database. When the comms engine and the site
Worker are deployed, this endpoint is replaced by the kit's declared-form intake, which keeps the same path and
contract, and the stored rows are moved to it.

## Where requests are stored

| | |
| --- | --- |
| Database | `saasreport-comms-engine-production` (D1), bound as `FORMS_DB` in `wrangler.toml` |
| Table | `landing_form_requests`, created by the endpoint on its first valid request |
| Columns | `id`, `reference`, `form_id`, `created_at`, `email`, `fields` (the answers as JSON), `consent` |
| Production only | a preview deployment has no database: a form sent from a preview answers 503 and stores nothing |

Reading the requests (owner, Cloudflare dashboard, D1 console):

```sql
SELECT reference, created_at, email, fields FROM landing_form_requests ORDER BY created_at DESC;
```

Deleting one person's request on their ask: `DELETE FROM landing_form_requests WHERE email = ?;`

## Limits and what is not covered

- At most 120 stored requests an hour; more are answered 429 and not stored.
- There is no per-visitor rate limit and no spam filter beyond the declaration's rules.
- Nobody is told when a request arrives. Until the comms engine is live the owner has to look.
- The Pages deployment has no monitor: `kit check canon` reports resilience and release as not configured, which is
  true and stays open until the alert routes exist.
