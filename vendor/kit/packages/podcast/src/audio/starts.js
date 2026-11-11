/**
 * Line start offsets (ms) for a multi-line render: split the audio by text length, then snap each
 * boundary to the nearest pause (≥ 240 ms of low energy) in the PCM.
 * @param {Int16Array} pcm
 * @param {number} rate
 * @param {{text: string}[]} lines
 * @param {number} [leadMs] silence before the first line
 * @returns {number[]}
 */
export function estimateStarts(pcm, rate, lines, leadMs = 0) {
  if (!lines.length) return [];
  const frame = Math.max(1, Math.round(rate * 0.02)), n = Math.floor(pcm.length / frame), quiet = [];
  let run = 0;
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) e += Math.abs(pcm[i]);
    if (e / frame < 300) run++;
    else { if (run >= 12) quiet.push(Math.round((f - run / 2) * 20)); run = 0; }
  }
  const total = (pcm.length / rate) * 1000;
  const chars = lines.map((l) => String(l.text ?? "").length), sum = chars.reduce((a, b) => a + b, 0) || 1;
  const starts = [leadMs];
  let acc = 0;
  for (let k = 1; k < lines.length; k++) {
    acc += chars[k - 1];
    const guess = leadMs + ((total - leadMs) * acc) / sum;
    const near = quiet.filter((q) => q > starts[k - 1] + 300).sort((a, b) => Math.abs(a - guess) - Math.abs(b - guess))[0];
    starts.push(Math.round(near != null && Math.abs(near - guess) < total * 0.15 ? near : guess));
  }
  return starts;
}
