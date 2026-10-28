#!/usr/bin/env node
// Writes (or --check) schemas/widgets-spec.schema.json: kit.widgets-spec.v1 with the kit's plugins' fragments composed in.
// The file is a pure function of the kit's registry; `kit widgets schema` is the same thing from the CLI.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { composeSpecSchema, kitRegistry } from "../src/registry.js";

const file = fileURLToPath(new URL("../schemas/widgets-spec.schema.json", import.meta.url));
const next = `${JSON.stringify(composeSpecSchema(JSON.parse(readFileSync(file, "utf8")), kitRegistry()), null, 2)}\n`;
if (process.argv.includes("--check")) { if (readFileSync(file, "utf8") !== next) { console.error("widgets-spec.schema.json is stale: run node packages/widgets/scripts/compose-schema.mjs"); process.exit(1); } console.log("ok: fresh"); }
else { writeFileSync(file, next); console.log("wrote widgets-spec.schema.json"); }
