/**
 * The ONE reader of a trust-record directory, for bundled() (the installed package's registry/trust) and for gitSource() (the committed copy at a sha): both list the files and read their
 * text, and this decides what a file is. A file that is not readable JSON is NOT skipped: it may be the owner's newest record, corrupted on purpose, so it becomes a `null` entry, which
 * trustedApprovals (core/approvals.js) treats as a corrupted set and fails closed on, and `highestRecord` throws on. Nothing here ever drops a record silently.
 */
export function readTrustRecords({ files, read }) {
  const records = [];
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    let text = null; try { text = read(f); } catch { /* unreadable: text stays null, which becomes a null record that fails the whole set closed */ }
    let rec = null; try { rec = text == null ? null : JSON.parse(text); } catch { /* not JSON: rec stays null, which becomes a null record that fails the whole set closed */ }
    records.push(rec && typeof rec === "object" && !Array.isArray(rec) ? rec : null);
  }
  return records;
}

/** The project's highest-seq record of a set (an invalid higher one is returned too, so the verifier refuses it instead of falling back); throws, failing closed, on a corrupted set. */
export function highestRecord(records, project) {
  if (records.some((r) => r === null || typeof r.project !== "string")) throw new Error("a trust record file in the set is unreadable or has no project: the set is corrupted, so nothing is trusted (fail closed)");
  const mine = records.filter((r) => r.project === project);
  if (mine.some((r) => !Number.isInteger(r.seq) || r.seq < 1)) throw new Error(`a trust record for "${project}" has no valid seq: it cannot be ordered, so nothing is trusted (fail closed)`);
  return mine.sort((a, b) => b.seq - a.seq)[0] ?? null;
}
