// Loaded with `node --import` before every test file of the kit (package.json "test"): any Intl formatter, Intl.Locale
// or Date#toLocale*String that resolves to ICU's Persian calendar is refused and fails the file, however its tag was
// built. Solar Hijri comes from @saasreport/calendar's arithmetic (src/instant.js); see src/guard.js.
import { installIntlGuard } from "../src/guard.js";

const guard = installIntlGuard();
process.on("exit", () => {
  if (!guard.violations.length) return;
  process.stderr.write(`\nICU Persian calendar used ${guard.violations.length}x (format Solar Hijri with @saasreport/calendar):\n${guard.violations.slice(0, 5).map((v) => `- ${v.what} ${JSON.stringify(v.locales)}\n${v.stack}`).join("\n")}\n`);
  process.exitCode = 1;
});
