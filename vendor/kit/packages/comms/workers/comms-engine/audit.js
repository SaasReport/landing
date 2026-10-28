/**
 * Audit emission — §0.3 self-governance (comms engine).
 *
 * The engine persists its canonical event family
 * (<prefix>.comms.requested.v1 / <prefix>.comms.dispatched.v1 / …) to D1 and, when
 * AUDIT_CHAIN_BASE_URL is configured, mirrors each event to an external
 * append-only audit chain. Best-effort by design — the dispatch row is
 * authoritative for the send itself.
 */
export async function emitAuditChain(env, evt) {
  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO comms_audit (event_family_id, source_event_id, emitted_at, actor_id, tenant_id, payload_summary, audit_chain_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(evt.event_family_id, evt.source_event_id, evt.emitted_at || new Date().toISOString(),
        evt.actor_id, evt.tenant_id, evt.payload_summary || null, evt.audit_chain_ref || null).run();
    } catch (e) { console.error("comms audit: the D1 row was not written", e); }
  }
  if (!env.AUDIT_CHAIN_BASE_URL) return;
  try {
    await fetch(`${env.AUDIT_CHAIN_BASE_URL}/v1/audit/append`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.AUDIT_CHAIN_AUTH_HEADER && { authorization: env.AUDIT_CHAIN_AUTH_HEADER }),
      },
      body: JSON.stringify(evt),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) { console.error("comms audit: the chain was not notified", e); }
}
