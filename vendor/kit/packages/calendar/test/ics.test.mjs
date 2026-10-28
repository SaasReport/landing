/* marketIcs(): RFC 5545 feeds for every market profile. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../src/index.js";
import * as M from "../src/markets.js";
import { marketIcs, hasMarketFeed, foldLine, escapeText } from "../src/ics.js";

import { enc, unfold, events, assertValidIcs } from "./ics-assert.mjs";
export { assertValidIcs };

test("VERSION of ics.js equals package.json and index.js", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(C.VERSION, pkg.version);
  assert.match(marketIcs("uk", { from: 2027 }), new RegExp(`PRODID:.*${pkg.version.replace(/\./g, "\\.")}`));
});

test("every market's feed is valid RFC 5545 (CRLF, 75-octet folding, required properties, unique UIDs)", () => {
  for (const id of M.MARKET_IDS) for (const locale of ["en", "ar"]) {
    const ev = assertValidIcs(marketIcs(id, { from: 2026, to: 2028, locale, weekends: true, uidPrefix: "site-", domain: "example.org" }), `${id}/${locale}`);
    assert.ok(ev.length > 0, `${id}: events`);
  }
});

test("folding never splits a UTF-8 character and round-trips", () => {
  const line = `SUMMARY:${"عيد الفطر ".repeat(20)}`;
  const f = foldLine(line);
  for (const l of f.split("\r\n")) assert.ok(enc.encode(l).length <= 75);
  assert.equal(f.replace(/\r\n /g, ""), line);
  assert.equal(foldLine("A".repeat(75)), "A".repeat(75));
  assert.equal(foldLine("A".repeat(76)), `${"A".repeat(75)}\r\n A`);
  assert.equal(escapeText("a,b;c\\d\ne"), String.raw`a\,b\;c\\d\ne`);
});

test("UIDs are stable across runs and clocks, and the body is deterministic", () => {
  const a = marketIcs("sa", { from: 2027, to: 2028, uidPrefix: "x-", domain: "example.org", now: new Date("2026-01-01") });
  const b = marketIcs("sa", { from: 2027, to: 2028, uidPrefix: "x-", domain: "example.org", now: new Date("2027-06-30") });
  assert.equal(a, b);
  const uids = events(a).map((e) => e.UID);
  assert.ok(uids.every((u) => /^x-sa-[a-z0-9-]+@example\.org$/.test(u)), uids.join(" "));
  // Hijri holidays are keyed by Hijri year, rule and day index (not by date), so an announced date updates the same event.
  assert.ok(uids.includes("x-sa-h1448-eid-al-fitr-1@example.org"));
  // A smaller range yields the same UIDs for the same events.
  const c = events(marketIcs("sa", { from: 2027, to: 2027, uidPrefix: "x-", domain: "example.org" })).map((e) => e.UID);
  assert.ok(c.every((u) => uids.includes(u)));
});

test("predicted Islamic holidays are TENTATIVE and labelled expected; fixed ones CONFIRMED", () => {
  const ev = events(marketIcs("ae", { from: 2027 }));
  const fitr = ev.find((e) => /^Eid al-Fitr/.test(e.SUMMARY));
  assert.equal(fitr.STATUS, "TENTATIVE");
  assert.match(fitr.SUMMARY, /\(expected\)$/);
  assert.match(fitr.CATEGORIES, /EXPECTED/);
  assert.match(fitr.DESCRIPTION, /moon sighting or official announcement/);
  const ny = ev.find((e) => e.SUMMARY === "New Year's Day");
  assert.equal(ny.STATUS, "CONFIRMED"); assert.match(ny.CATEGORIES, /OFFICIAL/);
  // Arabic labels
  const ar = events(marketIcs("ae", { from: 2027, locale: "ar" })).find((e) => e.SUMMARY.startsWith("عيد الفطر"));
  assert.match(ar.SUMMARY, /\(متوقع\)$/); assert.equal(ar.STATUS, "TENTATIVE");
  // Gregorian-only markets carry no tentative events.
  assert.ok(events(marketIcs("uk", { from: 2027 })).every((e) => e.STATUS === "CONFIRMED"));
});

test("announced dates replace predictions: same UID, CONFIRMED, SEQUENCE raised", () => {
  M.registerMarket({ id: "ics-test", name: { en: "Test" }, weekend: [5, 6], timezone: "Asia/Dubai", holidays: [M.rules.hijri("eid-al-fitr", 10, 1, { days: 2 })] });
  const before = events(marketIcs("ics-test", { from: 2027 }));
  M.registerOfficial("ics-test", { 1448: { "eid-al-fitr": ["2027-03-10", "2027-03-11"] } });
  const after = events(marketIcs("ics-test", { from: 2027 }));
  assert.deepEqual(before.map((e) => e.UID), after.map((e) => e.UID));
  assert.ok(after.every((e) => e.STATUS === "CONFIRMED" && e.SEQUENCE === "1"));
  assert.ok(before.every((e) => e.STATUS === "TENTATIVE" && e.SEQUENCE === "0"));
});

test("weekends: weekly all-day RRULE events, only when asked", () => {
  assert.ok(!marketIcs("sa", { from: 2027 }).includes("RRULE"));
  const w = events(marketIcs("sa", { from: 2027, weekends: true })).filter((e) => e.CATEGORIES === "WEEKEND");
  assert.equal(w.length, 1);
  assert.equal(w[0].RRULE, "FREQ=WEEKLY;BYDAY=FR,SA;UNTIL=20271231");
  assert.equal(w[0]["DTSTART;VALUE=DATE"], "20270101"); // Friday 1 January 2027
});

test("calendar properties: floating all-day dates, X-WR-TIMEZONE, name, refresh, URL", () => {
  const t = unfold(marketIcs("us", { from: 2027, name: "Fed\; holidays", url: "https://example.org/calendar/us.ics", refresh: "PT12H" }));
  assert.match(t, /\r\nX-WR-CALNAME:Fed[\\]; holidays\r\n/);
  assert.match(t, /\r\nX-WR-TIMEZONE:America\/New_York\r\n/);
  assert.match(t, /\r\nREFRESH-INTERVAL;VALUE=DURATION:PT12H\r\nX-PUBLISHED-TTL:PT12H\r\n/);
  assert.match(t, /\r\nURL;VALUE=URI:https:\/\/example\.org\/calendar\/us\.ics\r\n/);
  assert.ok(!/DTSTART:\d{8}T/.test(t), "no timed events");
  assert.match(unfold(marketIcs("uk", { from: 2027 })), /X-WR-CALNAME:United Kingdom \(England and Wales\) holidays/);
});

test("errors: unknown market, bad range, bad prefix", () => {
  assert.throws(() => marketIcs("zz"), { code: "unknown_market" });
  assert.equal(hasMarketFeed("zz"), false); assert.equal(hasMarketFeed("sa"), true);
  assert.throws(() => marketIcs("sa", { from: 2030, to: 2027 }), { code: "invalid_range" });
  assert.throws(() => marketIcs("sa", { from: 2020, to: 2035 }), { code: "invalid_range" });
  assert.throws(() => marketIcs("sa", { from: "2027-02-30" }), { code: "invalid_range" });
  assert.throws(() => marketIcs("sa", { uidPrefix: "bad prefix" }), { code: "invalid_option" });
  // ISO date ranges work too.
  const ev = events(marketIcs("uk", { from: "2027-12-01", to: "2027-12-31" }));
  assert.deepEqual(ev.map((e) => e["DTSTART;VALUE=DATE"]), ["20271225", "20271226", "20271227", "20271228"]);
});
