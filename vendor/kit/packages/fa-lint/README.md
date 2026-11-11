# @saasreport/fa-lint

The mechanical Persian check of the kit ([docs/PERSIAN.md](../../docs/PERSIAN.md)). It has no dependencies and runs in
Workers, Node ≥ 20 and browsers.

- `rules/kit.fa-rules.json` (schema `fa-rules`, kit.fa-rules.v1): 50 rules. They cover typography (ZWNJ, ی/ک, digits,
  punctuation, bidi) and every owner correction of wording, word order and government. Each rule carries the examples
  that must fail and must pass, and the tests run them all.
- `normalize(text)`: one spelling before matching. Parts are ported from Virastar (MIT, see NOTICE).
- `persianLinter({ packs, classes })` → `{ lint(text, { register }), fix(text) }`, and `checkExamples(packs)`.
- `segments(file, src, { literals })`: the Persian copy of JSON, JS, Markdown, HTML and text files, with lines and offsets.
- `projectGate({ config, packs })`: the gate before TTS built from a project's own persian.config.json (the same findings as `kit check persian`); `checkScript(lines)` with the kit's pack alone.
- `safeFix(raw, linter)`: autofix with markup, URLs, paths and code masked; refuses when anything but text would change.

```js
import { persianLinter } from "@saasreport/fa-lint";
const l = persianLinter({ classes: { brand: ["اکمی"] } });
l.lint("اکمی پروتکل");   // [{ rule: "fa-brand-before-head", severity: "error", suggestion: "پروتکل اکمی", … }]
```

The CLI uses it for `kit check persian` (a step of `kit check canon`), `kit check fa-review` and `kit persian fix|review|approve|baseline`.
