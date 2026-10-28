import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/markets.js";
import { isValidTimeZone } from "../src/time.js";

const EXPECTED_TZ = {
  sa: "Asia/Riyadh", ae: "Asia/Dubai", bh: "Asia/Bahrain", qa: "Asia/Qatar", kw: "Asia/Kuwait", om: "Asia/Muscat",
  my: "Asia/Kuala_Lumpur", id: "Asia/Jakarta", pk: "Asia/Karachi", tr: "Europe/Istanbul", uk: "Europe/London",
  us: "America/New_York", eu: "Europe/Berlin", ir: "Asia/Tehran", "ir:government": "Asia/Tehran", "ir:market": "Asia/Tehran",
};

test("profiles: default IANA time zones; the legacy `timezone` field is unchanged", () => {
  const builtin = M.markets().filter((m) => m.id in EXPECTED_TZ);
  assert.equal(builtin.length, 16);
  for (const m of builtin) {
    assert.equal(m.timeZone, EXPECTED_TZ[m.id], m.id);
    assert.equal(M.marketTimeZone(m.id), EXPECTED_TZ[m.id]);
    assert.equal(M.MARKET_TIME_ZONES[m.id], EXPECTED_TZ[m.id]);
    assert.ok(isValidTimeZone(m.timeZone), m.id);
    if (m.id !== "eu") assert.equal(m.timezone, m.timeZone, `${m.id}: legacy field equals the new one`);
  }
  assert.equal(M.market("eu").timezone, "Europe/Frankfurt", "legacy value kept as it was");
  // summary() keeps its shape
  assert.deepEqual(Object.keys(M.summary()[0]), ["id", "name", "weekend", "status", "hijri", "holidays", "settlement", "sources"]);
});

test("holiday packs: one per profile, versioned, with sources, checked dates and coverage", () => {
  const packs = M.holidayPacks();
  assert.deepEqual(packs.map((p) => p.id), M.MARKET_IDS);
  for (const p of packs.filter((x) => x.id in EXPECTED_TZ)) {
    assert.match(p.dataVersion, /^[a-z]+-\d{4}\.\d{2}\.\d{2}$/, p.id);
    assert.equal(M.market(p.id).dataVersion, p.dataVersion);
    assert.ok(p.coverage.from <= 2026 && p.coverage.to >= 2030 && p.coverage.basis.length, p.id);
    assert.equal(p.timeZone, EXPECTED_TZ[p.id]);
    for (const u of p.sourceUrls) assert.match(u, /^https:\/\//, p.id);
    for (const h of p.holidays) {
      assert.ok(h.id && h.kind && h.title, `${p.id} ${h.id}`);
      if (/^https:/.test(h.source || "")) assert.equal(h.checked, "2026-09-30", `${p.id} ${h.id}`);
      else assert.equal(h.checked, null, `${p.id} ${h.id}: nothing read, nothing claimed`);
    }
    if (p.status !== "unverified") assert.ok(p.pack === "iran" || p.sourceUrls.length > 0, p.id);
  }
  const uk = M.holidayPack("uk");
  assert.equal(uk.dataVersion, "uk-2026.09.30");
  assert.equal(uk.checked, "2026-09-30");
  assert.ok(uk.sourceUrls.includes("https://www.gov.uk/bank-holidays.json"));
  assert.deepEqual([uk.coverage.from, uk.coverage.to], [1900, 2100]);
  assert.ok(uk.holidays.every((h) => h.predicted === false));
  const sa = M.holidayPack("sa");
  assert.equal(sa.holidays.find((h) => h.id === "eid-al-fitr").predicted, true);
  assert.equal(sa.holidays.find((h) => h.id === "founding-day").since, "2022-01-27");
  const qa = M.holidayPack("qa");
  assert.equal(qa.status, "unverified");
  assert.deepEqual(qa.sourceUrls, []);
  assert.ok(qa.holidays.every((h) => h.checked === null && h.source === null));
  // Iran: one pack shared by three profiles
  for (const id of ["ir", "ir:government", "ir:market"]) {
    const p = M.holidayPack(id);
    assert.equal(p.dataVersion, "iran-2026.10.01");
    assert.equal(p.pack, "iran");
    assert.equal(p.holidays.filter((h) => h.kind === "jalali").length, 10);
    assert.equal(p.holidays.filter((h) => h.kind === "hijri").length, 17);
    assert.ok(p.holidays.filter((h) => h.kind === "hijri").every((h) => h.predicted));
    assert.deepEqual([p.coverage.from, p.coverage.to], [1922, 2100]);
  }
  assert.equal(M.IRAN_DATA_VERSION, "iran-2026.10.01");
});

test("holiday packs are deterministic and do not change yearHolidays output", () => {
  assert.equal(JSON.stringify(M.holidayPacks()), JSON.stringify(M.holidayPacks()));
  const h = M.yearHolidays("uk", 2026)[0];
  assert.deepEqual(Object.keys(h), ["date", "iso", "id", "title", "predicted", "source", "profile"]);
  const prov = M.holidayProvenance(h);
  assert.deepEqual(prov, { profile: "uk", dataVersion: "uk-2026.09.30", source: "https://www.gov.uk/bank-holidays.json", checked: "2026-09-30", predicted: false, official: false });
  const eid = M.yearHolidays("ae", 2026).find((x) => x.id === "eid-al-fitr");
  assert.equal(M.holidayProvenance(eid).predicted, true);
  const ir = M.yearHolidays("ir", 2026)[0];
  assert.deepEqual([M.holidayProvenance(ir).dataVersion, M.holidayProvenance(ir).checked], ["iran-2026.10.01", null]);
  // registered profiles: unversioned unless they say otherwise; announced years are listed
  M.registerMarket({ id: "pack-test", weekend: [6, 0], holidays: [M.rules.hijri("eid-al-fitr", 10, 1, { source: "https://example.org/list", checked: "2026-01-02" })], dataVersion: "pack-test-2026.01.02" });
  M.registerOfficial("pack-test", { 1448: { "eid-al-fitr": ["2027-03-10"] } });
  const p = M.holidayPack("pack-test");
  assert.equal(p.dataVersion, "pack-test-2026.01.02");
  assert.equal(p.holidays[0].checked, "2026-01-02");
  assert.deepEqual(p.official, [1448]);
  M.registerMarket({ id: "pack-test-2" });
  assert.equal(M.holidayPack("pack-test-2").dataVersion, "pack-test-2-unversioned");
  assert.equal(M.holidayPack("pack-test-2").timeZone, "UTC");
});
