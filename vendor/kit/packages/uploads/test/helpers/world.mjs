// A small world for the review tests: the engine over in-memory buckets and records, a clock, and an approval ledger with one approver.
import { readFileSync } from "node:fs";
import { createUploads, loadUploadsConfig, memoryBucket, memoryRecords } from "../../src/index.js";
import { pdf } from "../fixtures.mjs";
import { people } from "./people.mjs";

const registry = JSON.parse(readFileSync(new URL("../../../core/registry/projects.json", import.meta.url), "utf8"));
export const PDF = "application/pdf";
export const raw = () => ({ schema: "kit.uploads-config.v1", project: "saasreport", storage: { quarantine: { binding: "QUAR", bucket: "saasreport-uploads-quarantine" }, released: { binding: "REL", bucket: "saasreport-uploads" } },
  forms: { partner: { id: "partner-attachment", file_fields: [{ name: "attachment" }], allowed_types: [PDF], max_bytes: 1048576, retention_days: 30, blocked_retention_days: 7, on_needs_sandbox: "hold", scanner: "fake-av" } } });

export function world({ verdict = "needs_sandbox", records = memoryRecords(), env = { QUAR: memoryBucket(), REL: memoryBucket() }, P: given = null, actions = null, windows = null } = {}) {
  const state = { verdict };
  const scanners = { "fake-av": { name: "fake-av", version: "1", scan: async () => ({ verdict: state.verdict }) } };
  let t = Date.parse("2026-10-07T12:00:00Z");
  const now = () => new Date(t);
  const P = given ?? people(now, { ...(actions ? { actions } : {}), ...(windows ? { windows } : {}) });
  const uploads = createUploads({ config: loadUploadsConfig(raw(), { registry, scanners }), env, scanners, records, now, authority: P.authority });
  const body = (n) => pdf([`<< /Type /Catalog /Pages 2 0 R /N ${n} >>`, "<< /Type /Pages /Kids [] /Count 0 >>"]);
  const intake = (n, filename = "a.pdf") => uploads.intake({ form: "partner", bytes: body(n), filename, contentType: PDF });
  const decide = async (id, action, note) => ({ decision: await P.sign(await records.get(id), action, note) });
  return { state, uploads, records, env, q: env.QUAR, r: env.REL, P, now, tick: (ms) => { t += ms; }, intake, decide, body };
}

