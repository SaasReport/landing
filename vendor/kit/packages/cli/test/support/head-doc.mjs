// Test helper: a fixture repository with a vendored snapshot gets its kit head from a file, never from the registry's live URL
// (vendor-stale reads KIT_HEAD_DOC only under the test runner, packages/cli/src/vendor-stale.js). The head is the vendored commit itself:
// the snapshot is current, so the check passes on the bound and not on the network.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTempDir } from "../../../core/test/support/temp.mjs";

// made at import (removed when the test process ends), never inside a hook: a hook-scoped directory is gone before the test reads it
const dir = fileTempDir("kit-head-");
/** Point KIT_HEAD_DOC (this process and every CLI it spawns) at a kit.kit-head.v1 document whose head is `commit`. */
export function useHeadDoc(commit, date = new Date().toISOString()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${commit.slice(0, 12)}.json`);
  writeFileSync(file, `${JSON.stringify({ v: 1, repository: "https://github.com/SaasReport/kit", ref: "main", sha: commit, date, recent: [{ sha: commit, date }] }, null, 2)}\n`);
  process.env.KIT_HEAD_DOC = file;
  return file;
}
