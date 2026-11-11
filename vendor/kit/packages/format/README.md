# @saasreport/format

The one place the kit turns numbers into reader-facing text, and the scanner that proves it
([CONSTITUTION.md §7](../../docs/CONSTITUTION.md)). For `fa`: Persian digits (۰–۹), ٬ thousands, ٫ decimal, ٪ percent.
One dependency, `@saasreport/calendar/instant` (import-free; Solar Hijri dates by arithmetic, never ICU's Persian calendar), re-exported here as `formatInstant`, `formatJalali`, `jalaliFor`, `zonedDay` and inlined into the browser bundle; Workers, Node ≥ 20 and browsers. License: Apache-2.0.

```js
import { formatNumber, formatPercent, formatOrdinal, formatRange, formatTime, formatDate, digits, localizeText, localizeHtml, formatter } from "@saasreport/format";
formatNumber(1234567.5, "fa");        // "۱٬۲۳۴٬۵۶۷٫۵"
formatPercent(12.5, "fa");            // "۱۲٫۵٪"
formatOrdinal(3, "fa");               // "سوم"   ({ style: "numeric" } → "۳ام")
formatRange(1, 5, "fa");              // "۱ تا ۵"
formatTime("06:00", "fa");            // "۰۶:۰۰"
formatDate("2026-10-01", "en");                       // "October 1, 2026" (jalali/persian throw: use formatInstant)
formatInstant(new Date(), { locale: "fa-IR", calendar: "jalali", timeZone: "Asia/Tehran", dateStyle: "long" }); // Jalali by arithmetic, Latin digits
digits(1405, "fa");                   // "۱۴۰۵" (no grouping: years, counts)
localizeText("تسویه T+1 در 1404/12/28", "fa"); // "تسویه T+1 در ۱۴۰۴/۱۲/۲۸" (URLs and Latin identifiers kept)
localizeHtml(html, "fa");             // text and reader attributes; code, hrefs, data-* and data-digits="latin" kept
```

Digits are always mapped here, never left to a browser's ICU numbering system.

## Scanner (`@saasreport/format/scan`)

`scanDigits(source, { file })` → `[{ line, kind, where, match, context }]` for `.html`, `.svg`, `.md` and `.txt`:
every ASCII or Arabic-Indic digit a reader sees, and every «·» next to a Persian digit. `kit check digits` runs it over
the files declared under `digits` in `kit.canon.json`:

```json
"digits": {
  "locale": "fa",
  "files": ["site/**/*.html", "site/**/*.md", "site/**/*.svg"],
  "render": { "command": "node scripts/render-pages.mjs .digits", "dir": ".digits" },
  "exclude": [{ "files": "site/brand/players/SOURCES.md", "reason": "English provenance notes, not Persian copy" }]
}
```

Exempt: `<code>`, `<pre>`, `<kbd>`, `<samp>`, scripts, styles; URLs and non-reader attributes; Latin identifiers
(`saasreport-cal`, `ISO-4217`, `v1.2.0`, `T+1`); elements marked `data-digits="latin"` with a `data-digits-reason`.
