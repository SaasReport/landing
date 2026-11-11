/** Reference data of the standards, as validated JSON (data/*.json), selected by jurisdiction profile. */
import { SimError } from "./errors.js";
import { validateIrrbbParams } from "./schemas.js";
import { buildTables } from "./tables.js";
import IRRBB_BASELINE from "../data/irrbb-basel-baseline.json" with { type: "json" };

import SACCR from "../data/saccr-supervisory.json" with { type: "json" };
import SMA from "../data/sma.json" with { type: "json" };
import LCR_HQLA from "../data/lcr-hqla.json" with { type: "json" };
import LCR_OUT from "../data/lcr-outflows.json" with { type: "json" };
import LCR_IN from "../data/lcr-inflows.json" with { type: "json" };
import NSFR_ASF from "../data/nsfr-asf.json" with { type: "json" };
import NSFR_RSF from "../data/nsfr-rsf.json" with { type: "json" };
import PROFILE_BASELINE from "../data/profile-baseline.json" with { type: "json" };

const IRRBB = { baseline: IRRBB_BASELINE };
export const TABLES = Object.freeze({ "saccr-supervisory": SACCR, sma: SMA, "lcr-hqla": LCR_HQLA, "lcr-outflows": LCR_OUT, "lcr-inflows": LCR_IN, "nsfr-asf": NSFR_ASF, "nsfr-rsf": NSFR_RSF });
export const PROFILES = Object.freeze({ baseline: PROFILE_BASELINE });

/** The factor tables of a profile (validated, overrides applied inside the standard's bounds). A registry can be passed to add profiles. */
export function loadTables(profile = "baseline", registry = { tables: TABLES, profiles: PROFILES }) {
  return buildTables(profile, registry);
}

/** Validate (always) and return the IRRBB parameter table of a profile; a table that fails its schema is a refusal. */
export function irrbbParams(profile = "baseline", registry = IRRBB) {
  const p = Object.hasOwn(registry, profile) ? registry[profile] : undefined;
  if (!p) throw new SimError("unknown-profile", `no IRRBB table for profile "${profile}" (known: ${Object.keys(registry).join(", ")})`, "profile");
  const problems = validateIrrbbParams(p);
  if (problems.length) throw new SimError("bad-table", `the IRRBB table of profile "${profile}" is off its schema: ${problems.join("; ")}`, "profile");
  return p;
}
