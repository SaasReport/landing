// Site config is validated against JSON Schemas (validateSchema), and the terminal's notify view renders a project's own
// scenarios from data.notify (schema/terminal-notify.schema.json) instead of scenarios written into the template.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSchema, assertSchema, checkAssets, renderAsset, ASSET_SCHEMAS } from "../src/index.js";

test("validateSchema: types, enums, patterns, required, additionalProperties, $ref, anyOf/oneOf, bounds", () => {
  const schema = {
    $defs: { tone: { enum: ["ok", "warn"] } },
    type: "object", additionalProperties: false, required: ["id", "items"],
    properties: {
      id: { type: "string", pattern: "^[a-z]+$", minLength: 2, maxLength: 5 },
      n: { type: ["integer", "null"], minimum: 0, maximum: 9 },
      items: { type: "array", minItems: 1, uniqueItems: true, items: { type: "object", required: ["tone"], properties: { tone: { $ref: "#/$defs/tone" } } } },
      either: { anyOf: [{ type: "string" }, { type: "number" }] },
      one: { oneOf: [{ type: "string" }, { const: "x" }] },
    },
  };
  assert.deepEqual(validateSchema({ id: "abc", n: null, items: [{ tone: "ok" }], either: 3 }, schema), []);
  const bad = validateSchema({ id: "A", n: 12, items: [{ tone: "red" }, { tone: "red" }], extra: 1, either: true, one: "x" }, schema).map((p) => `${p.path} ${p.message}`);
  for (const m of [/^\/id must match \/\^\[a-z\]\+\$\//, /^\/id must have at least 2 characters/, /^\/n must be ≤ 9/, /^\/items items must be unique/, /^\/items\/0\/tone must be one of/, /^\/extra unknown property/, /^\/either must match at least one of 2/, /^\/one must match exactly one of 2 alternatives \(matches 2\)/])
    assert.ok(bad.some((b) => m.test(b)), `${m} in ${bad.join(" | ")}`);
  assert.throws(() => assertSchema({}, schema, "demo"), /demo does not match[\s\S]*\/id: is required/);
});

// Every string the shell and the views read: "x" (a recursive stand-in), lists empty.
const any = () => new Proxy({}, { get: (_, k) => (k === Symbol.toPrimitive || k === "toString" ? () => "x" : k === "players" ? {} : ["events", "commands", "queries"].includes(k) ? [] : typeof k === "symbol" ? undefined : any()), has: () => true });
const base = { name: "X", url: "https://x.example/", root: "/", tz: "UTC", ns: { global: "X", key: "x" }, t: any(),
  locale: { code: "en", digits: "latin", dir: "ltr", lang: "en", intl: "en", numberIntl: "en", dateIntl: "en", calendar: "gregorian", digitChars: "0123456789", arrow: any() },
  color: { ok: "#0a0", warn: "#a80", err: "#a00", muted: "#666", accent: "#00a", ink: "#111", surface: "#fff", onInk: "#fff", onAccent: "#fff", onOk: "#fff", onWarn: "#fff", onErr: "#fff", onMuted: "#fff" } };
const notify = {
  channels: [{ key: "inapp", label: "Console" }, { key: "hook", label: "Webhook" }],
  scenarios: [{ key: "held", chip: "Held", event: "decision.held", tone: "warn", recipient: "Approver (demo)", icon: "!", title: "An action waits",
    body: "Answer by {date+1}.", rules: ["Approver role"], channels: ["inapp", "hook"], actions: [{ label: "Approve", done: "Approved", tone: "ok", title: "Approved", text: "Committed." }] }],
};
const cfg = (data) => ({ views: ["notify"], data: { order: ["notify"], players: [], cast: {}, logos: {}, logoDir: "/p/", icon: "/i.png", ...data }, strings: { en: any() } });

test("notify: the project's scenarios and channels come from data.notify, none of the built-in ones", () => {
  const js = renderAsset("terminal.js", cfg({ notify }), base, { code: "en" });
  assert.match(js, /"decision\.held"/);
  assert.match(js, /\[\{"key":"inapp","label":"Console"\}/);
  for (const ev of ["loan.installment.due", "payment.settled", "payment.refunded", "consent.expiring", "risk.fraud.suspected", "balance.low", "sukuk.subscription.closing"])
    assert.doesNotMatch(js, new RegExp(ev.replace(/\./g, "\\.")), ev);
  new Function(js); // parses
});

test("notify: the view has no scenarios of its own (no data.notify is a config problem, not a fallback)", () => {
  assert.throws(() => renderAsset("terminal.js", cfg({}), base, { code: "en" }), /d\.notify/);
  assert.ok(checkAssets({ "terminal.js": cfg({}) }, ["en"]).some((x) => /notify view needs data\.notify/.test(x)));
});

test("checkAssets validates data.notify against its schema", () => {
  assert.ok(ASSET_SCHEMAS["terminal.js#notify"].$id);
  assert.deepEqual(checkAssets({ "terminal.js": cfg({ notify }) }, ["en"]), []);
  const bad = structuredClone(notify); bad.scenarios[0].tone = "red"; bad.scenarios[0].channels = ["fax"]; delete bad.scenarios[0].title;
  const p = checkAssets({ "terminal.js": cfg({ notify: bad }) }, ["en"]);
  assert.ok(p.some((x) => /data\.notify\/scenarios\/0\/tone: must be one of/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /data\.notify\/scenarios\/0\/channels\/0: must be one of/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /data\.notify\/scenarios\/0\/title: is required/.test(x)), p.join("\n"));
  const off = checkAssets({ "terminal.js": { ...cfg({ notify }), views: ["sandbox"], data: { order: ["sandbox"], notify } } }, ["en"]);
  assert.ok(off.some((x) => /notify view is not among the views/.test(x)), off.join("\n"));
});
