/**
 * Seeded PRNG for replayable simulation. sfc32 (Chris Doty-Humphrey's Small Fast Counting generator, public domain),
 * seeded from one uint32 through splitmix32. The generator is passed explicitly into every function that needs
 * randomness; there is no global state, no Math.random and no clock. Same seed, same stream, on every engine.
 */
import { SimError } from "./errors.js";

function splitmix32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

/** @returns {{ u32(): number, next(): number, int(n: number): number, normal(): number, state(): number[] }} */
export function createRng(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new SimError("bad-seed", "the seed must be an integer in 0..4294967295", "seed");
  const sm = splitmix32(seed);
  let a = sm(), b = sm(), c = sm(), d = sm();
  const u32 = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 15; i++) u32(); // warm-up
  let spare = null;
  return {
    u32,
    /** uniform in [0, 1) with 32 bits of resolution */
    next: () => u32() / 4294967296,
    /** uniform integer in [0, n), unbiased (rejection sampling) */
    int(n) {
      if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new SimError("bad-range", "int(n) needs an integer in 1..4294967295");
      const lim = 4294967296 - (4294967296 % n);
      let x;
      do x = u32(); while (x >= lim);
      return x % n;
    },
    /** standard normal by Box-Muller (pairs; the spare is kept) */
    normal() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u;
      do u = (u32() + 1) / 4294967297; while (u <= 0);
      const v = u32() / 4294967296;
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    state: () => [a, b, c, d],
  };
}
