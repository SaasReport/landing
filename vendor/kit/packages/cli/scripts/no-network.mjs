// Preloaded into every node process of `npm test` (NODE_OPTIONS=--import, packages/cli/scripts/test-run.mjs): no test reaches the
// network. fetch and every TCP connection to a host other than this machine throw; a unix socket and loopback stay (the tests'
// own servers). A test that needs a remote document gets it injected (a fixture, a fetch argument, KIT_HEAD_DOC): on 2026-10-14 three
// tests passed locally and failed in CI because vendor-stale fetched a live URL that CI could not read.
import net from "node:net";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);
const refuse = (what) => { throw new Error(`network disabled in the test run: ${what} (inject the document the test needs; docs/RELEASE.md)`); };
const realFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
  let host = ""; try { host = new URL(url, "http://localhost").hostname; } catch { /* a relative URL is local */ }
  if (!LOCAL.has(host) && !/^data:|^blob:/.test(url)) return Promise.reject(new Error(`network disabled in the test run: fetch ${url} (inject the document the test needs; docs/RELEASE.md)`));
  return realFetch.call(this, input, init);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const o = args[0];
  const opts = Array.isArray(o) ? o[0] : o;
  if (opts && typeof opts === "object" && !opts.path && opts.host !== undefined && !LOCAL.has(String(opts.host))) refuse(`connect ${opts.host}:${opts.port}`);
  if (typeof opts === "number" && args[1] !== undefined && typeof args[1] === "string" && !LOCAL.has(args[1])) refuse(`connect ${args[1]}:${opts}`);
  return connect.apply(this, args);
};
