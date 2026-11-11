/**
 * The evidence record (docs/AGENT-GUARD.md): EVERY decision of the path (allow and deny) leaves one record, hash-chained so a removed, edited or reordered line is
 * detected, signed by the acting agent's own key when it has one, and anchored OUTSIDE the file in a witness log so truncating or rewriting the whole file is
 * detected too. `kit.guard-evidence.v1`: { schema, seq, at, event, boundary, action_class, decision, rule, reason, subject_sha256, agent, principal, prev, hash, sig }.
 * The call is stored only as a hash. If a record cannot be written the decision is not returned (the daemon answers 500, the hook holds): nothing is allowed unrecorded.
 *
 * Honest limits: the witness is a second file of the same machine (another directory, signed); against a process that can write both, only a remote witness holds
 * (owed, the same design as the approval ledger's witness). No fsync per record (the cost would be milliseconds on every tool call): a crash can lose the tail,
 * which the witness exposes.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const sha = (s) => createHash("sha256").update(s).digest("hex");
export const GENESIS = "0".repeat(64);

export class EvidenceLog {
  constructor(file, { witness } = {}) {
    this.file = file; this.witness = witness || null; this.last = null;
    if (existsSync(file)) { const lines = readFileSync(file, "utf8").split("\n").filter(Boolean); try { this.last = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { /* unparseable input counts as absent, never as a valid value */ this.last = { hash: "corrupt", seq: lines.length }; } }
  }
  /** Append the record of a decision (allow or deny). → the record. Throws when it cannot be written. */
  append({ payload, decision, registry, principal, actionClass, now = new Date() }) {
    const cls = actionClass ? { id: actionClass } : (registry.actions || []).find((a) => a.rules.includes(decision.rule));
    const subject = JSON.stringify({ t: payload.tool_name, i: payload.tool_input, u: payload.url, m: payload.method, r: payload.refs, b: payload.branch, f: (payload.files || []).map((f) => f.path), p: payload.prompt });
    const rec = {
      schema: "kit.guard-evidence.v1", seq: (this.last?.seq ?? 0) + 1, at: now.toISOString(), event: payload.hook_event_name || "",
      boundary: payload.tool_name || payload.hook_event_name || "", action_class: cls?.id ?? null, decision: decision.action === "deny" ? "deny" : "allow", rule: decision.rule ?? null,
      reason: String(decision.reason || "").slice(0, 300), subject_sha256: sha(subject), agent: payload.agent_id ? { id: payload.agent_id, type: payload.agent_type || null } : null,
      principal: principal ? { id: principal.id, key: principal.fingerprint ?? null } : null, prev: this.last?.hash ?? GENESIS,
    };
    rec.hash = sha(JSON.stringify(rec));
    if (principal?.sign) { try { rec.sig = principal.sign(rec.hash); } catch { /* no usable key: the record stays unsigned and verifies as unsigned */ } }
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    this.last = rec;
    this.witness?.(rec);
    return rec;
  }
}

/** One-off append (a log object per call: for tests and scripts). */
export function appendEvidence(file, opts) { return new EvidenceLog(file, { witness: opts.witness }).append(opts); }

/** The witness: an append-only file elsewhere, one line per record { seq, hash, at, sig }, signed by `sign` when given. */
export function fileWitness(path, sign) {
  return (rec) => { mkdirSync(dirname(path), { recursive: true }); const row = { seq: rec.seq, hash: rec.hash, at: rec.at }; if (sign) { try { row.sig = sign(`${row.seq}:${row.hash}`); } catch { /* no usable key: the record stays unsigned and verifies as unsigned */ } } appendFileSync(path, `${JSON.stringify(row)}\n`); };
}

/** → { ok, records, problems }: the chain, and (with `witness`) every witnessed record is in the chain and the chain is not shorter than the witness. `verifySig(principalId, hash, sig)` checks signatures. */
export function verifyEvidence(file, { witness = null, verifySig = null } = {}) {
  const problems = [];
  const byseq = new Map();
  let prev = GENESIS, seq = 0;
  if (existsSync(file)) for (const [i, line] of readFileSync(file, "utf8").split("\n").filter(Boolean).entries()) {
    let r; try { r = JSON.parse(line); } catch { problems.push(`line ${i + 1}: not JSON`); break; }
    const { hash, sig, ...rest } = r;
    if (r.seq !== ++seq) problems.push(`line ${i + 1}: seq ${r.seq}, expected ${seq} (a record is missing)`);
    if (r.prev !== prev) problems.push(`line ${i + 1}: prev does not link to the record before it (a record was removed or reordered)`);
    if (hash !== sha(JSON.stringify(rest))) problems.push(`line ${i + 1}: hash does not match the record (edited)`);
    if (verifySig && r.principal?.id && sig && !verifySig(r.principal.id, hash, sig)) problems.push(`line ${i + 1}: the signature of ${r.principal.id} does not verify`);
    byseq.set(r.seq, hash); prev = hash;
  }
  if (witness && existsSync(witness)) {
    let maxw = 0;
    for (const [i, line] of readFileSync(witness, "utf8").split("\n").filter(Boolean).entries()) {
      let w; try { w = JSON.parse(line); } catch { problems.push(`witness line ${i + 1}: not JSON`); continue; }
      maxw = Math.max(maxw, w.seq);
      if (!byseq.has(w.seq)) problems.push(`witness: record ${w.seq} was witnessed but is not in the log (the log was truncated or rewritten)`);
      else if (byseq.get(w.seq) !== w.hash) problems.push(`witness: record ${w.seq} differs from what was witnessed (the log was rewritten)`);
    }
    if (seq < maxw) problems.push(`witness: the log has ${seq} records, the witness saw ${maxw}`);
  }
  return { ok: !problems.length, records: seq, problems };
}
