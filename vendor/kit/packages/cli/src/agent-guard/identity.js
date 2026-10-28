/**
 * Agent identity (docs/AGENT-GUARD.md): every agent ROLE has a kit principal id and its OWN signing key.
 *
 *   id        kit:agent:<trust-domain>:<kind>:<local>      kind: main | subagent | loop | codex | ci | app
 *             class `agent` grammar ^kit:agent:[a-z0-9][a-z0-9._:/-]*$
 *   key       Ed25519, generated on the machine that runs the agent, private half 0600 in a 0700 directory (never in the repository, never shared between ids),
 *             public half in agent-identities.json with a 90-day expiry
 *   commits   an agent's commit carries signed trailers (Agent-Id, Agent-Key, Agent-Signature) over the tree, the parents and the message, so the guard can tell an
 *             agent's work from the owner's and CI can verify it against the table at the BASE branch
 *   GitHub    the mapping of an agent's id to a GitHub App identity is owned by the broker (a separate component, not in this change); `githubApp` in a row is its slot
 *
 * Honest limit: the key store is a directory of the same OS user. A process running as that user can read every key, so this attributes and detects; it does not
 * isolate one agent from another. The isolation is a key held by a separate identity (the broker, owned elsewhere; a KMS): owed.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KINDS = ["main", "subagent", "loop", "codex", "ci", "app"];
export const ID_RE = /^kit:agent:([a-z0-9][a-z0-9-]*):(main|subagent|loop|codex|ci|app):([a-z0-9][a-z0-9._-]*)$/;
export const KIT_AGENT_GRAMMAR = /^kit:agent:[a-z0-9][a-z0-9._:/-]*$/;
export const MAX_KEY_DAYS = 90;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unknown";

export function agentId({ domain, kind, local }) {
  if (!KINDS.includes(kind)) throw new Error(`agent kind "${kind}" is not one of ${KINDS.join(", ")}`);
  const id = `kit:agent:${slug(domain)}:${kind}:${slug(local)}`;
  if (!ID_RE.test(id) || !KIT_AGENT_GRAMMAR.test(id)) throw new Error(`"${id}" is not a kit agent id`);
  return id;
}
export const parseId = (id) => { const m = ID_RE.exec(id || ""); return m ? { domain: m[1], kind: m[2], local: m[3] } : null; };

/** The key directory: KIT_AGENT_KEYS, else ~/.local/state/kit-agent-guard/keys. Created 0700; refused when it is group- or world-accessible or not ours. */
export function keyDir(env = process.env) { return env.KIT_AGENT_KEYS || join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "kit-agent-guard/keys"); }
export function ensureKeyDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`key directory ${dir} is not owned by this user`);
  if (st.mode & 0o077) { chmodSync(dir, 0o700); if (statSync(dir).mode & 0o077) throw new Error(`key directory ${dir} is accessible to others and cannot be tightened`); }
  return dir;
}
const keyFile = (dir, id) => join(dir, `${sha(id).slice(0, 16)}.key`);
export const fingerprintOf = (spkiB64) => sha(Buffer.from(spkiB64, "base64")).slice(0, 16);

/** Generate the id's own key (never overwrites: rotation is a new, explicit issuance). → { id, publicKey, fingerprint, file }. */
export function issueKey(dir, id) {
  if (!ID_RE.test(id)) throw new Error(`not an agent id: ${id}`);
  ensureKeyDir(dir);
  const f = keyFile(dir, id);
  if (existsSync(f)) throw new Error(`${id} already has a key; rotate it explicitly (revoke, then issue)`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  chmodSync(f, 0o600);
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { id, publicKey: pub, fingerprint: fingerprintOf(pub), file: f };
}
export const hasKey = (dir, id) => existsSync(keyFile(dir, id));

export function signBytes(dir, id, bytes) {
  const f = keyFile(dir, id);
  if (!existsSync(f)) throw new Error(`no key for ${id}`);
  const st = statSync(f); if (st.mode & 0o077) throw new Error(`key file for ${id} is accessible to others`);
  return sign(null, Buffer.from(bytes), createPrivateKey(readFileSync(f))).toString("base64");
}
export function verifyBytes(publicKeyB64, bytes, sigB64) {
  try { return verify(null, Buffer.from(bytes), createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" }), Buffer.from(sigB64, "base64")); } catch { /* failure here means no value; the caller holds on the empty answer */ return false; }
}

/** A row for the table. */
export function rowFor(issued, { kind, issuedAt = new Date().toISOString().slice(0, 10), days = MAX_KEY_DAYS, githubApp, evidence }) {
  const exp = new Date(Date.parse(issuedAt) + days * 86400000).toISOString().slice(0, 10);
  return { id: issued.id, kind, publicKey: issued.publicKey, fingerprint: issued.fingerprint, issuedAt, expiresAt: exp, ...(githubApp ? { githubApp } : {}), ...(evidence ? { evidence } : {}) };
}

/** Problems of an agent-identities table (the schema is checked separately): unique ids and keys, expiry, fingerprints, domains and apps against the project registry. */
export function tableProblems(table, { projects = [], today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [], ids = new Set(), keys = new Set();
  for (const r of table.rows || []) {
    const p = parseId(r.id);
    if (!p) { out.push(`${r.id}: not a kit agent id`); continue; }
    if (p.kind !== r.kind) out.push(`${r.id}: kind ${r.kind} does not match the id`);
    if (ids.has(r.id)) out.push(`${r.id}: listed twice`); ids.add(r.id);
    if (keys.has(r.publicKey)) out.push(`${r.id}: shares a public key with another agent: every agent has its own key`); keys.add(r.publicKey);
    if (r.fingerprint !== fingerprintOf(r.publicKey)) out.push(`${r.id}: the fingerprint is not the key's`);
    if ((Date.parse(r.expiresAt) - Date.parse(r.issuedAt)) / 86400000 > MAX_KEY_DAYS) out.push(`${r.id}: the key lives longer than ${MAX_KEY_DAYS} days`);
    if (r.expiresAt < today && !r.revokedAt) out.push(`${r.id}: the key expired on ${r.expiresAt}: rotate it`);
    const proj = projects.find((x) => x.key === p.domain);
    if (projects.length && !proj) out.push(`${r.id}: trust domain ${p.domain} is not a project in the registry`);
  }
  for (const o of table.owners || []) if (o.fingerprint !== fingerprintOf(o.publicKey)) out.push(`owner ${o.login}: the fingerprint is not the key's`);
  return out;
}

// ---- commits: signed trailers
const TRAILER = /^(Agent-Id|Agent-Key|Agent-Signature):.*$/gm;
export const stripAgentTrailers = (msg) => msg.replace(TRAILER, "").replace(/\n{3,}/g, "\n\n").trimEnd();
export const commitPayload = ({ tree, parents, message }) => `kit.agent-commit.v1\ntree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}\n${stripAgentTrailers(message)}\n`;

/** The trailer text for a commit message, signed by the agent's own key. */
export function trailerText(dir, id, { tree, parents, message }) {
  const keyB64 = (() => { const f = keyFile(dir, id); return existsSync(f) ? createPublicKey(createPrivateKey(readFileSync(f))).export({ type: "spki", format: "der" }).toString("base64") : null; })();
  if (!keyB64) throw new Error(`no key for ${id}`);
  const sig = signBytes(dir, id, commitPayload({ tree, parents, message }));
  return `Agent-Id: ${id}\nAgent-Key: ${fingerprintOf(keyB64)}\nAgent-Signature: ed25519:${sig}`;
}
export function parseTrailers(message) {
  const g = (k) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(message)?.[1]?.trim() ?? null;
  return { id: g("Agent-Id"), key: g("Agent-Key"), sig: (g("Agent-Signature") || "").replace(/^ed25519:/, "") || null };
}
/** → { ok, id, reason } for a commit against the table (the table of the BASE branch). */
export function verifyCommit(table, { tree, parents, message }, today = new Date().toISOString().slice(0, 10)) {
  const t = parseTrailers(message);
  if (!t.id) return { ok: false, id: null, reason: "no Agent-Id trailer" };
  const row = (table.rows || []).find((r) => r.id === t.id);
  if (!row) return { ok: false, id: t.id, reason: `${t.id} is not in the agent-identities table of the base branch (an agent identity needs the owner's signed approval first)` };
  if (row.revokedAt) return { ok: false, id: t.id, reason: `${t.id} was revoked on ${row.revokedAt}` };
  if (row.expiresAt < today) return { ok: false, id: t.id, reason: `the key of ${t.id} expired on ${row.expiresAt}` };
  if (t.key && t.key !== row.fingerprint) return { ok: false, id: t.id, reason: "the Agent-Key trailer is not the table's key" };
  if (!t.sig || !verifyBytes(row.publicKey, commitPayload({ tree, parents, message }), t.sig)) return { ok: false, id: t.id, reason: "the Agent-Signature does not verify" };
  return { ok: true, id: t.id, reason: "" };
}

export { slug };
