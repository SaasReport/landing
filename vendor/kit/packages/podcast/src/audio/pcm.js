const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Pull 16-bit mono PCM and its sample rate out of inline audio (WAV or raw L16, e.g. Gemini's
 * `audio/L16;codec=pcm;rate=24000`).
 * @param {string} mime
 * @param {string | Uint8Array} data base64 string or raw bytes
 * @returns {{pcm: Int16Array, rate: number}}
 */
export function pcmFromInline(mime, data) {
  const bytes = typeof data === "string" ? fromB64(data) : new Uint8Array(data);
  let rate = Number(/rate=(\d+)/.exec(mime || "")?.[1] || 24000), start = 0, end = bytes.length;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (/wav/i.test(mime || "") || (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)) {
    if (bytes.length >= 28) rate = dv.getUint32(24, true);
    for (let o = 12; o + 8 <= bytes.length;) {
      const id = String.fromCharCode(...bytes.subarray(o, o + 4)), size = dv.getUint32(o + 4, true);
      if (id === "data") { start = o + 8; end = Math.min(bytes.length, start + size); break; }
      o += 8 + size + (size & 1);
    }
  }
  const len = (end - start) >> 1, pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) pcm[i] = dv.getInt16(start + i * 2, true);
  return { pcm, rate };
}

/** Silence of the given length, in samples. */
export const silence = (rate, ms) => new Int16Array(Math.max(0, Math.round((rate * ms) / 1000)));
