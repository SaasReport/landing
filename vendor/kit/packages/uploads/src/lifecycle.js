/**
 * The upload lifecycle as ONE declared state machine. The table is data (lifecycle.json, contract kit.upload-lifecycle.v1): the
 * states, who may cause each transition (system, human, retention) and through which operation. The engine refuses every
 * transition the table does not list; there is no other way to change a record's stage.
 *
 *   canTransition(from, to, { actor, via }) → boolean              the table, as a pure question (actor is a type: system | human | retention)
 *   assertTransition(from, to, principal, via)                       throws TransitionError; the actor is the PRINCIPAL's type (principal.js)
 *   moved(record, to, principal, via) → record                       the record in its new stage (op cleared); a tombstone is scrubbed
 *   TABLE, STATES, tightness(stage)
 */
import LIFECYCLE from "../lifecycle.json" with { type: "json" };
import { Principal } from "./principal.js";

export const STATES = Object.freeze(Object.keys(LIFECYCLE.states));
export const ACTORS = Object.freeze(Object.keys(LIFECYCLE.actors));
export const SWEEP_STAGES = Object.freeze(STATES.filter((s) => LIFECYCLE.states[s].sweepable));
export const OPERATIONS = Object.freeze(Object.keys(LIFECYCLE.operations));
export const SPEC = LIFECYCLE;

export class TransitionError extends Error {
  constructor(from, to, { actor, via } = {}) { super(`upload lifecycle: ${from ?? "∅"} → ${to} by ${actor} via ${via} is not in the transition table`); this.name = "TransitionError"; this.from = from; this.to = to; this.actor = actor; this.via = via; }
}

/** `${from}>${to}` → [{ via, actors }]: the table expanded to pairs. */
export const TABLE = (() => {
  const t = new Map();
  for (const row of LIFECYCLE.transitions) {
    for (const from of row.from) for (const to of row.to) {
      const key = `${from}>${to}`;
      if (!t.has(key)) t.set(key, []);
      t.get(key).push({ via: row.via, actors: row.actors });
    }
  }
  return t;
})();

export function canTransition(from, to, { actor, via } = {}) {
  return (TABLE.get(`${from ?? null}>${to}`) || []).some((r) => r.via === via && r.actors.includes(actor));
}
/** The check the engine makes: the actor type comes from an authenticated or engine-made principal, never from a parameter. */
export function assertTransition(from, to, principal, via) {
  if (!(principal instanceof Principal)) throw new TransitionError(from ?? null, to, { actor: "(not a principal)", via });
  if (!canTransition(from, to, { actor: principal.type, via })) throw new TransitionError(from ?? null, to, { actor: principal.type, via });
}

/** How restrictive a stage is, for "a rescan can only tighten": released < quarantined < held < blocked. */
const RANK = { released: 0, quarantined: 1, held: 2, blocked: 3 };
export const tightness = (stage) => RANK[stage] ?? null;

/**
 * A deleted record is a tombstone: the hash, the verdict and the dates stay (the evidence that it existed and what became of it);
 * everything that can name a person or what they sent goes: the subject, the filenames, the names found inside the file, the notes.
 */
export function scrubbed(record) {
  return {
    ...record,
    subject_ref: null,
    declared: { content_type: null, filename: null, filename_normalised: null, filename_full: null },
    triage: { ...record.triage, markers: record.triage.markers.map((m) => ({ ...m, first_ref: null })), ...(record.triage.incomplete_because ? { incomplete_because: ["scrubbed"] } : {}) },
    decisions: (record.decisions || []).map(({ note, ...e }) => e),
    ...(record.evidence_ref ? { evidence_ref: null } : {}),
  };
}

/** The record in stage `to` with its operation cleared, after the table has agreed. */
export function moved(record, to, principal, via) {
  assertTransition(record.stage, to, principal, via);
  const { op, ...rest } = record;
  return to === "deleted" ? scrubbed({ ...rest, stage: to }) : { ...rest, stage: to };
}

/**
 * Finish an operation whose intent is already on the record. The intent carries the actor TYPE the principal had when the engine
 * wrote it (the table was checked then, from the principal); completing it re-checks the table with that recorded type.
 */
export function completed(record, to, actorType, via) {
  if (!canTransition(record.stage, to, { actor: actorType, via })) throw new TransitionError(record.stage, to, { actor: actorType, via });
  const { op, ...rest } = record;
  return to === "deleted" ? scrubbed({ ...rest, stage: to }) : { ...rest, stage: to };
}
