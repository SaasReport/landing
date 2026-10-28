/**
 * Pacing: what turns a raw TTS render into natural-sounding conversation audio. Pure PCM maths, no I/O.
 *
 * A TTS reply carries silence the listener hears as a hesitation: a long lead-in, a trailing pad, and now and then a
 * pause in the middle of a turn. tidyPcm() works on 10 ms frames:
 *   - a frame whose peak is below thresholdDb is silence (the threshold is looser than the -40 dB the audit tools use, so
 *     whatever they call silence is silence here too);
 *   - the head of the chunk is cut to headMs, the tail to tailMs;
 *   - every silence inside is cut to at most maxPauseMs (the middle goes, both edges stay, so breaths are untouched);
 *   - the voiced level is matched to normalizeDb (RMS of voiced frames, gain limited to maxGainDb, peaks kept under 0.98).
 * Between chunks the join is tailMs + the next chunk's headMs = turnGapMs.
 *
 * Configured by podcast.config.json "pacing" (kit.podcast-config.v1) as config.tts.pacing; DEFAULT_PACING is the fallback.
 */

export const DEFAULT_PACING = { thresholdDb: -36, maxPauseMs: 340, turnGapMs: 200, startMs: 250, endMs: 600, normalizeDb: -20, maxGainDb: 6 };

const FRAME_MS = 10;
const dbToAmp = (db) => 32768 * 10 ** (db / 20);

/** Resolved pacing options (config.tts.pacing over the defaults). */
export const pacingOf = (config) => ({ ...DEFAULT_PACING, ...(config?.tts?.pacing || {}) });

/**
 * @param {Int16Array} pcm mono
 * @param {number} rate Hz
 * @param {{first?: boolean, last?: boolean} & Partial<typeof DEFAULT_PACING>} [opts]
 * @returns {{pcm: Int16Array, stats: {inMs: number, outMs: number, cutMs: number, longestPauseMs: number, gainDb: number}}}
 */
export function tidyPcm(pcm, rate, opts = {}) {
  const o = { ...DEFAULT_PACING, ...opts };
  const first = !!opts.first, last = !!opts.last;
  const fl = Math.max(1, Math.round((rate * FRAME_MS) / 1000)), nf = Math.ceil(pcm.length / fl);
  const thr = dbToAmp(o.thresholdDb);
  const quiet = new Array(nf);
  for (let f = 0; f < nf; f++) {
    let peak = 0;
    const end = Math.min(pcm.length, (f + 1) * fl);
    for (let i = f * fl; i < end; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
    quiet[f] = peak < thr;
  }
  const half = Math.round(o.turnGapMs / 2);
  const headMs = first ? o.startMs : half, tailMs = last ? o.endMs : o.turnGapMs - half;
  const frames = (ms) => Math.round(ms / FRAME_MS);
  // Runs of silence → how many frames of each to keep.
  const keep = new Array(nf).fill(true);
  let longest = 0, headLen = 0, tailLen = 0;
  for (let f = 0; f < nf;) {
    if (!quiet[f]) { f++; continue; }
    let g = f;
    while (g < nf && quiet[g]) g++;
    const len = g - f;
    const isHead = f === 0, isTail = g === nf;
    if (isHead) headLen = len;
    if (isTail) tailLen = len;
    const cap = isHead && isTail ? frames(headMs) : isHead ? frames(headMs) : isTail ? frames(tailMs) : frames(o.maxPauseMs);
    if (len > cap) {
      // keep the edges next to speech, drop the middle (head: keep the end; tail: keep the start)
      const from = isHead ? f : isTail ? f + cap : f + Math.ceil(cap / 2);
      const to = isHead ? g - cap : isTail ? g : g - Math.floor(cap / 2);
      for (let x = from; x < to; x++) keep[x] = false;
    }
    if (!isHead && !isTail) longest = Math.max(longest, Math.min(len, cap));
    f = g;
  }
  // A chunk whose head or tail is shorter than configured gets silence added, so joins are the configured gap.
  const leadPad = Math.max(0, frames(headMs) - headLen), tailPad = Math.max(0, frames(tailMs) - tailLen);
  let kept = 0;
  for (let f = 0; f < nf; f++) if (keep[f]) kept += Math.min(fl, pcm.length - f * fl);
  // Level: RMS of voiced frames → normalizeDb, gain limited, peak limited.
  let sumSq = 0, n = 0, peakAll = 1;
  for (let f = 0; f < nf; f++) {
    if (quiet[f]) continue;
    const end = Math.min(pcm.length, (f + 1) * fl);
    for (let i = f * fl; i < end; i++) { sumSq += pcm[i] * pcm[i]; n++; const a = Math.abs(pcm[i]); if (a > peakAll) peakAll = a; }
  }
  const rms = n ? Math.sqrt(sumSq / n) : 0;
  let gain = rms > 0 ? dbToAmp(o.normalizeDb) / rms : 1;
  gain = Math.min(gain, 10 ** (o.maxGainDb / 20), (0.98 * 32768) / peakAll);
  gain = Math.max(gain, 10 ** (-o.maxGainDb / 20));
  const padS = (leadPad + tailPad) * fl, out = new Int16Array(kept + padS);
  let w = leadPad * fl;
  for (let f = 0; f < nf; f++) {
    if (!keep[f]) continue;
    const end = Math.min(pcm.length, (f + 1) * fl);
    for (let i = f * fl; i < end; i++) out[w++] = gain === 1 ? pcm[i] : Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
  }
  return { pcm: out, stats: { inMs: Math.round((pcm.length / rate) * 1000), outMs: Math.round((out.length / rate) * 1000), cutMs: Math.round(((pcm.length - kept) / rate) * 1000),
    longestPauseMs: longest * FRAME_MS, gainDb: Math.round(20 * Math.log10(gain) * 10) / 10 } };
}
