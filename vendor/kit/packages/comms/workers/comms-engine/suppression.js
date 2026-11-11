/**
 * Part of the comms engine (constitution §38).
 * Suppression list — consulted before every dispatch.
 * Reasons: hard-bounce, complaint, unsubscribe.marketing,
 * unsubscribe.operational, dsar-erasure. DSAR-erasure is global and
 * cannot be overridden by template suppress_when filters.
 */

/** The reasons a suppression can carry: a reason outside this list is refused when it is recorded (it would never match). */
export const SUPPRESSION_REASONS = ["hard-bounce", "complaint", "unsubscribe.marketing", "unsubscribe.operational", "dsar-erasure"];

/**
 * Whether a send to this recipient is suppressed. Every row of the recipient is read: an erasure, a bounce or a complaint
 * holds whatever was recorded after it. `held: true` marks a hold for an unknown (no store, a failed lookup): the caller
 * refuses the dispatch instead of reporting it as suppressed.
 */
export async function isSuppressed(db, recipientHash, category, allowedReasons) {
  // no suppression store: whether the recipient erased, bounced or unsubscribed is unknown, so the send is held (fail closed)
  if (!db) return { suppressed: true, held: true, reason: "no-store" };
  try {
    const { results: rows = [] } = await db.prepare(
      `SELECT reason, scope FROM comms_suppression WHERE recipient_hash = ?`
    ).bind(recipientHash).all();
    const has = (reason) => rows.some((r) => r.reason === reason);
    for (const reason of ["dsar-erasure", "hard-bounce", "complaint"]) if (has(reason)) return { suppressed: true, reason };
    const allowed = (allowedReasons || []).find(has);
    if (allowed) return { suppressed: true, reason: allowed };
    if (category === "marketing" && has("unsubscribe.marketing")) return { suppressed: true, reason: "unsubscribe.marketing" };
    return { suppressed: false };
  } catch (e) { console.error("comms suppression: lookup failed; holding the send", e); return { suppressed: true, held: true, reason: "lookup-failed" }; }
}

/** Record a suppression. Throws when it cannot be recorded: an unsubscribe or an erasure is never lost in silence. */
export async function addSuppression(db, { recipientHash, reason, scope, actor_id }) {
  if (!SUPPRESSION_REASONS.includes(reason)) throw new Error(`comms suppression: unknown suppression reason "${reason}" (${SUPPRESSION_REASONS.join(", ")})`);
  if (!db) throw new Error("comms suppression: no store (DB) to record it in");
  try {
    await db.prepare(
      `INSERT INTO comms_suppression (recipient_hash, reason, scope, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(recipient_hash, reason) DO UPDATE SET created_at = excluded.created_at`
    ).bind(recipientHash, reason, scope || "global", actor_id, new Date().toISOString()).run();
  } catch (e) { console.error("comms suppression: the row was not written", e); throw e; }
}
