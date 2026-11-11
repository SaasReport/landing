/**
 * What the publish drill substitutes for the outside world, and nothing else: an R2 bucket in memory, and the one outbound call the cron's
 * workflow makes (the TTS provider) answered by a fixture. Every other outbound request is refused, so a drill that reached for a provider,
 * a webhook or a channel fails instead of spending a quota or telling someone.
 */

/** A bucket: head / get (with ranges) / put / delete over a Map (`store`). */
export function makeR2() {
  const store = new Map();
  const bytes = (v) => (typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v));
  return {
    store,
    head: async (key) => (store.has(key) ? { key, size: store.get(key).length } : null),
    get: async (key, opts = {}) => {
      if (!store.has(key)) return null;
      let b = store.get(key);
      if (opts.range) b = b.slice(opts.range.offset, opts.range.offset + opts.range.length);
      return { body: b, size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    put: async (key, v) => { store.set(key, bytes(v)); },
    delete: async (key) => { store.delete(key); },
  };
}

/**
 * Offline provider-only transport fixture. Each model generation has its own
 * outbound endpoint and REST response contract. No other domain is allowed.
 * The publish drill exercises real PCM assembly without spending TTS quota.
 */
export function fixtureTts({ rate = 24000, ms = 900 } = {}) {
  const n = Math.round((rate * ms) / 1000), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  const data = pcm.toString("base64");
  const old = JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: `audio/L16;rate=${rate}`, data } }] } }] });
  const modern = JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "audio", mime_type: `audio/l16;rate=${rate}`, data }] }] });
  return (url) => {
    const target = String(url);
    if (target === "https://generativelanguage.googleapis.com/v1beta/interactions")
      return new Response(modern, { headers: { "content-type": "application/json" } });
    const parsed = new URL(target);
    const prefix = "/v1beta/models/", suffix = ":generateContent";
    const model = parsed.pathname.startsWith(prefix) && parsed.pathname.endsWith(suffix)
      ? parsed.pathname.slice(prefix.length, -suffix.length) : "";
    if (parsed.protocol === "https:" && parsed.hostname === "generativelanguage.googleapis.com" &&
        !parsed.search && !parsed.hash && !parsed.username && !parsed.password && parsed.port === "" &&
        model.length > 0 && !model.includes("/"))
      return new Response(old, { headers: { "content-type": "application/json" } });
    return null;
  };
}

/** Replace globalThis.fetch: `answer(url, init)` returns a Response for the fixtures, anything else throws. Returns the function that restores it. */
export function offline(answer) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const r = answer(typeof url === "string" ? url : url?.url ?? String(url), init);
    if (r) return r;
    throw new Error(`dry drill: outbound request refused: ${typeof url === "string" ? url : url?.url}`);
  };
  return () => { globalThis.fetch = original; };
}
