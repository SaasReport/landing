/**
 * Helpers plugins share when they derive their data from a resolved scenario (actors, steps, inputs, outcomes, …).
 * Pure functions over the resolved scenario; no content.
 */
export const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));
export const actorOf = (sc, id) => sc.actors.find((a) => a.id === id);
export const expected = (sc) => (sc.outcomes || []).filter((o) => o.text).map((o) => ({ label: o.label, text: o.text }));
export const stepBase = (sc, s) => ({
  id: s.id, actor: actorOf(sc, s.actor)?.label, actorKind: actorOf(sc, s.actor)?.kind,
  ...(s.to ? { to: actorOf(sc, s.to)?.label } : {}),
  ...pick(s, ["action", "detail", "outcome", "decision", "event", "at", "chip", "icon", "channels", "fails", "rules", "fields", "actions"]),
  tone: s.status || "info",
});
export { parseExpr, evalExpr } from "./util.js";
