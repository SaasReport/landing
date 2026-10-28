/**
 * What the comms-engine Worker needs from the config at run time: its names, the email shell per locale
 * (direction, language, fonts) and the copyright years to compute at send time.
 */
import { resolveConfig } from "./config.js";

import { digits } from "@saasreport/format";
import { jalaliFor } from "@saasreport/calendar/instant";

// Intl numbering-system names → @saasreport/format digit sets (the kit's one formatter, CONSTITUTION.md §7).
const NUMERALS = { latn: "latin", arabext: "persian", arab: "arabic" };

/**
 * Copyright-year params for the moment `now`: { [param]: digits } for each { calendar, numerals } definition
 * (calendar: gregory | jalali | islamic-umalqura | …; numerals: latn | arabext | arab), in `timeZone`.
 * The Solar Hijri year is @saasreport/calendar's arithmetic ("persian" is read as "jalali"), never ICU's Persian calendar.
 */
export function copyrightYears(defs, timeZone = "UTC", now = new Date()) {
  const out = {};
  for (const [param, { calendar = "gregory", numerals = "latn" }] of Object.entries(defs)) {
    const y = calendar === "jalali" || calendar === "persian"
      ? String(jalaliFor(now, timeZone).jy)
      : new Intl.DateTimeFormat(`en-u-ca-${calendar}-nu-latn`, { year: "numeric", timeZone }).format(now).replace(/\D/g, "");
    out[param] = digits(y, NUMERALS[numerals] || "latin");
  }
  return out;
}

/** The engine runtime derived from a comms config (plain data, safe to build inside a Worker). */
export function engineRuntime(config) {
  const r = resolveConfig(config);
  const years = {};
  for (const loc of r.locales) Object.assign(years, loc.pack.years || {});
  Object.assign(years, r.years || {});
  const shells = {};
  for (const loc of r.locales) {
    shells[loc.tag] = {
      dir: loc.dir, lang: loc.lang, fontStack: loc.fonts.stack, fontFaces: loc.fonts.faces || [],
      background: r.colors.background, link: r.colors.accentText, cssPrefix: r.cssPrefix,
    };
  }
  const namePrefix = r.workers?.namePrefix || r.project;
  return {
    project: r.project,
    idPrefix: r.idPrefix,
    engineName: `${namePrefix}-comms-engine`,
    mailSenderName: `${namePrefix}-mail-sender`,
    timeZone: r.timeZone,
    years,
    shells,
    primaryLocale: r.primary.tag,
    site: r.site,
    ownerSecret: r.forms?.owner.secret || null,   // the engine secret with the owner's recipients (forms.owner.secret)
  };
}
