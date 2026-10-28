import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialAuthority } from "../src/release/credential-authority.js";

const workers = [{ name: "saasreport-web", wrangler: "wrangler.toml" }, { name: "saasreport-invites", wrangler: "workers/invites/wrangler.toml" }];
const doc = () => ({ project: "saasreport", environment: "production",
  owner: { secret: "OPS_NOTIFY_TO", targets: [] },
  generated_secrets: ["DEVELOPER_KEY_PEPPER"],
  secrets: [
    { name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml" },
    { name: "DEVELOPER_KEY_PEPPER", wrangler: "workers/invites/wrangler.toml" },
    { name: "GEMINI_API_KEY", wrangler: "wrangler.toml" }
  ],
  optional_secrets: [{ name: "PODCAST_ADMIN_TOKEN", wrangler: "wrangler.toml" }] });
const plan = () => [
  { name: "DEVELOPER_KEY_PEPPER", wrangler: "wrangler.toml", env: "" },
  { name: "DEVELOPER_KEY_PEPPER", wrangler: "workers/invites/wrangler.toml", env: "" },
  { name: "GEMINI_API_KEY", wrangler: "wrangler.toml", env: "" },
  { name: "PODCAST_ADMIN_TOKEN", wrangler: "wrangler.toml", env: "", optional: true }
];

test("T0 one release-derived identity includes all physical Worker consumers without material", () => {
  const a = credentialAuthority(doc(), plan(), workers);
  assert.equal(a.length, 3);
  const pepper = a.find(x => x.name === "DEVELOPER_KEY_PEPPER");
  assert.equal(pepper.lifecycle, "daemon");
  assert.equal(pepper.principal, "release-daemon");
  assert.equal(pepper.consumers.length, 2);
  assert.equal(pepper.id, "urn:saasreport:credential:saasreport:production:DEVELOPER_KEY_PEPPER");
  assert.equal(a.find(x => x.name === "GEMINI_API_KEY").lifecycle, "provider");
  assert.equal(a.find(x => x.name === "PODCAST_ADMIN_TOKEN").lifecycle, "optional-provider");
  assert.equal(JSON.stringify(a).includes("secret_text"), false, "no false claim that Worker secret existence proves shared material");
  assert.ok(Object.isFrozen(a) && Object.isFrozen(pepper.consumers));
});
test("T0 denies undeclared providers, duplicate physical bindings, and wrong Worker", () => {
  const cases = [
    [doc(), [...plan(), { name: "GEMINI_API_KEY", wrangler: "wrangler.toml" }], /repeated runtime binding/],
    [{ ...doc(), secrets: [...doc().secrets, { name: "GEMINI_API_KEY", wrangler: "wrangler.toml" }] }, plan(), /duplicate or conflicting/],
    [{ ...doc(), secrets: [...doc().secrets, { name: "GEMINI_API_KEY", wrangler: "fake.toml" }] }, plan(), /undeployed/],
    [doc(), plan().filter(x => x.name !== "GEMINI_API_KEY"), /orphan credential/],
    [doc(), [...plan(), { name: "UNDECLARED", wrangler: "wrangler.toml" }], /orphan|undeclared/]
  ];
  for (const [d,p,reason] of cases) assert.throws(() => credentialAuthority(d,p,workers), reason);
});
test("T0 daemon and provider cannot acquire a second owner or fallback lifecycle", () => {
  const d = doc();
  d.optional_secrets.push({ name: "GEMINI_API_KEY", wrangler: "workers/invites/wrangler.toml" });
  assert.throws(() => credentialAuthority(d, plan(), workers), /multiple lifecycle owners/);
  const x = doc();
  x.generated_secrets.push("GEMINI_API_KEY");
  assert.throws(() => credentialAuthority(x, plan(), workers), /undeclared or duplicate daemon/);
  const y = doc(); y.owner.targets.push({ name: "GEMINI_API_KEY" });
  assert.throws(() => credentialAuthority(y,plan(),workers), /owner address/);
  const z = doc(); z.generated_secrets.push("DEVELOPER_KEY_PEPPER");
  assert.throws(() => credentialAuthority(z,plan(),workers), /duplicate daemon/);
});
test("T0 optional status is not silently changed in the derived release plan", () => {
  const p = plan(); p.find(x=>x.name==="PODCAST_ADMIN_TOKEN").optional=false;
  assert.throws(()=>credentialAuthority(doc(),p,workers),/optional\/required binding drift/);
});
