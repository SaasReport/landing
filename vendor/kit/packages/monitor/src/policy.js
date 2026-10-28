/** Flake policy and result bookkeeping (pure). */

/** Run a journey; a failure is retried (once by default) and only consecutive failures on every attempt count. */
export async function runJourney(name, fn, { retries = 1, now = () => Date.now(), onRetry } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = now();
    try {
      const notes = await fn({ attempt });
      return { name, ok: true, ms: now() - t0, attempts: attempt + 1, ...(notes ? { notes: String(notes).slice(0, 500) } : {}) };
    } catch (e) {
      last = { name, ok: false, ms: now() - t0, attempts: attempt + 1, error: String(e?.message || e).slice(0, 500) };
      if (attempt < retries && onRetry) await onRetry(last);
    }
  }
  return last;
}

/** { ok, passed, failed: [names], flaky: [names that passed on a retry], total }. */
export const summarize = (results) => ({
  ok: results.every((r) => r.ok),
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).map((r) => r.name),
  flaky: results.filter((r) => r.ok && r.attempts > 1).map((r) => r.name),
  total: results.length,
});

export function expect(cond, message) { if (!cond) throw new Error(message); }
