# Portable Media Kernel (Kit core)

**Implementation status: pure contract and delivery-evidence gate, not deployed.**
This lives in the reusable Apache-2.0 Kit, not the SaasReport app. Each project imports `@saasreport/core/media` and declares its own namespace, editorial sources, host names, themes and provider adapters.

```js
import { planMediaBundle, assessMediaBundle } from "@saasreport/core/media";
const plan = planMediaBundle({
  project: "your-project", tenant: "site-01", content_id: "concept-001", edition: "v1",
  title: "What is a term?", locale: "en-GB",
  source: { ref: "canonical:concept-001", sha256: "<64 lowercase SHA256 hex>",
    verified_at: "2026-10-25T10:00:00Z", citations: [
      { ref: "primary-reference-1", url: "https://example.org/reference", verified: true }
    ] }
});
// Four stable slots: podcast, infographic, blog, clip. Plan state is never published.
const verdict = assessMediaBundle(plan, receiptsFromVerifiedR2AndHttpProbes);
// Only a verdict with no blockers may be presented to a governed promotion workflow.
```

## Shared, project-neutral execution boundary

1. **Source-First**: one canonical topic and revision, a source digest, verified primary citations, independent approval for regulated statements. The plan refuses unreviewed regulated content before any render.
2. **Derive once, project-specific styling**: one source envelope fans out to an audio dialogue, RTL SVG/PNG accessible infographic, canonical HTML/Markdown blog and captioned MP4/WebM clip. All outputs have an edition-scoped, project/tenant-isolated artefact key.
3. **Provider adapters**: upstream Kit Podcast Workflow/TTS handles audio; site renderer handles SVG/PNG; article renderer and video renderer are injected by the consuming project. This contract neither assumes their existence nor claims generation.
4. **Deliver and observe**: do not mark an artefact as verified until SHA-256, byte size, HTTPS 200, R2 namespace, and modality-specific proofs are present. Audio/video require HTTP 206. Audio must be 45–80 sec with transcript and RSS; clips require captions; infographics require Persian or locale-specific alt text and source digest; blog requires canonical URL and positive word count.
5. **Atomic promotion (consumer responsibility)**: D1 unique bundle/slot ledger, immutable input hashes, actual Worker/Workflow checkpoints, per-slot retries and a release controller MUST confirm every required artefact before any public status is marked published. `assessMediaBundle` returns `published:false` even if observations are valid; it is not a publishing API.
6. **Portability**: no Cloudflare account, hostname, repository, model, title, locale, sector, category, Iranian law or tenant is hardcoded into the kernel. Transport adapters handle D1/R2/Queues/Workflows and can be replaced with equivalent stores while preserving the envelope and E2E tests.

## Integration sequence and non-negotiable gates

- Merge Kit with green full tests and independent review, then pin SHA and re-vendor app; add Kit package export and manifest contract gate.
- App podcast #65 imports this kernel only after vendor parity, and its 18/day scheduler uses a **single source envelope** for the four derivative outputs.
- App D1 append-only migrations must create `media_bundle` and `media_slot` ledgers without rewriting existing podcast tables/GUIDs. Existing feeds continue working.
- Run sandbox end-to-end through real Worker, Workflows, D1, R2, TTS/renderers and HTTP probes; check status per track + modality. Only then central release/independent-review and production smoke.

Avoid multiplying scarce 27-per-category glossary source entries by four and calling that four times as much research; every derived channel shares one verified content identity and provenance.
