/**
 * The monotonic WITNESS of an approval ledger (docs/CONCEPTS.md section 5): the highest { seq, hash } of a VERIFIED ledger, kept in an append-only store OUTSIDE the
 * repository, so truncating the tail, rolling back or hiding a withdrawal (which a chain cannot see) is refused.
 *
 *   store     a D1 table with triggers (WITNESS_SQL, `kit ledger witness-sql`): no UPDATE, no DELETE, inserts only strictly ahead, keys of one shape. Rows are keyed by EPOCH,
 *             `<project>:<kind>@<genesis of the ledger's anchor>`: a ledger replaced under a new owner-signed anchor is a new, empty epoch (the old rows stay), so recovery needs no deletion.
 *   writer    ONLY witnessEndpoint(): an insert-only handler that VERIFIES what it is given (ledger against the owner-signed record, record against the owner's key) before it
 *             inserts, so a junk head can never be recorded, and inserts atomically (one INSERT ... WHERE NOT EXISTS). Its deployment, binding and token are the OWNER's.
 *   floor     what a replaced or empty database must still refuse: the owner-signed record's `checkpoint` ({ recordSeq, ledgers: { kind: { seq, hash } } }). `kit ledger
 *             witness-bootstrap` turns it into the rows a fresh database starts with, and a verifier is given it as `floor`, so nothing older than the checkpoint is ever accepted.
 *   readers   checkWitness(): read-only. Once the owner-signed record sets `witnessFrom` a recorded witness is REQUIRED, whatever the submitted ledger's own head says.
 *   independence  an agent that holds Cloudflare or database credentials can still run DDL: the store is independent of agents only once agent credentials are separated from the owner's (#117).
 */
import { ledgerHead, verifyLedger, witnessJudge, witnessKey, genesisFor } from "./ledger.js";
import { canonicalJson } from "./canonical.js";
import { ed25519Verify, toBase64 } from "./ed25519.js";
import { verifyTrustRecord, recordHash } from "./trust.js";

export const LEDGER_ID = /^[a-z0-9][a-z0-9-]*:(shariah|persian|uploads)$/;
export const WITNESS_KEY = /^[a-z0-9][a-z0-9-]*:((shariah|persian|uploads)@[0-9a-f]{64}|trust)$/;
export const WITNESS_SQL = `-- The approval ledger's monotonic witness (docs/CONCEPTS.md): append-only by trigger. Never edit an applied migration.
CREATE TABLE IF NOT EXISTS approval_witness (
  ledger  TEXT NOT NULL CHECK (ledger GLOB '[a-z0-9]*:*' AND ledger NOT GLOB '*[^a-z0-9:@-]*'),
  seq     INTEGER NOT NULL CHECK (seq >= 0),
  head    TEXT NOT NULL CHECK (length(head) = 64),
  seen_at TEXT NOT NULL,
  PRIMARY KEY (ledger, seq)
);
CREATE TRIGGER IF NOT EXISTS approval_witness_no_update BEFORE UPDATE ON approval_witness BEGIN SELECT RAISE(ABORT, 'approval_witness is append-only'); END;
CREATE TRIGGER IF NOT EXISTS approval_witness_no_delete BEFORE DELETE ON approval_witness BEGIN SELECT RAISE(ABORT, 'approval_witness is append-only'); END;
CREATE TRIGGER IF NOT EXISTS approval_witness_monotonic BEFORE INSERT ON approval_witness
  WHEN NEW.seq <= COALESCE((SELECT MAX(seq) FROM approval_witness WHERE ledger = NEW.ledger), -1)
  BEGIN SELECT RAISE(ABORT, 'approval_witness only moves forward'); END;
`;

/** The rows a fresh or replaced database must start with so it can never accept an older state: the current record and the ledger heads of the owner-signed `checkpoint`. */
export function bootstrapSql(record) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`, rows = [`(${q(`${record.project}:trust`)}, ${Number(record.seq)}, ${q(recordHash(record))}, ${q(record.at)})`];
  for (const [kind, h] of Object.entries(record.checkpoint?.ledgers || {})) {
    const anchor = record.approvals?.[kind]?.anchor;
    if (!anchor) throw new Error(`the checkpoint names a ${kind} ledger head but the record has no anchor for ${kind}: its epoch cannot be keyed (the anchor is the commit the ledger starts at)`);
    rows.push(`(${q(`${record.project}:${kind}@${genesisFor(anchor)}`)}, ${Number(h.seq)}, ${q(h.hash)}, ${q(record.at)})`);
  }
  return `-- witness bootstrap from the owner-signed record seq ${record.seq}: the database starts at the checkpoint, never below it\nINSERT INTO approval_witness (ledger, seq, head, seen_at) VALUES\n  ${rows.join(",\n  ")};\n`;
}

/** The highest witnessed head of a witness key, or null. */
export async function witnessedHead(db, key) {
  const r = await db.prepare("SELECT seq, head AS hash FROM approval_witness WHERE ledger = ? ORDER BY seq DESC LIMIT 1").bind(key).first();
  return r ? { seq: r.seq, hash: r.hash } : null;
}

/** The database's own clock: the time a record's expiry is judged against (an agent controls its process clock, not the database's). */
export async function serverNow(db) {
  const r = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").bind().first();
  return r?.now ?? null;
}

const out = (ok, problems = [], reason = null, extra = {}) => ({ ok, problems, reason, ...extra });
const floorProblem = (ledger, floor) => (floor ? witnessJudge(ledger, floor) : null);

/**
 * Read-only: the ledger against the witnessed head. Once the owner-signed record sets `witnessFrom`, a recorded witness is REQUIRED, judged from the record alone (never from the
 * submitted ledger's head): no reachable store, or none recorded for this epoch, fails closed. → { ok, problems, reason }
 */
export async function checkWitness(db, ledger, { expect, floor } = {}) {
  const required = expect?.witnessFrom != null;
  if (!db) return required ? out(false, ["no witness store is reachable, and the owner-signed record requires one for this ledger: refused (fail closed)"], "missing") : out(true);
  const seen = await witnessedHead(db, witnessKey(ledger));
  const j = witnessJudge(ledger, seen, { required }) || floorProblem(ledger, floor) || floorProblem(ledger, expect?.checkpoint);
  return j ? out(false, [j.message], j.code) : out(true);
}

/**
 * The ONLY writer of ledger heads: verifies the ledger (chain, signatures, roster, registry identity, the pinned baseline) first, so nothing unverified is ever recorded, refuses one
 * behind or forked from the witnessed head or below the owner's checkpoint/floor, then inserts atomically. ctx = { expect, bootstrap, now, floor }.
 */
export async function recordWitness(db, ledger, { expect, bootstrap, now, floor, at = new Date().toISOString() } = {}) {
  if (!ledger || typeof ledger.id !== "string" || !LEDGER_ID.test(ledger.id) || !/^[0-9a-f]{64}$/.test(ledger.anchor?.genesis || "")) return out(false, ["not a ledger id"], "bad-request");
  const v = await verifyLedger(ledger, { expect, bootstrap, ...(now ? { now } : {}) });
  if (!v.ok) return out(false, ["the submitted ledger does not verify, so it is not recorded: " + v.problems.slice(0, 3).join("; ")], "unverifiable");
  const f = floorProblem(ledger, floor) || floorProblem(ledger, expect?.checkpoint);
  if (f) return out(false, [f.message], f.code);
  const key = witnessKey(ledger), h = ledgerHead(ledger);
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = await witnessedHead(db, key);
    const j = witnessJudge(ledger, seen);
    if (j) return out(false, [j.message], j.code);
    if (seen && h.seq === seen.seq) return out(true);
    const r = await db.prepare("INSERT INTO approval_witness (ledger, seq, head, seen_at) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM approval_witness WHERE ledger = ?1 AND seq >= ?2)").bind(key, h.seq, h.hash, at).run();
    const changes = r?.meta?.changes ?? r?.changes;
    if (typeof changes !== "number") return out(false, ["the database did not report how many rows the insert changed: refused (a default would hide a failed write)"], "db");
    if (changes > 0) return out(true);   // 0 changes: a concurrent writer got ahead: re-read and re-judge
  }
  return out(false, ["the witness moved concurrently: retry"], "conflict");
}

const TRUST_KEY = (project) => `${project}:trust`;

/** The record chain against the witnessed head: not below the floor, a later record must follow the witnessed one (seq + 1, `supersedes` = its hash), the same seq must be the same record. */
function trustJudge(record, seen, floor) {
  if (floor && record.seq < floor.recordSeq) return { code: "floor", message: `the trust record's seq ${record.seq} is below the owner's checkpoint floor ${floor.recordSeq}: an older record is refused even on an empty or replaced witness` };
  if (!seen) return record.seq === 1 || (floor && record.seq >= floor.recordSeq) ? null : { code: "chain", message: "an empty witness only starts the record chain at seq 1 or at the owner's pinned floor (kit ledger witness-bootstrap)" };
  if (record.seq < seen.seq) return { code: "behind", message: `the trust record's seq ${record.seq} is behind the witnessed seq ${seen.seq}: an older record was put back (rollback), refused` };
  if (record.seq === seen.seq) return seen.hash === recordHash(record) ? null : { code: "fork", message: `a different trust record is witnessed at seq ${record.seq}: refused` };
  if (record.seq !== seen.seq + 1 || record.supersedes !== seen.hash) return { code: "chain", message: `the trust record does not follow the witnessed one: it must be seq ${seen.seq + 1} and supersede ${seen.hash.slice(0, 12)}` };
  return null;
}

/**
 * The trust record's { seq, hash } is witnessed like a ledger head: verified first (owner key, pinned owner, repository, project, schema, expiry against the DATABASE's clock), then
 * chained (seq + 1, `supersedes`) and inserted atomically. ctx = { owner, ownerKeys, project, repo, floor }. → { ok, problems, reason, now }
 */
export async function recordTrustWitness(db, record, ctx, { at = new Date().toISOString() } = {}) {
  const now = await serverNow(db);
  const v = await verifyTrustRecord(record, { ...ctx, now: now ? Date.parse(now) : null, nowSource: "the witness's clock" });
  if (!v.ok) return out(false, ["the submitted trust record does not verify, so it is not recorded: " + v.problems.slice(0, 3).join("; ")], "unverifiable", { now });
  const key = TRUST_KEY(ctx.project), h = { seq: record.seq, hash: recordHash(record) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = await witnessedHead(db, key), j = trustJudge(record, seen, ctx.floor);
    if (j) return out(false, [j.message], j.code, { now });
    if (seen && h.seq === seen.seq) return out(true, [], null, { now });
    const r = await db.prepare("INSERT INTO approval_witness (ledger, seq, head, seen_at) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM approval_witness WHERE ledger = ?1 AND seq >= ?2)").bind(key, h.seq, h.hash, at).run();
    const changes = r?.meta?.changes ?? r?.changes;
    if (typeof changes !== "number") return out(false, ["the database did not report how many rows the insert changed: refused"], "db", { now });
    if (changes > 0) return out(true, [], null, { now });
  }
  return out(false, ["the witness moved concurrently: retry"], "conflict", { now });
}

/** Read-only counterpart: chain position, floor, and expiry by the witness's clock. */
export async function checkTrustWitness(db, record, { project, floor } = {}) {
  if (!db) return out(false, ["no witness store is reachable: the trust record's seq and expiry cannot be judged (fail closed)"], "missing", { now: null });
  const now = await serverNow(db), seen = await witnessedHead(db, TRUST_KEY(project)), problems = [];
  const j = trustJudge(record, seen, floor);
  if (j && !(j.code === "chain" && seen && record.seq > seen.seq)) problems.push(j.message);   // a newer record not yet recorded is fine to READ; recordTrustWitness chains it
  if (now && Date.parse(record.expires) < Date.parse(now)) problems.push(`the trust record expired at ${record.expires} (the witness's clock says ${now})`);
  return out(!problems.length, problems, problems.length ? (j?.code ?? "expired") : null, { now });
}

/** Streams a request body with a hard cap (a Content-Length over the cap, or more bytes than the cap on the wire, is refused without reading the rest). Pass @saasreport/uploads/bounded's readBoundedJson as `readJson` to use the shared reader. */
export async function readBodyBounded(request, maxBytes) {
  const declared = request.headers.get("content-length");
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return { error: 413 };
  if (!request.body) { const t = await request.text(); return t.length > maxBytes ? { error: 413 } : { text: t }; }
  const reader = request.body.getReader(), chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { try { await reader.cancel(); } catch { /* the body is being refused */ } return { error: 413 }; }
    chunks.push(value);
  }
  const buf = new Uint8Array(n); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return { text: new TextDecoder().decode(buf) };
}

const STATUS = { behind: 409, fork: 409, chain: 409, floor: 409, conflict: 409, missing: 409, unverifiable: 422, "bad-request": 400, db: 500, expired: 422 };

/**
 * The insert-only Worker handler: POST { ledger?, record? } → 200 recorded; the status of a refusal comes from the typed `reason`, never from the wording (409 behind / fork / chain /
 * floor, 422 unverifiable). `resolve(ledgerId)` → { expect, bootstrap, floor } and `resolveTrust(project)` → { owner, ownerKeys, repo, floor } come from the OWNER-SIGNED record and the
 * broker's own pins (never the request). `authorize(request)` is REQUIRED and explicit; the body is read with a hard streaming cap (`maxBytes`, 1 MiB; `readJson` may be
 * @saasreport/uploads/bounded's readBoundedJson). No other operation, no SQL, no schema change.
 */
export function witnessEndpoint(db, { resolve, resolveTrust, authorize, maxBytes = 1 << 20, readJson = null, signKey = null } = {}) {
  if (typeof authorize !== "function") throw new Error("witnessEndpoint: `authorize` is required (a function that checks the caller's token); there is no default that lets anyone write");
  if (typeof resolve !== "function") throw new Error("witnessEndpoint: `resolve` is required");
  return async (request) => {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!(await authorize(request))) return new Response("unauthorized", { status: 401 });
    let body;
    if (readJson) { try { body = await readJson(request, { maxBytes }); } catch (e) { return new Response(e?.message || "bad request", { status: e?.status || 400 }); } }
    else { const r = await readBodyBounded(request, maxBytes); if (r.error) return new Response("too large", { status: r.error }); try { body = JSON.parse(r.text); } catch { return new Response("bad request", { status: 400 }); } }
    const res = { ok: true, problems: [], reason: null, now: await serverNow(db) };
    const merge = (r) => { if (!r.ok) { res.ok = false; res.problems.push(...r.problems); res.reason = res.reason ?? r.reason; } };
    if (body?.record) { const ctx = resolveTrust ? await resolveTrust(body.record.project) : null; if (!ctx) return new Response("unknown project", { status: 404 }); merge(await recordTrustWitness(db, body.record, { ...ctx, project: body.record.project })); }
    if (body?.ledger) { const ctx = await resolve(body.ledger?.id); if (!ctx) return new Response("unknown ledger", { status: 404 }); merge(await recordWitness(db, body.ledger, ctx)); }
    // a SIGNED answer: the pinned witness key signs { nonce, ok, now, the ledger key and head, the record hash }, so an answer is bound to this request and this state
    if (signKey) {
      const attest = { v: 1, nonce: String(body?.nonce ?? ""), ok: res.ok, now: res.now, ledger: body?.ledger?.anchor ? { key: witnessKey(body.ledger), ...ledgerHead(body.ledger) } : null, record: body?.record ? { seq: body.record.seq, hash: recordHash(body.record) } : null };
      const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", signKey, new TextEncoder().encode(canonicalJson(attest))));
      res.attest = attest; res.signature = toBase64(sig);
    }
    return new Response(JSON.stringify(res), { status: res.ok ? 200 : STATUS[res.reason] ?? 422, headers: { "content-type": "application/json" } });
  };
}

/**
 * CI / the signer: submit the ledger (and the trust record) to the durable witness and believe only a SIGNED, bound answer. `pinned` = { publicKey } from the OWNER-SIGNED record
 * (the URL is checked by the caller against the same pin): an answer is believed only under that key, for this request's nonce, and for exactly this head and record. An unsigned or
 * wrongly signed { ok: true }, a replayed answer or an unreachable witness is a failure (fail closed); a record that pins no witness key cannot use a witness at all.
 * payload = { ledger?, record? } (or a ledger). → { ok, problems, reason, now }
 */
export async function witnessViaEndpoint(fetchFn, url, token, payload, pinned = {}) {
  const body = payload?.entries ? { ledger: payload } : payload;
  const fail = (m, reason = "unverifiable") => ({ ok: false, now: null, reason, problems: [m] });
  if (!pinned?.publicKey) return fail("the owner-signed trust record pins no witness key (witness.publicKey): an answer from a URL nobody pinned is not a witness");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...body, nonce }) });
    const j = await r.json().catch(() => null);   // an unreadable body is no answer: refused on the next line
    if (!j?.attest || typeof j.signature !== "string") return fail(`the witness endpoint gave no signed answer (status ${r.status}): an unsigned { ok: true } is not a witness`, "unsigned");
    if (!(await ed25519Verify(pinned.publicKey, canonicalJson(j.attest), j.signature))) return fail("the witness's answer does not verify under the witness key the owner-signed record pins: refused", "unsigned");
    const a = j.attest, bad = [];
    if (a.nonce !== nonce) bad.push("the answer is for another request (nonce differs): a replayed answer is refused");
    if (body.ledger?.anchor) { const h = ledgerHead(body.ledger); if (a.ledger?.key !== witnessKey(body.ledger) || a.ledger?.seq !== h.seq || a.ledger?.hash !== h.hash) bad.push("the answer is for another ledger head"); }
    if (body.record && (a.record?.seq !== body.record.seq || a.record?.hash !== recordHash(body.record))) bad.push("the answer is for another trust record");
    if (bad.length) return { ok: false, now: a.now ?? null, reason: "unsigned", problems: bad };
    return { ok: a.ok === true, now: a.now ?? null, reason: j.reason ?? null, problems: a.ok === true ? [] : j.problems?.length ? j.problems : [`the witness refused (status ${r.status})`] };
  } catch (e) { return { ok: false, now: null, reason: "unreachable", problems: [`the witness endpoint is unreachable (${e.message}): refused, a missing witness is not a clean bill`] }; }
}
