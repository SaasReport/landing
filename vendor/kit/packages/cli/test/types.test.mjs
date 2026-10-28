// Every package that ships type declarations declares everything it exports at runtime: each name of its main
// entry point appears in its .d.ts (as a function, const, class, type or re-export), and @saasreport/site's Tokens
// declares every colour token and derived role the theme reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));

/** The names a .d.ts declares as exports. */
export function declaredExports(dts) {
  const names = new Set([...dts.matchAll(/export\s+(?:declare\s+)?(?:function|const|let|var|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const m of dts.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) for (const x of m[1].split(",")) { const k = x.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop(); if (k) names.add(k); }
  return names;
}

const typed = readdirSync(PACKAGES).filter((n) => existsSync(join(PACKAGES, n, "package.json")))
  .map((n) => ({ n, pkg: JSON.parse(readFileSync(join(PACKAGES, n, "package.json"), "utf8")) })).filter(({ pkg }) => pkg.types);

for (const { n, pkg } of typed) {
  test(`@saasreport/${n}: every runtime export of the main entry is declared in ${pkg.types}`, async () => {
    const entry = pkg.exports?.["."];
    const file = typeof entry === "string" ? entry : entry?.import || entry?.default || pkg.main;
    const mod = await import(join(PACKAGES, n, file));
    const declared = declaredExports(readFileSync(join(PACKAGES, n, pkg.types), "utf8"));
    assert.deepEqual(Object.keys(mod).filter((k) => k !== "default" && !declared.has(k)), [], `declare these in ${pkg.types}`);
  });
}

test("@saasreport/site: Tokens declares every colour token and every derived role", async () => {
  const { DEFAULT_TOKENS, derivedColors } = await import(join(PACKAGES, "site/src/index.js"));
  const dts = readFileSync(join(PACKAGES, "site/src/index.d.ts"), "utf8");
  const color = dts.match(/export interface Tokens \{\s*color: \{([\s\S]*?)\};/)?.[1] || "";
  const keys = new Set([...color.matchAll(/(\w+)\??:/g)].map((m) => m[1]));
  const want = [...Object.keys(DEFAULT_TOKENS.color), ...Object.keys(derivedColors(DEFAULT_TOKENS.color))];
  assert.deepEqual(want.filter((k) => !keys.has(k)), []);
});
