/**
 * A work counter, not a clock: the parsers that read attacker input add the characters, bytes and entries they examine, so a test proves the work
 * grows linearly with the input (steps(2n) <= 2.2 x steps(n)) on any machine, loaded or not. Tests read `work.steps` before and after a call
 * (measure); production code only adds to it (a number increment, no allocation). Nothing reads it to decide anything.
 */
export const work = { steps: 0 };
export const tick = (n = 1) => { work.steps += n; };

/** Run fn (sync or async) and report the steps it added: { result, steps }. */
export async function measure(fn) {
  const before = work.steps;
  const result = await fn();
  return { result, steps: work.steps - before };
}
