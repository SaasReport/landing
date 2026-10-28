# @saasreport/uploads

Upload safety for Workers: bounded body reader, magic-byte sniffer with a per-form allowlist, native static triage (PDF, OOXML, OLE2, zip, SVG, images), quarantine then release on R2, a pluggable scan step with an explicit verdict (`allow | allow_with_limits | needs_sandbox | block | scan_failed`, never "clean"), Evidence records, safe serving and retention.

Contracts: `kit.upload-record.v1`, `kit.upload-policy.v1`, `kit.uploads-config.v1`, `kit.upload-error.v1` (packages/core/schemas). Full description and diagram: [docs/UPLOADS.md](../../docs/UPLOADS.md).
