import * as lame from "@breezystack/lamejs";
import { concat } from "./concat.js";

/** Nominal CBR bitrate used for duration estimates when a service does not report one. */
export const BITRATE = 64000;

/** True when the bytes start with an MPEG audio frame sync (raw CBR MP3 with no header). */
export const isMp3 = (b) => b.length >= 400 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;

/**
 * Encode 16-bit mono PCM to CBR MP3 (lamejs, pure JS — runs in Workers).
 * @param {Int16Array} pcm
 * @param {number} rate sample rate (Hz)
 * @param {number} [kbps]
 * @returns {Uint8Array}
 */
export function encodeMp3(pcm, rate, kbps = 64) {
  const L = lame.Mp3Encoder ? lame : lame.default;
  const enc = new L.Mp3Encoder(1, rate, kbps), parts = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (b.length) parts.push(new Uint8Array(b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return concat(parts);
}
