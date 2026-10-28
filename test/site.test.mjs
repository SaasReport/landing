import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { problems } from "../scripts/check.mjs";
import { contrastHundredths } from "../scripts/lib.mjs";

test("the repository passes its own check", () => assert.deepEqual(problems(), []));

test("copy may not contain a digit: figures come from the engine", () => {
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync("schemas/site.schema.json", "utf8")));
  const content = JSON.parse(readFileSync("content/site.json", "utf8"));
  assert.equal(validate(content), true);
  content.hero.headline = "Save 40% of your time";
  assert.equal(validate(content), false);
});

test("contrast: black on white is 21:1, a mid grey pair fails AA", () => {
  assert.equal(contrastHundredths("#000000", "#ffffff"), 2100);
  assert.ok(contrastHundredths("#888888", "#ffffff") < 450);
});

test("the build is reproducible for a fixed date", async () => {
  const { execFileSync } = await import("node:child_process");
  const run = () => { execFileSync("node", ["scripts/build.mjs"], { env: { ...process.env, SOURCE_DATE_EPOCH: "1800000000" } }); return readFileSync("dist/index.html", "utf8"); };
  assert.equal(run(), run());
});

test("the page survives Cloudflare's Rocket Loader and email obfuscation, which are on for the zone", async () => {
  const { execFileSync } = await import("node:child_process");
  execFileSync("node", ["scripts/build.mjs"]);
  const html = readFileSync("dist/index.html", "utf8");
  assert.match(html, /<script type="module" src="app\.js" data-cfasync="false">/, "Rocket Loader must skip the module script");
  const off = html.indexOf("<!--email_off-->"), on = html.indexOf("<!--/email_off-->");
  assert.ok(off !== -1 && on > off, "email obfuscation must be off around the page");
  for (const m of html.matchAll(/mailto:/g)) assert.ok(m.index > off && m.index < on, "every mailto sits inside the email_off block");
});
