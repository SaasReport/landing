/**
 * The evidence log: what the SYSTEM did to an upload (a rescan that changed nothing, a rollback, a re-keying) is an append-only object in
 * the quarantine bucket under evidence/<upload id>/, never a growing array on the record. The record keeps only a person's decisions
 * (bounded, newest last); bookkeeping can therefore never fill it up and freeze a tightening (a block, a hold, a delete).
 * An entry is kit.upload-evidence.v1. A record's evidence goes with its objects when the upload is deleted.
 */
import { validateEvidence } from "./schemas.js";

export const EVIDENCE_PREFIX = "evidence/";
const hex = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function bucketEvidence(bucket) {
  return {
    async append({ upload_id, action, by, at, note }) {
      const entry = { schema: "kit.upload-evidence.v1", upload_id, action, by, at, ...(note ? { note: String(note).slice(0, 300) } : {}) };
      const problems = validateEvidence(entry);
      if (problems.length) throw new Error(`upload evidence invalid: ${problems[0]}`);
      await bucket.put(`${EVIDENCE_PREFIX}${upload_id}/${at}-${hex()}.json`, new TextEncoder().encode(JSON.stringify(entry)), { httpMetadata: { contentType: "application/json" } });
      return entry;
    },
    /** Remove every evidence object of an upload (it was erased). */
    async drop(upload_id) {
      for (let cursor; ;) {
        const page = await bucket.list({ prefix: `${EVIDENCE_PREFIX}${upload_id}/`, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) await bucket.delete(o.key);
        if (!page.truncated) return;
        cursor = page.cursor;
      }
    },
  };
}
