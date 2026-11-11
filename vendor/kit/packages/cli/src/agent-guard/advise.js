/**
 * The advisor stage (docs/AGENT-GUARD.md: where an advisor plugs in): consulted AFTER the deterministic rules allow, at every boundary the
 * daemon serves. Tighten-only: an advisor's `allow` (or any other answer) changes nothing; `hold` or `deny` blocks. An advisor is a resident local
 * daemon reached over HTTP (never loaded per call). In `enforce` mode an unreachable advisor follows its declared `onUnavailable`.
 * → null (no change) or { rule, reason }.
 */
export async function advise(registry, payload) {
  for (const a of registry.advisors || []) {
    let v = null;
    try {
      const res = await fetch(a.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: payload.hook_event_name, tool_name: payload.tool_name, tool_input: payload.tool_input, prompt: payload.prompt, agent_type: payload.agent_type, advisor: a.id }), signal: AbortSignal.timeout(a.timeoutMs || 100) });
      v = await res.json();
    } catch { /* failure here means no value; the caller holds on the empty answer */ if (a.mode === "enforce" && a.onUnavailable === "hold") return { rule: `advisor-${a.id}`, reason: `advisor ${a.id} is unavailable and is declared onUnavailable=hold` }; continue; }
    if (a.mode === "enforce" && (v?.verdict === "hold" || v?.verdict === "deny")) return { rule: `advisor-${a.id}`, reason: String(v.reason || `advisor ${a.id} holds this action`).slice(0, 600) };
  }
  return null;
}
