/** The `workbench` archetype as a plugin (kit.widgets-plugin.v1): moved from the engine core with no change of output. */
import { esc, p, fillIn } from "../html-kit.js";
import { buildDefinition } from "../../../workbench/src/spec.js";
export default {
  schema: "kit.widgets-plugin.v1", contract: 1, id: "workbench", version: "1.0.0",
  describes: "a command line and panes, each pane declaring its data source (SourceEnvelope) and showing a SYNTHETIC / SANDBOX / COMPUTED / YOURS / PUBLIC FEED badge; the whole definition is exported as `workbench` and runs on the project's workbench page",
  reads: ["workbench"],
  capabilities: { rtl: true, reducedMotion: true, needsCanvas: false },
  runtime: null,
  spec: {
    key: "workbench", shared: true, requiresWidget: true,
    resolve: (raw, { text, asOf, locale }) => buildDefinition(raw, { text, asOf, locale }),
  },
  exports: { workbench: (w, e, { scenario }) => scenario.workbench },
  exportUsage: { workbench: { placement: "app", archetypeOnly: true, message: "exported as workbench, so usage must list the workbench page (placement app)" } },
  needs: (sc) => (sc.workbench ? null : "needs \"workbench\" (sources, panes, commands, layouts)"),
  derive: (sc) => ({
    id: sc.workbench.id, title: sc.workbench.title, ...(sc.workbench.intro ? { intro: sc.workbench.intro } : {}),
    panes: sc.workbench.panes.map((p) => ({ id: p.id, title: p.title, kind: p.kind, source: p.source })),
    sources: sc.workbench.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, ...(s.origin ? { origin: s.origin } : {}), enabled: s.enabled })),
    commands: sc.workbench.commands.map((c) => ({ id: c.id, verb: c.verb, summary: c.summary })),
  }),
  render(w, c, f, locale, h) {
    const app = w.usage.surfaces.find((u) => u.placement === "app");
    return `${p("kw-wb__intro", w.data.intro)}<ul class="kw-chips" aria-label="${esc(c.a.workbench)}">${w.data.panes.map((x) => `<li class="kw-chip">${esc(x.title)}</li>`).join("")}</ul>
<p class="kw-status">${esc(fillIn(c.workbenchCount, { panes: f.num(w.data.panes.length), commands: f.num(w.data.commands.length), sources: f.num(w.data.sources.length) }))}</p>
${app ? `<p><a class="kw-btn" href="${esc(app.path)}">${esc(c.openWorkbench)}</a></p>` : ""}`;
  },
  check: () => [],
};
