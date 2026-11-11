/**
 * Group script lines into TTS requests.
 * @param {{text: string}[]} lines
 * @param {number} [maxLines]
 * @param {number} [maxChars]
 * @returns {number[][]} indexes of the lines in each chunk
 */
export function chunkLines(lines, maxLines = 12, maxChars = 2400) {
  const out = [];
  let cur = [], chars = 0;
  lines.forEach((l, i) => {
    const n = String(l.text ?? "").length;
    if (cur.length && (cur.length >= maxLines || chars + n > maxChars)) { out.push(cur); cur = []; chars = 0; }
    cur.push(i); chars += n;
  });
  if (cur.length) out.push(cur);
  return out;
}
