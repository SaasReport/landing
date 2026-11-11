// audio/pace.js: the pauses a listener hears as hesitation are capped, head and tail trimmed, levels matched.
import test from "node:test";
import assert from "node:assert/strict";
import { tidyPcm, pacingOf, DEFAULT_PACING } from "../src/index.js";
import { tonePcm } from "./fixtures.mjs";

const RATE = 24000;
const ms = (pcm) => Math.round((pcm.length / RATE) * 1000);
/** Longest run of near-silent samples (< -40 dB peak per 10 ms frame) strictly inside the audio, in ms. */
function longestInside(pcm) {
  const fl = RATE / 100, quiet = [];
  for (let f = 0; f * fl < pcm.length; f++) { let p = 0; for (let i = f * fl; i < Math.min(pcm.length, (f + 1) * fl); i++) p = Math.max(p, Math.abs(pcm[i])); quiet.push(p < 327); }
  const a = quiet.indexOf(false), b = quiet.lastIndexOf(false);
  let best = 0, run = 0;
  for (let f = a; f <= b; f++) { run = quiet[f] ? run + 1 : 0; best = Math.max(best, run); }
  return best * 10;
}

test("a long lead-in, a long pause and a long tail are cut to the configured pacing", () => {
  const raw = tonePcm(RATE, [[900, false], [600, true], [1500, false], [600, true], [1200, false]]);
  const { pcm, stats } = tidyPcm(raw, RATE, { first: true, last: true });
  assert.equal(ms(pcm), DEFAULT_PACING.startMs + 600 + DEFAULT_PACING.maxPauseMs + 600 + DEFAULT_PACING.endMs);
  assert.equal(stats.longestPauseMs, DEFAULT_PACING.maxPauseMs);
  assert.ok(longestInside(pcm) <= DEFAULT_PACING.maxPauseMs);
  assert.ok(stats.cutMs > 2000);
});

test("pauses shorter than the cap are untouched; joins between chunks are the turn gap", () => {
  const raw = tonePcm(RATE, [[500, true], [200, false], [500, true]]);
  const mid = tidyPcm(raw, RATE).pcm;
  assert.equal(ms(mid), 100 + 500 + 200 + 500 + 100);
  assert.equal(tidyPcm(raw, RATE, { turnGapMs: 300 }).pcm.length > mid.length, true);
});

test("levels are matched toward normalizeDb without clipping, gain limited", () => {
  const quiet = tonePcm(RATE, [[800, true]]).map((v) => v >> 2);   // ~ -24 dB peak
  const { pcm, stats } = tidyPcm(quiet, RATE, { maxGainDb: 6 });
  assert.ok(stats.gainDb > 0 && stats.gainDb <= 6.01, String(stats.gainDb));
  assert.ok(Math.max(...pcm.map(Math.abs)) < 32768 * 0.98);
});

test("an all-silent chunk does not throw and keeps only the configured edges", () => {
  const { pcm } = tidyPcm(new Int16Array(RATE * 2), RATE, { first: true, last: true });
  assert.ok(ms(pcm) <= DEFAULT_PACING.startMs + 10);
});

test("pacingOf merges config.tts.pacing over the defaults", () => {
  assert.deepEqual(pacingOf({ tts: { pacing: { maxPauseMs: 300 } } }), { ...DEFAULT_PACING, maxPauseMs: 300 });
  assert.deepEqual(pacingOf({}), DEFAULT_PACING);
});
