// t=0 dependency gate (review of e865a625, 7fa30afa): the staleness class podcast-behind-schedule is a module until `kit check staleness` exists on main.
// The day packages/cli/src/staleness.js lands, this fails until its CLASSES (read by importing the module, never by matching its text) list the class.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PODCAST_BEHIND, podcastBehindSchedule } from "../src/podcast-staleness.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

test("once kit check staleness exists, its CLASSES list podcast-behind-schedule", async () => {
  assert.equal(PODCAST_BEHIND, "podcast-behind-schedule");
  assert.equal(typeof podcastBehindSchedule, "function", "until then the class is a module with its tests");
  const f = `${SRC}staleness.js`;
  if (!existsSync(f)) return;
  const m = await import(pathToFileURL(f).href);
  assert.ok(m.CLASSES, "staleness.js exports CLASSES");
  const ids = [...(Array.isArray(m.CLASSES) ? m.CLASSES : Object.keys(m.CLASSES))].map((c) => (typeof c === "string" ? c : c?.id));
  assert.ok(ids.includes(PODCAST_BEHIND), `CLASSES lists ${PODCAST_BEHIND}: ${ids.join(", ")}`);
});
