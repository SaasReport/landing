// Mutation testing of the engine source. Each mutant is a copy of src/ with ONE textual change to a constant or an operator; the
// worked-example checks below are run against the mutant and must FAIL (or the mutant must crash). A mutant that survives means
// the fixtures do not pin that constant. The checks use the published worked examples (Hull, SRP31.92) and independent
// recomputation, never the engine's own output as the expected value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const TMP = join(PKG, "test", ".mutants");
const near = (a, b, tol) => Math.abs(Number(a) - b) <= tol;

/** Worked-example checks: true only when every one holds. */
async function allPass(m) {
  const flat = (z) => m.curveFromInput({ kind: "zero", compounding: "continuous", tenors: [1, 30], rates: [z, z] });
  const cf = (a, step = 0.5) => a.map((amount, i) => ({ t: (i + 1) * step, amount }));
  const risk = (f, c, o = {}) => m.riskMeasures(f, c, { bump: m.LIMITS.defaultBump, ...o });
  const checks = [];
  // Hull: price 94.213, duration 2.653
  const b = cf([5, 5, 5, 5, 5, 105]), c12 = flat(0.12), price = (c) => m.presentValue(b, c);
  checks.push(() => near(price(c12), 94.213, 0.001));
  checks.push(() => near(risk(price, c12).effectiveDuration, 2.653, 0.001));
  // DV01 and convexity of a zero-coupon bond (closed forms: D = T, C = T^2, DV01 = P T 1bp)
  const zc = (c) => 100 * m.discountFactor(c, 5), c4 = flat(0.04);
  checks.push(() => near(risk(zc, c4).effectiveDuration, 5, 1e-6) && near(risk(zc, c4).convexity, 25, 1e-3));
  checks.push(() => near(risk(zc, c4).dv01, 100 * Math.exp(-0.2) * 5 * 0.0001, 1e-7));
  checks.push(() => near(risk(zc, c4, { bump: 0.001 }).dv01, 100 * Math.exp(-0.2) * 5 * 0.0001, 1e-6));
  // key rates: sum to the parallel duration; a 5y zero has its risk at the 5y key
  const keys = [1, 2, 5, 10], kc = m.curveFromInput({ kind: "zero", compounding: "continuous", tenors: [0.5, 1, 2, 5, 10, 20], rates: [0.03, 0.032, 0.035, 0.04, 0.043, 0.046] });
  checks.push(() => { const r = risk(zc, kc, { keyTenors: keys }); return near(r.keyRates[2].duration, 5, 1e-6) && near(r.keyRates[0].duration, 0, 1e-6) && near(r.keyRates[3].duration, 0, 1e-6); });
  checks.push(() => { const r = risk((c) => m.presentValue(cf([3, 3, 3, 3, 3, 3, 3, 3, 3, 103], 1), c), kc, { keyTenors: keys }); return near(r.keyRates.reduce((s, k) => s + k.duration, 0), r.effectiveDuration, 1e-6); });
  // bootstrap: independent recomputation (Python)
  checks.push(() => { const { discountFactors: d } = m.bootstrapPar([0.5, 1, 1.5, 2], [0.04, 0.045, 0.05, 0.055], 2); return near(d[3], 0.896552246635172, 1e-12) && near(d[1], 0.9564216884797929, 1e-12); });
  // NSS formula at t = 2 (Python) and the zero-coupon limits
  const p = { beta0: 0.05, beta1: -0.02, beta2: 0.01, beta3: 0.005, tau1: 1.5, tau2: 8 };
  checks.push(() => near(m.nssRate(2, p), 0.04237098757792557, 1e-12) && near(m.nssRate(1e6, p), 0.05, 1e-6));
  // day counts
  checks.push(() => m.yearFraction("ACT/360", "2024-01-01", "2024-07-01") === 182 / 360 && m.yearFraction("ACT/365F", "2024-01-01", "2025-01-01") === 366 / 365 && m.yearFraction("30/360", "2007-01-15", "2007-03-31") === 76 / 360 && m.yearFraction("30/360", "2007-01-31", "2007-03-31") === 60 / 360 && m.yearFraction("30/360", "2007-01-31", "2007-04-30") === 90 / 360);
  // floater at par with zero spread, every day count; compounding conversions
  const base = { type: "floating", spread: 0, notional: 1000, startDate: "2025-01-15", maturityDate: "2030-01-15", valuationDate: "2025-01-15", frequency: 2 };
  checks.push(() => ["ACT/360", "ACT/365F", "30/360"].every((dayCount) => near(m.priceInstrument({ ...base, dayCount }, flat(0.04)).dirty, 1000, 1e-9)));
  checks.push(() => near(m.zeroRate(m.curveFromInput({ kind: "zero", compounding: "semiannual", tenors: [1, 2], rates: [0.04, 0.04] }), 1), 2 * Math.log(1.02), 1e-15) && near(m.zeroRate(m.curveFromInput({ kind: "zero", compounding: "annual", tenors: [1, 2], rates: [0.04, 0.04] }), 1), Math.log(1.04), 1e-15));
  // fixed bond: independent PV with dates by hand (30/360 coupons 25, ACT/365F discount times)
  checks.push(() => { const r = m.priceInstrument({ type: "fixed", rate: 0.05, notional: 1000, dayCount: "30/360", startDate: "2025-01-15", maturityDate: "2026-01-15", valuationDate: "2025-01-15", frequency: 2 }, flat(0.04)); return near(r.dirty, 25 * Math.exp(-0.04 * 181 / 365) + 1025 * Math.exp(-0.04 * 365 / 365), 1e-9); });
  // annuity
  checks.push(() => near(m.generateCashflows({ type: "amortising", amortisation: "level", rate: 0.06, notional: 1000, dayCount: "30/360", startDate: "2025-01-15", maturityDate: "2027-01-15", valuationDate: "2025-01-15", frequency: 2 }).cashflows[0].amount, (1000 * 0.03) / (1 - 1.03 ** -4), 1e-9));
  // IRRBB, SRP31.92 (JPY 100/100 bp at 3.5y) and a one-bucket EVE by hand
  const P = m.irrbbParams();
  checks.push(() => near(m.shockAt(P, "JPY", "short-up", 3.5) * 1e4, 41.7, 0.05) && near(m.shockAt(P, "JPY", "steepener", 3.5) * 1e4, 25.4, 0.05) && near(m.shockAt(P, "JPY", "flattener", 3.5) * 1e4, -1.6, 0.05));
  checks.push(() => { const r = m.runIrrbb(P, { currency: "USD", curve: flat(0.03), ladder: { schema: "kit.cashflow-ladder.v1", minorExponent: 0, items: [{ id: "a", kind: "asset", amount: 1000000, repricingYears: 9.5 }] } }); return near(r.scenarios[0].deltaEve, 1000000 * (Math.exp(-0.05 * 9.5) - Math.exp(-0.03 * 9.5)), 1) && near(r.baseEve, 1000000 * Math.exp(-0.03 * 9.5), 1); });
  checks.push(() => { const r = m.runIrrbb(P, { currency: "USD", curve: flat(0.03), ladder: { schema: "kit.cashflow-ladder.v1", minorExponent: 0, items: [{ id: "a", kind: "asset", amount: 1000000, repricingYears: 0.5 }] } }); return near(r.nii[0].deltaNii, 1000000 * 0.02 * 0.5, 1); });
  // NII counts only items repricing inside the horizon
  checks.push(() => { const r = m.runIrrbb(P, { currency: "USD", curve: flat(0.03), ladder: { schema: "kit.cashflow-ladder.v1", minorExponent: 0, items: [{ id: "a", kind: "asset", amount: 1000000, repricingYears: 1.5 }] } }); return r.nii.every((n) => n.deltaNii === 0); });
  // floor must not reverse a shock
  checks.push(() => { const r = m.runIrrbb(P, { currency: "USD", curve: flat(-0.05), ladder: { schema: "kit.cashflow-ladder.v1", minorExponent: 0, items: [{ id: "a", kind: "asset", amount: 1000000, repricingYears: 9.5 }] }, floor: { startBp: -100, perYearBp: 0 } }); return r.scenarios.find((s) => s.id === "parallel-down").deltaEve === 0; });
  let ok = true;
  for (const [i, f] of checks.entries()) {
    try { if (!(await f())) { ok = false; break; } } catch { ok = false; break; /* an assertion that throws is a failing check */ }
    void i;
  }
  return ok;
}

const MUTANTS = [
  ["risk.js", "(dn - up) / (2 * p0 * bump)", "(dn - up) / (3 * p0 * bump)"],
  ["risk.js", "(up + dn - 2 * p0) / (p0 * bump * bump)", "(up + dn - p0) / (p0 * bump * bump)"],
  ["risk.js", "((dn - up) / 2) * (LIMITS.oneBp / bump),", "((dn - up) / 2) * (bump / LIMITS.oneBp),"],
  ["risk.js", "return (t - keys[i - 1]) / (k - keys[i - 1]);", "return (t - keys[i - 1]) / (k - keys[i - 1]) * 0.9;"],
  ["risk.js", "return (keys[i + 1] - t) / (keys[i + 1] - k);", "return (keys[i + 1] - t) / (keys[i + 1] - k) * 0.9;"],
  ["bootstrap.js", "const t = k * h, c = par(t) / frequency;", "const t = k * h, c = par(t) / (frequency + 1);"],
  ["bootstrap.js", "const df = (1 - c * annuity) / (1 + c);", "const df = (1 - c * annuity) / (1 + 2 * c);"],
  ["nss.js", "p.beta2 * (g1 - Math.exp(-tt / p.tau1))", "p.beta2 * (g1 + Math.exp(-tt / p.tau1))"],
  ["nss.js", "p.beta3 * (g2 - Math.exp(-tt / p.tau2))", "p.beta3 * (g1 - Math.exp(-tt / p.tau2))"],
  ["daycount.js", 'case "ACT/360": return days / 360;', 'case "ACT/360": return days / 365;'],
  ["daycount.js", 'case "ACT/365F": return days / 365;', 'case "ACT/365F": return days / 366;'],
  ["daycount.js", "const d1 = Math.min(da.d, 30);", "const d1 = da.d;"],
  ["daycount.js", "return (360 * (db.y - da.y) + 30 * (db.m - da.m) + (d2 - d1)) / 360;", "return (360 * (db.y - da.y) + 31 * (db.m - da.m) + (d2 - d1)) / 360;"],
  ["curve.js", 'case "semiannual": need(rate > -2, "bad-rate", "a semiannually compounded rate must exceed -200%", path); return 2 * Math.log(1 + rate / 2);', 'case "semiannual": need(rate > -2, "bad-rate", "a semiannually compounded rate must exceed -200%", path); return Math.log(1 + rate / 2);'],
  ["curve.js", "return Math.log(1 + rate);", "return Math.log(1 + rate) * 1.01;"],
  ["curve.js", "export const discountFactor = (c, t) => Math.exp(-zeroRate(c, t) * t);", "export const discountFactor = (c, t) => Math.exp(-zeroRate(c, t) * t * 1.001);"],
  ["cashflows.js", "(discountFactor(curve, t1) / discountFactor(curve, t2) - 1) / yf(p.start, p.end) + x.spread", "(discountFactor(curve, t1) / discountFactor(curve, t2) - 1) / (t2 - t1) + x.spread"],
  ["cashflows.js", "(x.notional * (x.rate / x.frequency)) / (1 - (1 + x.rate / x.frequency) ** -n)", "(x.notional * (x.rate / x.frequency)) / (1 - (1 + x.rate / x.frequency) ** -(n + 1))"],
  ["cashflows.js", "t: d / 365, interest", "t: d / 360, interest"],
  ["irrbb.js", "const S = Math.exp(-t / P.shapingDecayYears.value);", "const S = Math.exp(-t / (P.shapingDecayYears.value + 1));"],
  ["irrbb.js", "P.rotation.steepener.longCoefficient * bp(Math.abs(c.long)) * (1 - S)", "P.rotation.steepener.longCoefficient * bp(Math.abs(c.long)) * S"],
  ["irrbb.js", "Math.exp(-(z + sh) * s.t)", "Math.exp(-(z + sh) * s.t * 0.99)"],
  ["irrbb.js", "d += (Number(it.signed) / 10 ** e) * sh * (h - it.repricingYears);", "d += (Number(it.signed) / 10 ** e) * sh * h;"],
  ["irrbb.js", "return Math.max(z + shock, Math.min(z, floorAt(floor, t)));", "return Math.max(z + shock, floorAt(floor, t));"],
  ["irrbb.js", "if (it.repricingYears >= h) continue;", "if (it.repricingYears > 2 * h) continue;"],
];

test("mutation: every mutant of the engine source is killed by the worked-example checks", async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const m0 = await import("../src/index.js");
  assert.equal(await allPass(m0), true, "the unmutated engine passes its own worked-example checks");
  const survivors = [], killedBy = [];   // a mutant that cannot even load is killed; its error is kept for the report
  try {
    for (const [i, [file, from, to]] of MUTANTS.entries()) {
      const dir = join(TMP, `m${i}`);
      cpSync(join(PKG, "src"), join(dir, "src"), { recursive: true });
      cpSync(join(PKG, "data"), join(dir, "data"), { recursive: true });
      cpSync(join(PKG, "package.json"), join(dir, "package.json"));
      const path = join(dir, "src", file);
      const text = readFileSync(path, "utf8");
      assert.ok(text.includes(from), `mutant ${i}: the text to mutate is not in ${file}: ${from}`);
      writeFileSync(path, text.replace(from, to));
      let killed = false;
      try {
        const m = await import(`${pathToFileURL(join(dir, "src", "index.js")).href}?m=${i}`);
        killed = !(await allPass(m));
      } catch (e) { killed = true; killedBy.push(`${i}: ${e.message}`); }
      if (!killed) survivors.push(`${i}: ${file}: ${from.slice(0, 70)}`);
    }
  } finally { rmSync(TMP, { recursive: true, force: true }); }
  assert.deepEqual(survivors, [], `surviving mutants:\n${survivors.join("\n")}\n(killed by a load or run error: ${killedBy.length})`);
});
