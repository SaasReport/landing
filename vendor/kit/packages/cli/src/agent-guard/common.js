/** Shared helpers of the guard engine (zero dependencies). */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { globRe } from "../canon/files.js";

export const deny = (rule, reason) => ({ action: "deny", rule, reason });
export const ALLOW = { action: "allow" };
export const base = (p) => String(p).split("/").pop();
export const re = (s, f = "") => { try { return new RegExp(s, f); } catch { /* an invalid value is reported as not matching, never accepted */ return null; } };
/** Does `rel` match any glob? `ci`: case-insensitively (a file system may be: A.PNG is a PNG). */
export const matchAny = (rel, globs = [], ci = false) => globs.some((g) => { const r = globRe(g); return (ci ? new RegExp(r.source, "i") : r).test(rel); });
export const secretHit = (text, reg) => { if (!text) return null; for (const p of reg.secrets.patterns) { const r = re(p.regex); if (r && r.test(text)) return p.id; } return null; };
export const isSecretFile = (name, reg) => reg.secrets.fileNames.some((s) => re(s, "i")?.test(name)) && !reg.secrets.fileExceptions.some((s) => re(s, "i")?.test(name));

/** The real path of a possibly not-yet-existing file: the nearest existing parent resolved (so a symlink cannot hide where a write lands). */
export function realish(p) {
  let cur = resolve(p), tail = "";
  for (let i = 0; i < 64; i++) {
    try { return join(realpathSync(cur), tail); } catch { tail = tail ? join(base(cur), tail) : base(cur); const up = dirname(cur); if (up === cur) return resolve(p); cur = up; }
  }
  return resolve(p);
}

/** Path → { abs, rel, inside }. A remote (GitHub MCP) path is already repository-relative. */
export function locate(p, ctx, payload, remote = false) {
  if (!p) return null;
  if (remote) return { abs: null, rel: String(p).replace(/^\/+/, ""), inside: true };
  const abs = realish(isAbsolute(p) ? p : resolve(payload.cwd || ctx.root, p));
  const root = realish(ctx.root);
  const rel = relative(root, abs).split(sep).join("/");
  return { abs, rel, inside: !rel.startsWith("..") && !isAbsolute(rel) };
}

/** The JSON value at a pointer ("/vendor") of a file's text, as a string to compare: null for no file, "unparseable" when it is not JSON. */
export function pointerValue(text, pointer) {
  if (text == null) return null;
  let v;
  try { v = JSON.parse(text); } catch { return "unparseable"; /* a change that makes the file unreadable is a change of every pointer in it */ }
  for (const k of pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))) v = v && typeof v === "object" ? v[k] : undefined;
  return JSON.stringify(v ?? null);
}
