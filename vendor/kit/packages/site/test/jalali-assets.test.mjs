// The browser assets that show dates (status, statusboard, academy, the terminal's notify view) format through
// KitFormat.formatInstant: Solar Hijri by @saasreport/calendar's arithmetic in the reader's browser, never ICU's Persian
// calendar (older Safari and WebViews can be a day off). Rendered for a Persian site, each formatter is run in a vm with
// the classic KitFormat bundle and the Intl guard, across the Tehran midnight edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderAsset, createLocale } from "../src/index.js";
import { formatForBrowser } from "@saasreport/format/browser";
import { installIntlGuard } from "@saasreport/calendar/guard";

const any = () => new Proxy({}, { get: (_, k) => (k === Symbol.toPrimitive || k === "toString" ? () => "x" : k === "players" ? {} : ["events", "commands", "queries", "bar", "items", "list"].includes(k) ? [] : typeof k === "symbol" ? undefined : any()), has: () => true });
const fa = createLocale("fa", {}, {});
const base = { name: "X", url: "https://x.example/", root: "/", tz: "Asia/Tehran", ns: { global: "X", key: "x" }, t: any(), locale: fa,
  color: { ok: "#0a0", warn: "#a80", err: "#a00", muted: "#666", accent: "#00a", ink: "#111", surface: "#fff", onInk: "#fff", onAccent: "#fff", onOk: "#fff", onWarn: "#fff", onErr: "#fff", onMuted: "#fff" } };
const notify = { channels: [{ key: "inapp", label: "x" }], scenarios: [{ key: "k", chip: "x", event: "e.v", tone: "warn", recipient: "x", icon: "!", title: "x", body: "x", rules: [], channels: ["inapp"], actions: [] }] };
const cfg = (data = {}) => ({ views: ["notify"], data: { order: ["notify"], players: [], cast: {}, logos: {}, logoDir: "/p/", icon: "/i.png", notify, ...data }, strings: { fa: any() } });

test("the Persian locale's Intl date tags never resolve to ICU's Persian calendar", () => {
  assert.equal(fa.calendar, "jalali");
  for (const t of [fa.dateIntl, fa.dateIntlLatn]) {
    assert.match(t, /-u-ca-gregory/, t);
    assert.equal(new Intl.DateTimeFormat(t).resolvedOptions().calendar, "gregory", t);
  }
});

test("status, statusboard, academy and the terminal's notify view print 11 Mehr 1405 by arithmetic in the browser", () => {
  const ctx = vm.createContext({});
  const guard = installIntlGuard({ scope: vm.runInContext("globalThis", ctx) });
  vm.runInContext(formatForBrowser(), ctx);
  const seen = [];
  for (const name of ["status.js", "statusboard.js", "academy.js", "terminal.js"]) {
    const js = renderAsset(name, cfg(), base, { code: "fa" });
    assert.doesNotMatch(js, /new Intl\.DateTimeFormat\([^)]*dateIntl|ca-persian/i, name);
    const calls = [...js.matchAll(/KitFormat\.formatInstant\((?:new Date\([^;]*?\)), (\{ locale: [^}]*\})\)/g)].map((m) => m[1]);
    assert.ok(calls.length, `${name} formats dates with KitFormat.formatInstant`);
    for (const opts of calls) {
      assert.match(opts, /calendar: "jalali"/, name);
      const out = vm.runInContext(`KitFormat.digits(KitFormat.formatInstant(new Date("2026-10-02T21:00:00Z"), ${opts}), "persian")`, ctx);
      assert.match(out, /۱۱ مهر/, `${name}: ${out}`);
      seen.push(name);
    }
  }
  assert.deepEqual([...new Set(seen)].sort(), ["academy.js", "status.js", "statusboard.js", "terminal.js"]);
  assert.equal(guard.violations.length, 0);
});
