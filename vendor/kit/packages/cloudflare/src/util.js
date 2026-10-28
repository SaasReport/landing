/** Small shared helpers: escaping, responses, hashing, digits, dates. No project-specific values. */
import { LOCALE_DIGITS, digits } from "@saasreport/format";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const html = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", ...extra } });

/** Public JSON (CORS open, short cache). */
export const jsonRes = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", "access-control-allow-origin": "*", ...extra } });

/** Private JSON (never cached). */
export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

export const text = (body, type = "text/plain", maxAge = 3600, extra = {}) =>
  new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": `public, max-age=${maxAge}`, "access-control-allow-origin": "*", ...extra } });

export const redirect = (location, status = 301) => new Response(null, { status, headers: { location } });

export const sha256 = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time comparison of two secrets (compares their SHA-256 digests). */
export async function safeEqual(a, b) {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

/** Localized digits for a language ("fa" → Persian digits; others keep theirs): @saasreport/format (CONSTITUTION.md §7). */
export const digitsFor = (lang) => (LOCALE_DIGITS[lang] ? (v) => digits(v, lang) : (v) => String(v ?? ""));


/** Day number (days since 1970-01-01) of an instant in a time zone. */
export function dayNumber(date = new Date(), timeZone = "UTC") {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map((x) => [x.type, x.value]));
  return Math.floor(Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`) / 864e5);
}
export const isoOfDay = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

export const slugify = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "site";

/** Only keep characters that are safe inside a CSS declaration value. */
export const cssValue = (v) => String(v ?? "").replace(/[^#(),.%\w\s'"-]/g, "").replace(/["']/g, "'").slice(0, 200);
export const kebab = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();

export const clampInt = (v, min, max, def) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export const parseJSON = (s, def) => { try { return s == null ? def : JSON.parse(s); } catch { return def; /* the caller names the value it accepts for a missing or unreadable field */ } };
