import test from "node:test";
import assert from "node:assert/strict";
import { chunkLines, estimateStarts, id3Tag, readId3, id3Lang, encodeMp3, isMp3, concat, pcmFromInline } from "../src/audio/index.js";
import { tonePcm, wav, b64 } from "./fixtures.mjs";

const L = (n, len = 10) => Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? "expert" : "host", text: "x".repeat(len) }));

test("chunkLines splits by line count and by characters, keeping order", () => {
  assert.deepEqual(chunkLines(L(5), 2, 1000), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(chunkLines(L(4, 100), 10, 250), [[0, 1], [2, 3]]);
  assert.deepEqual(chunkLines(L(1, 5000), 10, 100), [[0]], "an oversized line still gets its own chunk");
  assert.deepEqual(chunkLines([]), []);
  assert.deepEqual(chunkLines(L(30)).flat(), [...Array(30).keys()]);
});

test("estimateStarts snaps line boundaries to pauses", () => {
  const rate = 16000;
  // lead 300 ms silence, line 1 (1000 ms), pause 500 ms, line 2 (1000 ms), pause 500, line 3 (1000 ms)
  const pcm = tonePcm(rate, [[300, false], [1000, true], [500, false], [1000, true], [500, false], [1000, true]]);
  const starts = estimateStarts(pcm, rate, [{ text: "aaaa" }, { text: "aaaa" }, { text: "aaaa" }], 300);
  assert.equal(starts.length, 3);
  assert.equal(starts[0], 300);
  assert.ok(Math.abs(starts[1] - 1550) <= 60, `second start ${starts[1]} near 1550`);
  assert.ok(Math.abs(starts[2] - 3050) <= 60, `third start ${starts[2]} near 3050`);
  assert.ok(starts[1] < starts[2]);
  assert.deepEqual(estimateStarts(pcm, rate, []), []);
});

test("estimateStarts falls back to text proportions without pauses", () => {
  const rate = 8000, pcm = tonePcm(rate, [[2000, true]]);
  const starts = estimateStarts(pcm, rate, [{ text: "a" }, { text: "aaa" }]);
  assert.deepEqual(starts, [0, 500]);
});

test("id3Tag writes a v2.3 tag with UTF-16 frames that reads back", () => {
  const tag = id3Tag({ title: "قسمت ۱: IBAN", artist: "Example", album: "Show", year: 2026, comment: "خلاصه", track: 7, lang: id3Lang("fa-IR") });
  assert.deepEqual([...tag.subarray(0, 5)], [0x49, 0x44, 0x33, 3, 0]);
  for (const b of tag.subarray(6, 10)) assert.ok(b < 0x80, "syncsafe size");
  const r = readId3(tag);
  assert.equal(r.size, tag.length);
  assert.equal(r.TIT2, "قسمت ۱: IBAN");
  assert.equal(r.TPE1, "Example");
  assert.equal(r.TALB, "Show");
  assert.equal(r.TYER, "2026");
  assert.equal(r.TRCK, "7");
  assert.equal(r.TCON, "Podcast");
  assert.equal(r.COMM, "خلاصه");
  assert.equal(r.COMM_LANG, "fas");
  assert.equal(id3Lang("en-US"), "eng");
});

test("encodeMp3 produces MP3 frames of the expected size", () => {
  const rate = 24000, pcm = tonePcm(rate, [[1000, true], [1000, false]]);
  const mp3 = encodeMp3(pcm, rate, 64);
  assert.ok(isMp3(mp3), "starts with a frame sync");
  // 2 s at 64 kbps ≈ 16000 bytes (plus encoder delay / padding frames)
  assert.ok(mp3.length > 14000 && mp3.length < 20000, `size ${mp3.length}`);
  const tagged = concat([id3Tag({ title: "t" }), mp3]);
  assert.equal(readId3(tagged).TIT2, "t");
  assert.equal(tagged.length, readId3(tagged).size + mp3.length);
});

test("pcmFromInline reads WAV and raw L16", () => {
  const pcm = tonePcm(22050, [[100, true]]);
  const a = pcmFromInline("audio/wav", b64(wav(pcm, 22050)));
  assert.equal(a.rate, 22050);
  assert.deepEqual([...a.pcm], [...pcm]);
  const raw = new Uint8Array(pcm.buffer.slice(0));
  const b = pcmFromInline("audio/L16;codec=pcm;rate=24000", b64(raw));
  assert.equal(b.rate, 24000);
  assert.deepEqual([...b.pcm], [...pcm]);
});
