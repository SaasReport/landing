/**
 * generated:<name> blocks: a start marker line and an end marker line, in the file's comment syntax (<!--, //, %%, #), with a generator's
 * output between them. One reader for every generator that writes blocks and for every check that skips them: a block is found by its name
 * and must appear exactly once in its file, so a second same-named block can never hide text from a check that only reads the first.
 */

/** A block's start or end marker line: the comment opener, then generated:<name> (start) or /generated:<name> (end). */
const MARK = /^([ \t]*)(?:<!--|\/\/|%%|#)[ \t]*(\/?)generated:([a-z][a-z0-9-]*)\b.*$/gm;

/**
 * The blocks of a text: [{ name, indent, start, end }] (start: just after the start line, end: the start of the end line). Throws on a block
 * left open, an end with no start, a block inside a block, and a name that appears twice.
 */
export function blocksIn(text) {
  const out = [], seen = new Set(); let open = null;
  for (const m of text.matchAll(MARK)) {
    if (!m[2]) {
      if (open) throw new Error(`generated:${open.name} is not closed before generated:${m[3]} starts`);
      if (seen.has(m[3])) throw new Error(`generated:${m[3]} appears more than once; a block appears exactly once in its file`);
      seen.add(m[3]); open = { name: m[3], indent: m[1], start: m.index + m[0].length + 1 };
    } else {
      if (!open || open.name !== m[3]) throw new Error(`/generated:${m[3]} closes no open block`);
      out.push({ ...open, end: m.index }); open = null;
    }
  }
  if (open) throw new Error(`generated:${open.name} is never closed`);
  return out;
}

/** The text with block `name`'s content replaced by `body` (its lines, each ending in a newline). Throws when the block is missing. */
export function replaceBlock(text, name, body) {
  const b = blocksIn(text).find((x) => x.name === name);
  if (!b) throw new Error(`generated:${name}: markers not found`);
  return text.slice(0, b.start) + body + text.slice(b.end);
}
