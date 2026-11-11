/**
 * Object storage over R2 bindings. Writes never overwrite (onlyIf etagDoesNotMatch "*"): a key that exists already holds the
 * same bytes (content addressed), which the write verifies by sha256 on the platform side (R2 `sha256` option) and by size.
 * `memoryBucket()` is the in-memory twin the tests use; it follows the same R2 semantics.
 */
export async function putOnce(bucket, key, bytes, { sha256, contentType = "application/octet-stream", meta = {} } = {}) {
  const res = await bucket.put(key, bytes, {
    sha256, httpMetadata: { contentType }, customMetadata: { ...meta, ...(sha256 ? { sha256 } : {}) }, onlyIf: { etagDoesNotMatch: "*" },
  });
  if (res) return { written: true };
  // precondition failed: the key exists. It must hold the same bytes: the sha256 it was written with, or, for an object written before that, the hash of its bytes
  const head = await bucket.head(key);
  if (!head || head.size !== bytes.length) throw new Error(`object ${key} exists with different content`);
  if (sha256) {
    let have = head.customMetadata?.sha256;
    if (!have) { const o = await readObject(bucket, key); have = o ? await hexOf(o) : null; }
    if (have !== sha256) throw new Error(`object ${key} exists with different content`);
  }
  return { written: false };
}

const hexOf = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function readObject(bucket, key) {
  const o = await bucket.get(key);
  if (!o) return null;
  return new Uint8Array(await o.arrayBuffer());
}

/** An in-memory R2 bucket for tests (put with onlyIf etagDoesNotMatch and sha256, get, head, delete, list). */
export function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts = {}) {
      if (opts.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (opts.sha256) {
        const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const hex = [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
        if (hex !== opts.sha256) throw new Error("sha256 mismatch");
      }
      objects.set(key, { bytes: bytes.slice(), size: bytes.length, customMetadata: opts.customMetadata || {}, httpMetadata: opts.httpMetadata || {} });
      return { key, size: bytes.length };
    },
    async get(key) { const o = objects.get(key); return o ? { size: o.size, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata, arrayBuffer: async () => o.bytes.slice().buffer, body: new Blob([o.bytes]).stream() } : null; },
    async head(key) { const o = objects.get(key); return o ? { size: o.size, customMetadata: o.customMetadata } : null; },
    async delete(key) { objects.delete(key); },
    /** R2 list semantics: { objects: [{ key, size }], truncated, cursor }, by prefix, in key order. */
    async list({ prefix = "", cursor, startAfter, limit = 1000 } = {}) {
      const after = cursor ?? startAfter;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().filter((k) => !after || k > after);
      const page = keys.slice(0, limit);
      return { objects: page.map((key) => ({ key, size: objects.get(key).size })), truncated: keys.length > limit, cursor: page.at(-1) };
    },
  };
}
