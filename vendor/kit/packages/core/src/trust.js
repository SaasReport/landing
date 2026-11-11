/**
 * The TRUST ROOT of the approval ledgers (docs/CONCEPTS.md section 5): who may approve what is signed by the OWNER's key, and the verifier gets the owner's
 * public key from somewhere an agent cannot write, never from the repository (an agent can edit vendor/kit/**, kit.manifest.json, the registry and the ledger).
 *
 *   trust record  { $schema, v: 1, project, github, owner, seq, at, expires, approvals, signature }   packages/core/registry/trust/<project>.json
 *   signature     an OpenSSH SSHSIG (`ssh-keygen -Y sign -n kit-trust@<project>`) over canonicalJson(record without `signature`), Ed25519
 *   owner keys    the owner's GitHub SSH SIGNING keys (GET https://api.github.com/users/<owner>/ssh_signing_keys), for an owner name PINNED outside the repo
 *                 (KIT_OWNER: a GitHub org/repo Actions variable in CI, a Worker binding at run time); a record naming another owner is refused
 *   signer        optional { sha256 }: the owner-signed hash of the signer code (kit trust signer-hash); the CLI refuses to decrypt a key when its own code differs
 *   approvals     { concepts: "general"|"shariah"|null, shariah?: Kind, persian?: Kind }, Kind = { ledger, anchor, roster, witnessFrom?, migration? }
 *                 migration (persian only) = { sha256, entries }: the ONE old fa-review.json the ledger may be migrated from
 *
 * A record EXPIRES (`expires`): it is judged against the time the durable witness reports (not the verifier's own clock, which an agent controls), and its `seq` is
 * witnessed like a ledger head, so an older record cannot be put back (witness.js, recordTrustWitness).
 *
 * Verification is WebCrypto Ed25519 (ed25519.js): the signature must verify under ANY currently listed owner key, the record's project, repo (`github`) and owner
 * must be the verifier's, and `seq` is witnessed like a ledger head (a rolled-back record is refused by the same monotonic witness).
 */
import { canonicalJson } from "./canonical.js";
import { sha256 } from "./sha256.js";
import { ed25519Verify, toBase64, canonicalBase64, checkPublicKey } from "./ed25519.js";
import { ledgerId, kindActions } from "./ledger.js";
import { createValidator, formatProblems } from "./schema.js";
import TRUST_SCHEMA from "../schemas/trust-record.schema.json" with { type: "json" };

import PIN_SCHEMA from "../schemas/trust-pin.schema.json" with { type: "json" };

const validator = createValidator([TRUST_SCHEMA, PIN_SCHEMA]);
/**
 * The pin of ONE project (KIT_TRUST_PIN / a broker binding), schema-validated: { minSeq, verifier?, witness? }. Fails closed: a missing, null, empty or malformed pin is a problem,
 * never "no pin". `needVerifier`: the broker also needs the verifier pin. → string[] (empty = fine)
 */
export function pinProblems(pin, { needVerifier = false } = {}) {
  if (pin == null || typeof pin !== "object" || Array.isArray(pin)) return ["no trust pin for this project outside the repository (KIT_TRUST_PIN: { \"<project>\": { \"minSeq\": N } } next to KIT_OWNER): without it deleting the owner's newest record downgrades the gate, so nothing is trusted"];
  const out = formatProblems(validator.validate({ p: pin }, PIN_SCHEMA.$id)).map((m) => `trust pin: ${m}`);
  if (needVerifier && !out.length && !pin.verifier) out.push("trust pin: the verifier pin ({ url, publicKey, required }) is required config of the broker");
  return out;
}
const b64NoPad = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
const hexBytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
/** An approval key's fingerprint, `SHA256:` + base64 of sha256 of the raw key (the OpenSSH style). The signing page shows the same one; the owner compares the two before signing a record. */
export const keyFingerprint = (publicKeyB64) => `SHA256:${b64NoPad(hexBytes(sha256(Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0)))))}`;
/** An OpenSSH public key line's fingerprint (what `ssh-keygen -l` prints): the pin of an owner key. */
export function sshFingerprint(line) {
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})/.exec(String(line).trim());
  return m ? `SHA256:${b64NoPad(hexBytes(sha256(fromB64(m[1]))))}` : null;
}

/** The SSHSIG namespace of a project's records: `kit-trust@<project>`, so a signature made for one project is worthless for another. */
export const trustNamespace = (project) => `kit-trust@${project}`;
export const TRUST_VERSION = "kit.trust-record.v1";
const SUBJECT = { shariah: "id", persian: "file", uploads: "id" };
const enc = new TextEncoder();

/* ---- OpenSSH wire format ---- */
const u32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const str = (b) => cat(u32(b.length), b);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function reader(b) {
  let i = 0;
  return { u32() { const v = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; i += 4; return v; }, bytes(n) { if (i + n > b.length) throw new Error("short"); const o = b.slice(i, i + n); i += n; return o; }, string() { return this.bytes(this.u32()); }, rest: () => b.length - i };
}
const text = (b) => new TextDecoder().decode(b);

/** `ssh-ed25519 AAAA… [comment]` → the raw 32-byte key as canonical base64, or null (any other key type is not an owner key). */
export function sshEd25519Raw(line) {
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: .*)?$/.exec(String(line).trim());
  if (!m) return null;
  try { const r = reader(fromB64(m[1])); if (text(r.string()) !== "ssh-ed25519") return null; const k = r.string(); if (k.length !== 32 || r.rest()) return null; const b = toBase64(k); return checkPublicKey(b) ? null : b; } catch { return null; /* a malformed key line is no key: the caller refuses null */ }
}

/** Parses an armored SSHSIG → { rawKey, namespace, hashAlg, signature } or { error }. */
export function parseSshSig(armored) {
  const m = /^-----BEGIN SSH SIGNATURE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END SSH SIGNATURE-----\s*$/.exec(String(armored));
  if (!m) return { error: "not an armored SSH signature" };
  try {
    const r = reader(fromB64(m[1].replace(/\s+/g, "")));
    if (text(r.bytes(6)) !== "SSHSIG" || r.u32() !== 1) return { error: "not an SSHSIG version 1" };
    const pk = reader(r.string());
    if (text(pk.string()) !== "ssh-ed25519") return { error: "not an ssh-ed25519 signature" };
    const key = pk.string();
    const namespace = text(r.string()); r.string();
    const hashAlg = text(r.string());
    const sg = reader(r.string());
    if (text(sg.string()) !== "ssh-ed25519") return { error: "not an ssh-ed25519 signature" };
    const signature = sg.string();
    if (key.length !== 32 || signature.length !== 64 || r.rest()) return { error: "malformed SSH signature" };
    return { rawKey: toBase64(key), namespace, hashAlg, signature: toBase64(signature) };
  } catch { return { error: "malformed SSH signature" }; /* the error is returned and the caller refuses it */ }
}

async function digest(alg, msg) { return new Uint8Array(await crypto.subtle.digest(alg === "sha512" ? "SHA-512" : "SHA-256", msg)); }

/** Verifies an SSHSIG over `message` (UTF-8 string) under the namespace, by any of `ownerKeys` (raw canonical base64). → { ok, problem?, key? } */
export async function verifySshSig(armored, message, namespace, ownerKeys) {
  const p = parseSshSig(armored);
  if (p.error) return { ok: false, problem: p.error };
  if (p.namespace !== namespace) return { ok: false, problem: `the signature's namespace is "${p.namespace}", not "${namespace}"` };
  if (p.hashAlg !== "sha512" && p.hashAlg !== "sha256") return { ok: false, problem: "unsupported hash algorithm" };
  if (!ownerKeys.includes(p.rawKey)) return { ok: false, problem: "the signing key is not one of the owner's published signing keys" };
  const h = await digest(p.hashAlg, enc.encode(message));
  const signed = cat(enc.encode("SSHSIG"), str(enc.encode(namespace)), str(new Uint8Array()), str(enc.encode(p.hashAlg)), str(h));
  return (await ed25519Verify(p.rawKey, signed, p.signature)) ? { ok: true, key: p.rawKey } : { ok: false, problem: "the signature does not verify" };
}

/**
 * The owner's GitHub SSH signing keys → raw canonical keys. Fails closed (throws) when the owner has none, GitHub is unreachable, or the API refuses (403/429: the
 * RATE LIMIT is 60 requests an hour per IP unauthenticated and 5000 an hour with a token, so a gate that runs often must be given a token).
 *   opts.token  a GitHub token from the environment that runs the check (never from the repository); sent as a bearer credential
 *   opts.cache  { get(owner) → { etag, keys } | undefined, set(owner, entry) }: conditional requests (If-None-Match, a 304 is cheap and, authenticated, not counted).
 *               Keep it IN MEMORY: a cache file is writable by whoever can write the repository's environment, and an entry whose etag is real but whose keys are swapped
 *               would be believed on a 304.
 */
export async function ownerKeysFromGithub(owner, fetchFn = globalThis.fetch, { token = null, cache = null, pins = null, minAgeMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner || "")) throw new Error(`owner "${owner}" is not a GitHub user name`);
  const hit = cache?.get(owner);
  const r = await fetchFn(`https://api.github.com/users/${owner}/ssh_signing_keys`, { headers: { accept: "application/vnd.github+json", "user-agent": "kit-trust-verifier", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(hit?.etag ? { "if-none-match": hit.etag } : {}) } });
  let list;
  if (r.status === 304 && hit) list = hit.list;
  else {
    if (r.status === 403 || r.status === 429) throw new Error(`GitHub refused the request for ${owner}'s SSH signing keys (${r.status}${r.headers?.get?.("x-ratelimit-reset") ? `, limit resets at ${new Date(Number(r.headers.get("x-ratelimit-reset")) * 1000).toISOString()}` : ""}): this is almost always the API rate limit (60 an hour unauthenticated, 5000 with a token). The check FAILS CLOSED and nothing is trusted: give the environment that runs the check a GitHub token (KIT_GITHUB_TOKEN or GITHUB_TOKEN) and run it again`);
    if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${owner}'s SSH signing keys: the trust root cannot be read, so nothing is trusted`);
    list = await r.json();
    const etag = r.headers?.get?.("etag");
    if (cache && etag) cache.set(owner, { etag, list });
  }
  // GitHub is for DISCOVERY only. With pinned fingerprints (the broker binding or KIT_OWNER_KEYS) only those keys count, whatever GitHub lists; without pins a key added
  // within minAgeMs (created_at) is refused, so a key an intruder just added to the owner's account does not become the root of trust the moment it appears.
  const keep = [];
  for (const k of list) {
    const raw = sshEd25519Raw(k.key); if (!raw) continue;
    if (pins?.length) { if (pins.includes(sshFingerprint(k.key))) keep.push(raw); continue; }
    const created = Date.parse(k.created_at || "");
    if (Number.isFinite(created) && now - created >= minAgeMs) keep.push(raw);
  }
  if (!keep.length) throw new Error(pins?.length ? `none of ${owner}'s GitHub signing keys matches a pinned fingerprint: nothing is trusted` : `${owner} publishes no Ed25519 SSH signing key on GitHub older than ${Math.round(minAgeMs / 864e5)} days (a recently added key is refused; pin the key's fingerprint to use it now): nothing is trusted`);
  return keep;
}

/* ---- the record ---- */
export const trustBody = (record) => { const { signature: _s, ...rest } = record; return canonicalJson(rest); };
export const recordHash = (record) => sha256(trustBody(record));
const canonical = (o) => (o == null ? null : Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Verifies a trust record. ctx = { owner (pinned outside the repo), ownerKeys, project, repo ("Org/name" of the repository being checked) }.
 * → { ok, problems, approvals } where approvals is the usable { project, known, concepts, shariah, persian } (empty and known:false on any problem).
 */
export async function verifyTrustRecord(record, ctx) {
  const problems = [], none = { project: ctx.project, known: false, concepts: null, shariah: null, persian: null };
  const fail = () => ({ ok: false, problems, approvals: none });
  if (!record) { problems.push(`no owner-signed trust record for "${ctx.project}": nobody is registered to approve anything (the owner signs one: kit trust)`); return fail(); }
  for (const m of formatProblems(validator.validate(record, TRUST_SCHEMA.$id))) problems.push(`trust record schema: ${m}`);   // the record is validated, not trusted by shape
  if (record.v !== 1 || record.$schema === undefined) problems.push("trust record: wrong version or no $schema");
  if (record.project !== ctx.project) problems.push(`trust record is for "${record.project}", not "${ctx.project}"`);
  if (!ctx.owner) problems.push("the owner is not pinned outside the repository (KIT_OWNER: an Actions variable or a Worker binding): the trust root cannot be established");
  else if (record.owner !== ctx.owner) problems.push(`trust record names owner "${record.owner}", but the pinned owner is "${ctx.owner}"`);
  if (!SLUG.test(record.github || "") ) problems.push("trust record has no github repository");
  else if (!ctx.repo) problems.push("the repository being checked is unknown (GITHUB_REPOSITORY or the origin remote): the record cannot be matched to it");
  else if (record.github.toLowerCase() !== ctx.repo.toLowerCase()) problems.push(`trust record is for repository ${record.github}, but this is ${ctx.repo}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(record.expires || "") || !(Date.parse(record.expires) > Date.parse(record.at || ""))) problems.push("trust record has no valid expiry after its signing time (`expires`)");
  else if (ctx.now == null) problems.push("no clock is available to judge the record's expiry: refused (fail closed)");
  else if (Date.parse(record.expires) < ctx.now) problems.push(`trust record expired at ${record.expires} (judged against ${ctx.nowSource || "the verifier's clock"}): the owner re-signs it (kit trust)`);
  if (!record.signature) problems.push("trust record is unsigned");
  else if (ctx.ownerKeys?.length) { const v = await verifySshSig(record.signature, trustBody(record), trustNamespace(ctx.project), ctx.ownerKeys); if (!v.ok) problems.push(`trust record: ${v.problem}`); }
  else problems.push(ctx.ownerKeysError || "no owner key is available (GitHub SSH signing keys unreachable): nothing is trusted");
  const a = record.approvals || {};
  if (record.seq === 1 ? record.supersedes !== null : !/^[0-9a-f]{64}$/.test(record.supersedes || "")) problems.push("trust record: seq 1 supersedes nothing (null), every later record names the hash of the record it replaces (supersedes)");
  for (const kind of ["shariah", "persian", "uploads"]) {
    const k = a[kind]; if (!k) continue;
    if (kind !== "persian" && k.migration) problems.push(`a ${kind} ledger has no migration (there is no old ${kind} format)`);
    if (kind !== "persian" && k.baseline) problems.push(`a ${kind} ledger has no baseline`);
    if (k.baseline && !k.anchor) problems.push(`${kind}: a pinned baseline needs the anchor (the commit it was taken at)`);
    const seen = new Set();
    for (const m of k.roster || []) { if (m.actions !== undefined) { if (!Array.isArray(m.actions) || !m.actions.length) problems.push(`${kind} roster: ${m.name} needs at least one action`); else for (const a of m.actions) if (!kindActions(kind).includes(a)) problems.push(`${kind} roster: ${m.name}: action "${a}" is not an action of the ${kind} kind`); } const bad = checkPublicKey(m.publicKey); if (bad) problems.push(`${kind} roster: ${m.name}'s key is ${bad}`); else if (m.fingerprint !== keyFingerprint(m.publicKey)) problems.push(`${kind} roster: ${m.name}'s fingerprint does not match the key`); if (!m.name || seen.has(m.name) || seen.has(m.publicKey)) problems.push(`${kind} roster: duplicate name or key`); seen.add(m.name); seen.add(m.publicKey); }
  }
  // pinned OUTSIDE the repository (KIT_TRUST_PIN / the broker binding, next to KIT_OWNER): a repository record can only ADD requirements, never drop them
  const pin = ctx.pin;
  if (pin) {
    if (Number.isInteger(pin.minSeq) && record.seq < pin.minSeq) problems.push(`trust record seq ${record.seq} is below the minimum seq ${pin.minSeq} pinned outside the repository: a newer record was deleted or replaced by an older one`);
    for (const f of ["verifier", "witness"]) if (pin[f] && JSON.stringify(canonical(record[f])) !== JSON.stringify(canonical(pin[f]))) problems.push(`the trust record drops or changes the ${f} pinned outside the repository (${pin[f].url}): a record can add requirements, never remove them`);
  }
  if (problems.length) return fail();
  const expect = (kind) => (a[kind] ? { id: ledgerId(record.project, kind), project: record.project, kind, subject: SUBJECT[kind], ledger: a[kind].ledger, anchor: a[kind].anchor ?? null, bootstrap: a[kind].roster || [], witnessFrom: a[kind].witnessFrom ?? null, migration: a[kind].migration ?? null, baseline: a[kind].baseline ?? null, scope: a[kind].scope ?? null, witness: record.witness ?? null, checkpoint: record.checkpoint?.ledgers?.[kind] ?? null, verifier: record.verifier ?? null, recordSeq: record.seq, record: { seq: record.seq, hash: recordHash(record), expires: record.expires, body: record } } : null);
  return { ok: true, problems, approvals: { project: record.project, known: true, concepts: a.concepts ?? null, shariah: expect("shariah"), persian: expect("persian"), uploads: expect("uploads"), signer: record.signer ?? null, verifier: record.verifier ?? null, witness: record.witness ?? null, checkpoint: record.checkpoint ?? null, record: { seq: record.seq, hash: recordHash(record), expires: record.expires, body: record } } };
}

void canonicalBase64;
