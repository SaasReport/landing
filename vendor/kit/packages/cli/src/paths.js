/** Where the CLI finds the starter template and the sibling packages (inside the kit repo or an installed copy). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/** templates/site: packaged next to the CLI (packages/cli/templates) or at the repo root. */
export function templateDir() {
  for (const p of [here("../templates/site/"), here("../../../templates/site/")]) if (existsSync(join(p, "kit.config.js"))) return p;
  throw new Error("cannot find the starter template (templates/site)");
}

/** The kit packages next to the CLI: [{ name: "@saasreport/core", dir }]. */
export function kitPackages() {
  const root = here("../../");
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => ({ name: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, dir }))
    .filter((p) => p.name?.startsWith("@saasreport/"));
}

export const CLI_VERSION = JSON.parse(readFileSync(here("../package.json"), "utf8")).version;
