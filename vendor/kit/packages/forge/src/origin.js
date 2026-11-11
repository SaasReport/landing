// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Iran Open Finance. Not derived from upstream Forge.
/** Where the port came from (ORIGIN.json: upstream repository, path, commit; every upstream file ported or not, with
 * its sha256 at the origin commit) and the package itself. scripts/upstream-sync.mjs reads ORIGIN to report what
 * upstream changed since; nothing is ever applied automatically. */
import { readFileSync } from "node:fs";

export const ORIGIN = JSON.parse(readFileSync(new URL("../ORIGIN.json", import.meta.url), "utf8"));
export const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
