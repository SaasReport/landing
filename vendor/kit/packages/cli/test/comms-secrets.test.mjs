// kit comms secrets: the deploy gate of form notifications (docs/FORMS.md). Must fail: a comms-engine Worker without the owner's
// recipients secret (OPS_NOTIFY_TO on 2026-10-13, absent from all four sites) and a config that declares forms with no owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/index.js";
import { fileTempDir } from "../../core/test/support/temp.mjs";

const root = fileTempDir("kit-comms-secrets-");
const CONFIG = (forms) => `export default { project: "saasreport", templates: [{ key: "contact" }]${forms ? `, forms: ${forms}` : ""} };\n`;
writeFileSync(join(root, "comms.config.js"), CONFIG(`{ owner: { template: "lead-alert", secret: "OPS_NOTIFY_TO", address: "info@saasreport.ai" } }`));
writeFileSync(join(root, "noowner.config.js"), CONFIG(null));
writeFileSync(join(root, "noforms.config.js"), `export default { project: "x", templates: [] };\n`);
writeFileSync(join(root, "kit.config.js"), `export default { site: { url: "https://x.example" }, events: { rsvp: true } };\n`);
writeFileSync(join(root, "forms.js"), `export const FORMS = { contact: {}, waitlist: {} };\n`);
writeFileSync(join(root, "covered.config.js"), `export default { project: "x", templates: [{ key: "contact" }, { key: "waitlist" }, { key: "event-rsvp" }], forms: { owner: { template: "lead-alert", secret: "OPS_NOTIFY_TO", address: "info@x.example" } } };\n`);

const run = async (args, names, code = 0, env = {}) => {
  const out = [];
  const calls = [];
  const rc = await main(["comms", "secrets", ...args], { cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env,
    exec: async (cmd, a) => { calls.push([cmd, ...a].join(" ")); return { code, stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))), stderr: "auth failed" }; } });
  return { rc, out: out.join("\n"), calls };
};

test("passes when the comms-engine Worker holds the owner's secret; names only, from the engine's wrangler.toml", async () => {
  const r = await run([], ["OPS_NOTIFY_TO", "OTHER"]);
  assert.equal(r.rc, 0, r.out);
  assert.deepEqual(r.calls, ["npx wrangler secret list --config workers/comms-engine/wrangler.toml"]);
  assert.match(r.out, /saasreport-comms-engine holds OPS_NOTIFY_TO/);
});

test("must fail: the engine lacks OPS_NOTIFY_TO (the 2026-10-13 state of every site)", async () => {
  const r = await run([], ["OTHER"]);
  assert.equal(r.rc, 1);
  assert.match(r.out, /saasreport-comms-engine lacks the secret OPS_NOTIFY_TO/);
});

test("must fail: forms declared with no owner; wrangler failing or answering nonsense is a failure, never a pass", async () => {
  assert.equal((await run(["--config", "noowner.config.js"], ["OPS_NOTIFY_TO"])).rc, 1);
  const down = await run([], [], 1);
  assert.equal(down.rc, 1); assert.match(down.out, /wrangler secret list failed/);
  const out = []; const rc = await main(["comms", "secrets"], { cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env: {}, exec: async () => ({ code: 0, stdout: "not json", stderr: "" }) });
  assert.equal(rc, 1);
  assert.equal((await run(["--config", "noforms.config.js"], [])).rc, 0, "a project with no form needs no owner secret");
});

test("must fail at deploy: the deploy environment's OPS_NOTIFY_TO is not the project's own info@ (never printed); --require-value needs it", async () => {
  const ok = await run(["--require-value"], ["OPS_NOTIFY_TO"], 0, { OPS_NOTIFY_TO: "info@saasreport.ai" });
  assert.equal(ok.rc, 0, ok.out);
  const bad = await run([], ["OPS_NOTIFY_TO"], 0, { OPS_NOTIFY_TO: "someone@private.example" });
  assert.equal(bad.rc, 1);
  assert.match(bad.out, /not the project's own info@saasreport\.ai/);
  assert.ok(!bad.out.includes("someone@"), "the value is never printed");
  assert.equal((await run(["--require-value"], ["OPS_NOTIFY_TO"])).rc, 1, "a deploy job without the value cannot prove it");
});

test("kit comms check: every form the site posts (lead forms, the RSVP form) is declared in the comms config, or the build fails", async () => {
  const run = async (args) => { const out = []; const rc = await main(["comms", "check", ...args], { cwd: root, out: (s) => out.push(s), err: (s) => out.push(s), env: {} }); return { rc, out: out.join("\n") }; };
  const ok = await run(["--config", "covered.config.js", "--forms", "forms.js"]);
  assert.equal(ok.rc, 0, ok.out); assert.match(ok.out, /3 site form\(s\)/);
  // the real scenario: events.rsvp on, the default form "event-rsvp" not declared
  const gap = await run(["--config", "comms.config.js", "--forms", "forms.js"]);
  assert.equal(gap.rc, 1); assert.match(gap.out, /form "event-rsvp" is posted by the site but not declared/); assert.match(gap.out, /form "waitlist"/);
  assert.equal((await run(["--config", "covered.config.js", "--forms", "missing.js"])).rc, 1, "a forms module that cannot be loaded fails, never passes");
  // the RSVP form is the Worker's own `events.rsvpForm` (one shape, the kit Worker's normaliser): a renamed form is the one checked
  writeFileSync(join(root, "renamed.kit.config.js"), `export default { site: { url: "https://x.example" }, events: { rsvp: true, rsvpForm: "webinar-rsvp" } };\n`);
  const renamed = await run(["--config", "covered.config.js", "--site", "renamed.kit.config.js"]);
  assert.equal(renamed.rc, 1); assert.match(renamed.out, /form "webinar-rsvp" is posted by the site but not declared/);
  // a site config the Worker would refuse (no site.url) fails the check, never passes it
  writeFileSync(join(root, "broken.kit.config.js"), `export default { events: { rsvp: true } };\n`);
  assert.equal((await run(["--config", "covered.config.js", "--site", "broken.kit.config.js"])).rc, 1);
});
