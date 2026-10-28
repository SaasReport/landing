/** The terminal's notify view reads a feed or notify widget (the `terminal-notify` export kind). Shared by both archetypes. */
const clean = (v) => JSON.parse(JSON.stringify(v));
const notifyTone = (t) => (t === "pending" ? "info" : t || "info");

/** The terminal's notify view writes {date+N} as "N days from the visitor's today": a dated item's {date} becomes that. */
function relDate(text, at, asOf) {
  if (!at || !String(text).includes("{date}")) return text;
  const n = Math.round((Date.parse(`${at}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 864e5);
  return String(text).replace(/\{date\}/g, `{date${n < 0 ? "-" : "+"}${Math.abs(n)}}`);
}

/** exports["terminal-notify"] of a feed or notify plugin: (widget, build.exports entry, { text, asOf }) → the view's data. */
export async function terminalNotify(w, e, { text, asOf }) {
  return clean({
    ...(e.channels ? { channels: await Promise.all(e.channels.map(async (c) => ({ key: c.key, label: await text(c.label) }))) } : {}),
    scenarios: w.data.items.map((it) => ({
      key: it.id, chip: it.chip || it.action, event: it.event || `${w.scenario.replace(/-/g, "_")}.${it.id.replace(/-/g, "_")}`, tone: notifyTone(it.tone),
      recipient: it.to || it.actor, icon: it.icon || "•", title: it.action, body: relDate(it.outcome || it.detail || it.action, it.at, asOf),
      rules: it.rules?.length ? it.rules : [it.detail || it.action], channels: it.channels?.length ? it.channels : ["inapp"],
      ...(it.fails === "push" ? { fail: "push" } : {}),
      ...(it.actions?.length ? { actions: it.actions.map((a) => ({ label: a.label, done: a.done || a.label, tone: notifyTone(a.tone), title: a.title || a.label, text: a.result })) } : {}),
    })),
  });
}
export const TERMINAL_NOTIFY_USAGE = { placement: "terminal", message: "exported to the terminal, so usage must list it (placement terminal)" };
