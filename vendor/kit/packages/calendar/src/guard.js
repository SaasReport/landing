/**
 * Guards that keep ICU's Persian calendar out of code (Workers' ICU put 2026-10-03 on 12 Mehr; older Safari and
 * WebViews can be a day off). Solar Hijri comes from @saasreport/calendar's arithmetic (instant.js), never from Intl.
 *
 * 1. Runtime (the real guard): installIntlGuard() wraps Intl.DateTimeFormat, Intl.Locale and Date's toLocale*String
 *    so that any formatter or locale that RESOLVES to the Persian calendar (an explicit -u-ca-persian, an option
 *    { calendar }, or a fa/IR/AF default) is recorded and refused, however its tag was built. The kit's test suite
 *    installs it for every test file (test/intl-guard.setup.mjs); a site can do the same.
 * 2. Static (a tripwire for code no test runs): icuPersianUses(source, { html }) applies ICU_PERSIAN_RULES to the
 *    source with comments removed by a small lexer (strings, template literals and regex literals are kept) and JS
 *    escapes decoded, case-insensitively.
 */

/** The static rules. Written with ca[-_] and character classes so this file does not match itself. */
export const ICU_PERSIAN_RULES = Object.freeze([
  { id: "persian-tag", re: /ca[-_]pers[i]an/i },
  { id: "persian-option", re: /["'`]?calendar["'`]?\s*:\s*["'`]pers[i]an["'`]/i },
  { id: "persian-assignment", re: /calendar\s*=(?!=)\s*["'`]pers[i]an["'`]/i },
  { id: "persian-keyword-map", re: /\bjalali["'`]?\s*:\s*["'`]pers[i]an["'`]/i },
]);

const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse|\bin|\bof|\bvoid|\byield|\bawait)\s*$/;
/** JavaScript source with its comments blanked out (a lexer: quotes, template literals and regex literals are kept). */
export function stripComments(src) {
  const s = String(src);
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const end = s.indexOf("*/", i + 2); i = end < 0 ? s.length : end + 2; out += " "; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) { if (s[j] === "\\") j++; else if (c !== "`" && s[j] === "\n") break; j++; }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "/" && REGEX_BEFORE.test(out)) {
      let j = i + 1, cls = false;
      while (j < s.length && s[j] !== "\n") {
        if (s[j] === "\\") { j += 2; continue; }
        if (s[j] === "[") cls = true; else if (s[j] === "]") cls = false; else if (s[j] === "/" && !cls) break;
        j++;
      }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const decodeEscapes = (s) => s
  .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
/** The ids of the rules a source breaks. JS (default): comments removed; html: true removes <!-- --> comments only. */
export function icuPersianUses(src, { html = false } = {}) {
  const code = decodeEscapes(html ? String(src).replace(/<!--[\s\S]*?-->/g, "") : stripComments(src));
  return ICU_PERSIAN_RULES.filter((r) => r.re.test(code)).map((r) => r.id);
}

/* ------------------------------------------------------------------ runtime guard */
const KEY = Symbol.for("@saasreport/calendar/intl-guard");
/**
 * Wrap Intl.DateTimeFormat, Intl.Locale and Date.prototype.toLocale{,Date,Time}String on `scope` (default globalThis)
 * so that anything resolving to the Persian calendar is recorded in `violations` and throws. allow(fn) runs fn with
 * the guard open (only for tests that compare the arithmetic with ICU). Installing twice returns the first guard.
 */
export function installIntlGuard({ scope = globalThis, onViolation } = {}) {
  if (scope[KEY]) return scope[KEY];
  const Intl = scope.Intl, DTF = Intl.DateTimeFormat, Loc = Intl.Locale, DP = scope.Date.prototype;
  const original = { DateTimeFormat: DTF, Locale: Loc, toLocaleString: DP.toLocaleString, toLocaleDateString: DP.toLocaleDateString, toLocaleTimeString: DP.toLocaleTimeString };
  const violations = [];
  let open = 0;
  const refuse = (what, locales, options) => {
    if (open) return;
    const v = { what, locales, calendar: options?.calendar, stack: new Error().stack.split("\n").slice(3, 8).join("\n") };
    violations.push(v);
    if (onViolation) onViolation(v);
    throw new TypeError(`ICU Persian calendar refused (${what} ${JSON.stringify(locales)}): format Solar Hijri dates with @saasreport/calendar (formatJalali / formatInstant), never Intl's Persian calendar`);
  };
  const checkFormat = (f, locales, options, what) => { if (f.resolvedOptions().calendar === "persian") refuse(what, locales, options); return f; };
  const make = (args) => Reflect.construct(DTF, args);
  scope.Intl.DateTimeFormat = new Proxy(DTF, {
    construct: (t, args, nt) => checkFormat(Reflect.construct(t, args, nt === scope.Intl.DateTimeFormat ? t : nt), args[0], args[1], "Intl.DateTimeFormat"),
    apply: (t, self, args) => checkFormat(Reflect.apply(t, self, args), args[0], args[1], "Intl.DateTimeFormat"),
  });
  scope.Intl.Locale = new Proxy(Loc, {
    construct: (t, args, nt) => { const l = Reflect.construct(t, args, nt === scope.Intl.Locale ? t : nt); if (l.calendar === "persian") refuse("Intl.Locale", args[0], args[1]); return l; },
  });
  for (const m of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
    const fn = original[m];
    DP[m] = function (locales, options) { checkFormat(make([locales, options]), locales, options, `Date#${m}`); return fn.call(this, locales, options); };
  }
  const guard = {
    violations,
    allow(fn) { open++; try { return fn(); } finally { open--; } },
    restore() { Object.assign(scope.Intl, { DateTimeFormat: original.DateTimeFormat, Locale: original.Locale }); for (const m of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) DP[m] = original[m]; delete scope[KEY]; },
  };
  Object.defineProperty(scope, KEY, { value: guard, configurable: true });
  return guard;
}
