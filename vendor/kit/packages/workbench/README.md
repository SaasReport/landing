# @saasreport/workbench

The workbench archetype: a command line (`VERB [target] [args]`, Persian folded), a pane layout (tabs and columns, kept in
`localStorage`), watchlists, a keyboard map and panes that each declare their data through a `SourceEnvelope` and always show a
`SYNTHETIC`, `SANDBOX`, `COMPUTED`, `YOURS` or `PUBLIC FEED` badge with the source name, the as-of time and the licence line. It
carries no content: a project defines everything in `widgets.spec.json` (`scenario.workbench`, exported as `workbench`). Built
natively after the shape of Gloomberb (MIT; no code, no dependency).

Read [docs/WORKBENCH.md](../../docs/WORKBENCH.md) (diagram, grammar, BYO guards, rendering, how a project adopts it).

- `schemas/`: `workbench`, `command-registry`, `source-envelope` (JSON Schema 2020-12).
- `src/`: `workbenchProblems`, `buildDefinition`, `workbenchChunks`, `runtimeSource`, `loadRuntime`, the interface words (`fa`, `en`).
- `assets/core.js` (pure) and `assets/ui.js` (DOM): assembled with the kit's validator into the one script `workbench.js`.
- `theme/workbench.css`: rendered with the project's tokens (roles only).
- Tests: `node --test packages/workbench/test/*.test.mjs`.
