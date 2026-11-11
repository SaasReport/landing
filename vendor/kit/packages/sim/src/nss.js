/**
 * Nelson-Siegel-Svensson zero-rate curve and its fit.
 *
 * Model (Svensson 1994, extending Nelson & Siegel 1987), continuously compounded zero rate at maturity t > 0:
 *   z(t) = b0 + b1 * g1(t) + b2 * (g1(t) - e^(-t/tau1)) + b3 * (g2(t) - e^(-t/tau2)),   g(t) = (1 - e^(-t/tau)) / (t/tau)
 * Limits: z(0+) = b0 + b1, z(inf) = b0.
 *
 * Fit: least squares on zero rates. For fixed (tau1, tau2) the model is linear in (b0..b3), so the betas are the
 * exact least-squares solution of a 4x4 normal system (variable projection); the two taus are searched with a
 * deterministic multi-start Nelder-Mead (Nelder & Mead 1965) over (ln tau1, ln tau2) inside the bounds below, the best
 * residual wins. No random numbers: the start grid is fixed, so the fit is a pure function of its input.
 * The fit is to ZERO rates. A par curve must be bootstrapped first (bootstrap.js); fitting par yields as if they were
 * zero rates is the flaw this engine does not repeat.
 */
import { SimError, need, isNum } from "./errors.js";

export const NSS_BOUNDS = Object.freeze({ tau1: [0.1, 5], tau2: [0.5, 30], beta: [-1, 1], minPoints: 6, minRatio: 1.2 });
export const NSS_FIT_TOLERANCE = 1e-10; // Nelder-Mead stop: simplex spread of the residual sum below 1e-20 + this x the best value

const g = (t, tau) => { const x = t / tau; return (1 - Math.exp(-x)) / x; };

export function nssRate(t, p) {
  need(isNum(t) && t >= 0, "bad-maturity", "maturity must be a finite number >= 0");
  const tt = Math.max(t, 1e-8);
  const g1 = g(tt, p.tau1), g2 = g(tt, p.tau2);
  return p.beta0 + p.beta1 * g1 + p.beta2 * (g1 - Math.exp(-tt / p.tau1)) + p.beta3 * (g2 - Math.exp(-tt / p.tau2));
}

export function validateNss(p, path = "nss") {
  for (const k of ["beta0", "beta1", "beta2", "beta3", "tau1", "tau2"]) need(isNum(p?.[k]), "bad-nss", `${k} must be a finite number`, `${path}/${k}`);
  need(p.tau1 >= NSS_BOUNDS.tau1[0] && p.tau1 <= NSS_BOUNDS.tau1[1], "nss-out-of-range", `tau1 must be in [${NSS_BOUNDS.tau1}]`, `${path}/tau1`);
  need(p.tau2 >= NSS_BOUNDS.tau2[0] && p.tau2 <= NSS_BOUNDS.tau2[1], "nss-out-of-range", `tau2 must be in [${NSS_BOUNDS.tau2}]`, `${path}/tau2`);
  need(p.tau2 >= p.tau1 * NSS_BOUNDS.minRatio, "nss-out-of-range", `tau2 must be at least ${NSS_BOUNDS.minRatio} x tau1 (the two humps must be distinguishable)`, `${path}/tau2`);
  for (const k of ["beta0", "beta1", "beta2", "beta3"]) need(p[k] >= NSS_BOUNDS.beta[0] && p[k] <= NSS_BOUNDS.beta[1], "nss-out-of-range", `${k} must be in [${NSS_BOUNDS.beta}] (decimal rates)`, `${path}/${k}`);
  return p;
}

/** Solve A x = b by Gaussian elimination with partial pivoting (n is 4). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Betas and residual sum of squares for fixed taus. */
function projected(ts, ys, tau1, tau2) {
  const rows = ts.map((t) => {
    const g1 = g(t, tau1), g2 = g(t, tau2);
    return [1, g1, g1 - Math.exp(-t / tau1), g2 - Math.exp(-t / tau2)];
  });
  const A = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const b = new Array(4).fill(0);
  rows.forEach((r, i) => { for (let a = 0; a < 4; a++) { b[a] += r[a] * ys[i]; for (let c = 0; c < 4; c++) A[a][c] += r[a] * r[c]; } });
  for (let a = 0; a < 4; a++) A[a][a] += 1e-12; // ridge: keeps a near-collinear pair of taus solvable, far below the data's scale
  const beta = solve(A, b);
  if (!beta) return { rss: Infinity, beta: [0, 0, 0, 0] };
  let rss = 0;
  rows.forEach((r, i) => { const e = r[0] * beta[0] + r[1] * beta[1] + r[2] * beta[2] + r[3] * beta[3] - ys[i]; rss += e * e; });
  return { rss, beta };
}

/** Deterministic Nelder-Mead on f over R^2 (coefficients: reflect 1, expand 2, contract 0.5, shrink 0.5). */
function nelderMead(f, x0, step, maxIter) {
  let pts = [x0, [x0[0] + step, x0[1]], [x0[0], x0[1] + step]].map((x) => ({ x, v: f(x) }));
  let it = 0;
  const lerp = (a, b) => { const x = [a[0] + 0.5 * (b[0] - a[0]), a[1] + 0.5 * (b[1] - a[1])]; return { x, v: f(x) }; };
  for (; it < maxIter; it++) {
    pts.sort((a, b) => a.v - b.v);
    if (it > 20 && Math.abs(pts[2].v - pts[0].v) < 1e-20 + NSS_FIT_TOLERANCE * Math.abs(pts[0].v)) break;
    const c = [(pts[0].x[0] + pts[1].x[0]) / 2, (pts[0].x[1] + pts[1].x[1]) / 2];
    const at = (k) => [c[0] + k * (pts[2].x[0] - c[0]), c[1] + k * (pts[2].x[1] - c[1])];
    const xr = at(-1), fr = f(xr);
    if (fr < pts[0].v) {
      const xe = at(-2), fe = f(xe);
      pts[2] = fe < fr ? { x: xe, v: fe } : { x: xr, v: fr };
    } else if (fr < pts[1].v) pts[2] = { x: xr, v: fr };
    else {
      const xc = fr < pts[2].v ? at(-0.5) : at(0.5), fc = f(xc);
      if (fc < Math.min(fr, pts[2].v)) pts[2] = { x: xc, v: fc };
      else pts = [pts[0], lerp(pts[0].x, pts[1].x), lerp(pts[0].x, pts[2].x)];
    }
  }
  pts.sort((a, b) => a.v - b.v);
  return { x: pts[0].x, v: pts[0].v, iterations: it };
}

/**
 * Fit NSS to zero-rate points.
 * @param {{t:number, rate:number}[]} points maturities (years, > 0) and continuously compounded zero rates (decimals)
 * @returns {{params, rmse:number, maxError:number, iterations:number, starts:number}}
 */
export function fitNss(points) {
  need(Array.isArray(points) && points.length >= NSS_BOUNDS.minPoints, "too-few-points", `an NSS fit needs at least ${NSS_BOUNDS.minPoints} points (it has six parameters)`, "points");
  const ts = points.map((p) => p.t), ys = points.map((p) => p.rate);
  ts.forEach((t, i) => need(isNum(t) && t > 0 && isNum(ys[i]), "bad-point", "each point is a maturity > 0 and a finite rate", `points/${i}`));
  need(new Set(ts).size === ts.length, "bad-point", "maturities must be distinct", "points");
  const [l1, h1] = NSS_BOUNDS.tau1.map(Math.log), [l2, h2] = NSS_BOUNDS.tau2.map(Math.log);
  const clampTaus = ([a, b]) => {
    const ca = Math.min(Math.max(a, l1), h1), cb = Math.min(Math.max(b, l2), h2);
    const t1 = Math.exp(ca), t2 = Math.max(Math.exp(cb), t1 * NSS_BOUNDS.minRatio);
    return { t1, t2, pen: (a - ca) ** 2 + (b - cb) ** 2 };
  };
  const obj = (x) => { const { t1, t2, pen } = clampTaus(x); return projected(ts, ys, t1, t2).rss + 1e3 * pen; };
  let best = null, iterations = 0, starts = 0;
  for (const s1 of [0.4, 1, 2.5]) for (const s2 of [2, 5, 12]) {
    starts++;
    const r = nelderMead(obj, [Math.log(s1), Math.log(s2)], 0.3, 400);
    iterations += r.iterations;
    if (!best || r.v < best.v) best = r;
  }
  const { t1: tau1, t2: tau2 } = clampTaus(best.x);
  const { beta } = projected(ts, ys, tau1, tau2);
  const params = { beta0: beta[0], beta1: beta[1], beta2: beta[2], beta3: beta[3], tau1, tau2 };
  for (const k of ["beta0", "beta1", "beta2", "beta3"]) {
    if (Math.abs(params[k]) > NSS_BOUNDS.beta[1]) throw new SimError("nss-out-of-range", `the fitted ${k} (${params[k].toFixed(3)}) leaves the validated range [${NSS_BOUNDS.beta}]: the data do not fit this model`, `nss/${k}`);
  }
  let sse = 0, maxError = 0;
  ts.forEach((t, i) => { const e = nssRate(t, params) - ys[i]; sse += e * e; maxError = Math.max(maxError, Math.abs(e)); });
  return { params, rmse: Math.sqrt(sse / ts.length), maxError, iterations, starts };
}
