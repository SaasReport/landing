# @saasreport/widgets

Tailor-made widgets: every interactive widget a project shows is generated from **that project's**
`widgets.spec.json` (audiences, use cases, scenarios; usage, application, architecture and utility per widget) and
the contracts it names (OpenAPI, JSON Schemas, content, engines). The package ships archetypes and the engine only,
no content. The rule and the contract: [docs/WIDGETS.md](../../docs/WIDGETS.md).

![widget-engine](../../docs/diagrams/widget-engine.png)

- `schemas/widgets-spec.schema.json` (`kit.widgets-spec.v1`), `schemas/widgets-generated.schema.json`
  (`kit.widgets-generated.v1`), `schemas/vocabularies.schema.json` + `registry/vocabularies.json` (`kit.vocabularies.v1`).
- `src/plugins/*.js`: every archetype is a plugin (`kit.widgets-plugin.v1`, `schemas/widgets-plugin.schema.json`) behind the registry in
  `src/registry.js`: feed, chain, timeline, workflow, pipeline, calculator, playground, comparison, roles, screens, tour, notify, machine, runs,
  workbench and the financial-network set network, flow, split, netting, match, builder. Each ships its runtime module
  (`assets/widgets/plugins/<id>.js`, loaded only when used) and its stylesheet template (`theme/plugins/<id>.css`). A project adds its own
  with `plugins` in its spec; the engine core names none.
- `src/build.js` (`kit widgets build`), `src/check.js` (`kit widgets check`), `src/sources.js` (OpenAPI operations,
  schema samples, engine calls), `src/html.js` (static HTML; the site's `widgets` page type), `src/chrome.js` (interface
  words fa/en/ar), `assets/widgets.js` (runtime), `theme/widgets.css` (from the project's tokens).

```js
import { buildWidgets, checkWidgets } from "@saasreport/widgets";
const { json, out } = await buildWidgets("widgets.spec.json");   // write json to out
const { problems } = await checkWidgets("widgets.spec.json");    // [] when fine
```

Tests: `node --test packages/widgets/test/*.test.mjs` (a fixture project with OpenAPI, content and an engine).
