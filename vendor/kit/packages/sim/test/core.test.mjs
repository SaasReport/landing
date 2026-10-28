// Foundations: SHA-256 (FIPS 180-4 / NIST test vectors), canonical JSON, the seeded PRNG, BigInt money, calendar maths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, canonicalJson, hashOf, roundTo, createRng, money, SimError, parseDate, addMonths, daysBetween, yearFraction } from "../src/index.js";

test("sha256: NIST FIPS 180-4 example vectors (tolerance: exact)", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("canonical JSON: key order does not matter, non-JSON values are refused", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  for (const bad of [NaN, Infinity, () => 1, 10n]) assert.throws(() => canonicalJson({ x: bad }), SimError);
  assert.equal(roundTo(-1e-15), 0);
  assert.equal(Object.is(roundTo(-1e-15), 0), true);
});

test("prng: same seed, same stream (golden values), different seeds differ, state is explicit", () => {
  const a = createRng(42), b = createRng(42), c = createRng(43);
  const sa = Array.from({ length: 5 }, () => a.u32()), sb = Array.from({ length: 5 }, () => b.u32());
  assert.deepEqual(sa, sb);
  assert.deepEqual(sa, GOLDEN_U32_SEED_42);
  assert.notDeepEqual(sa, Array.from({ length: 5 }, () => c.u32()));
  for (const bad of [-1, 1.5, 2 ** 32, "1", NaN]) assert.throws(() => createRng(bad), /seed/);
});

test("prng: next() in [0,1), int(n) in range and roughly uniform, normal() has mean ~0 and sd ~1 (statistical, fixed seed)", () => {
  const r = createRng(7);
  let min = 1, max = 0;
  for (let i = 0; i < 10000; i++) { const x = r.next(); min = Math.min(min, x); max = Math.max(max, x); }
  assert.ok(min >= 0 && max < 1);
  const counts = new Array(6).fill(0);
  for (let i = 0; i < 60000; i++) counts[r.int(6)]++;
  counts.forEach((n) => assert.ok(Math.abs(n - 10000) < 400, `bucket ${n}`)); // 4 sigma of a binomial(60000, 1/6) is ~365
  let s = 0, s2 = 0;
  const N = 50000;
  for (let i = 0; i < N; i++) { const z = r.normal(); s += z; s2 += z * z; }
  assert.ok(Math.abs(s / N) < 0.03 && Math.abs(s2 / N - 1) < 0.04);
  assert.throws(() => r.int(0), SimError);
});

test("money: round-half-even division, exact weights in basis points, decimal parse and format", () => {
  const { divRound, mulBp, parseDecimal, formatMinor, toMinor, roundMinor, fromMinor } = money;
  assert.deepEqual([5n, 15n, 25n, -5n, -15n, -25n].map((n) => divRound(n, 10n)), [0n, 2n, 2n, 0n, -2n, -2n]);
  assert.equal(divRound(7n, 2n), 4n);
  assert.equal(divRound(-7n, 2n), -4n);
  assert.equal(mulBp(1000000n, 38), 3800n); // 0.38%
  assert.equal(mulBp(1n, 5000), 0n); // 0.5 rounds to even (0)
  assert.equal(mulBp(3n, 5000), 2n); // 1.5 rounds to even (2)
  assert.equal(parseDecimal("12.30", 2), 1230n);
  assert.throws(() => parseDecimal("12.345", 2), SimError);
  assert.equal(formatMinor(-1205n, 2), "-12.05");
  assert.equal(formatMinor(5n, 2), "0.05");
  assert.equal(toMinor("9007199254740993"), 9007199254740993n); // beyond 2^53 exact as a digit string
  assert.throws(() => toMinor(1.5), SimError);
  assert.throws(() => toMinor(2 ** 60), SimError);
  assert.equal(roundMinor(2.5), 2n);
  assert.equal(roundMinor(3.5), 4n);
  assert.equal(roundMinor(-2.5), -2n);
  assert.throws(() => roundMinor(Number.NaN), SimError);
  assert.throws(() => roundMinor(1e300), SimError);
  assert.equal(fromMinor(12n), 12);
  assert.equal(fromMinor(9007199254740993n), "9007199254740993");
  assert.equal(0.1 + 0.2 === 0.3, false); // the reason money is not a float
  assert.equal(toMinor(10) + toMinor(20), toMinor(30));
});

test("calendar: day numbers, month ends, ACT/360, ACT/365F, 30/360 (ISDA bond basis)", () => {
  assert.equal(daysBetween("1970-01-01", "1970-01-02"), 1);
  assert.equal(daysBetween("2000-03-01", "2000-02-28"), -2); // 2000 is a leap year
  assert.equal(daysBetween("2023-01-01", "2024-01-01"), 365);
  assert.equal(daysBetween("2024-01-01", "2025-01-01"), 366);
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2023-01-31", 1), "2023-02-28");
  assert.equal(addMonths("2024-03-31", -1), "2024-02-29");
  assert.equal(addMonths("2024-11-15", 3), "2025-02-15");
  assert.equal(yearFraction("ACT/360", "2024-01-01", "2024-07-01"), 182 / 360);
  assert.equal(yearFraction("ACT/365F", "2024-01-01", "2025-01-01"), 366 / 365);
  // 30/360 bond basis (ISDA 2006 s4.16(f)): 15 Jan to 31 Mar: d1 = 15 so d2 stays 31: (2 x 30 + 16) / 360
  assert.equal(yearFraction("30/360", "2007-01-15", "2007-03-31"), 76 / 360);
  // d1 = 31 becomes 30, then d2 = 31 becomes 30: 31 Jan to 31 Mar is exactly two months
  assert.equal(yearFraction("30/360", "2007-01-31", "2007-03-31"), 60 / 360);
  assert.throws(() => yearFraction("ACT/ACT", "2024-01-01", "2025-01-01"), SimError);
  for (const bad of ["2024-02-30", "2023-02-29", "2024-13-01", "24-01-01", "2024-1-1"]) assert.throws(() => parseDate(bad), SimError, bad);
});

const GOLDEN_U32_SEED_42 = [890322987, 2796912455, 4258306155, 1242540590, 1782340533];
