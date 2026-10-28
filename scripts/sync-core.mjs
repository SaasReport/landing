// Copies the registries and the pure engine from a checkout of SaasReport/core into vendor/core and records the commit.
// vendor/core is generated: never edit it by hand (`npm run check` fails when it differs from SOURCE.json's files).
import { cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileHashes } from "./lib.mjs";

const src = resolve(process.argv[2] ?? "../core");
const dest = "vendor/core";
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const d of ["registry", "schemas", "src"]) cpSync(join(src, d), join(dest, d), { recursive: true });
const commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(join(dest, "SOURCE.json"), JSON.stringify({ repo: "SaasReport/core", commit, files: fileHashes(dest) }, null, 2) + "\n");
console.log(`vendored SaasReport/core@${commit.slice(0, 12)}`);
