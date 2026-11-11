/**
 * The approval ledger: the ONE append-only, hash-chained, signed record of human sign-offs, used by every gate that needs a named person's approval
 * of a content hash (the Shariah concept ledger and the Persian fa-review ledger). It only VERIFIES (asynchronously, WebCrypto Ed25519); signing happens
 * on the approver's own device with a key no agent holds.
 *
 * LEDGER (kit.approval-ledger.v1)
 *   { $schema, id, project, kind, subject, anchor: { commit, genesis, baselineThrough, migratedFrom? }, entries: [...] }
 *   id = "<project>:<kind>", project and kind come from the kit project registry (never from the project's own config), subject is "id" or "file".
 *
 * SIGNED BODY (stable: the browser signing page builds exactly this)
 *   body  = canonicalJson({ v: 1, ledger: <id>, project, kind, ...entry without `sig` })
 *   sig   = base64( Ed25519( UTF-8(body) ) )    -- canonicalJson: keys sorted, no whitespace, undefined omitted, JSON.stringify strings
 *   entry = { seq, <id|file>, sha256, status, by, at, prev, attests?, statement?, segments?, note? }      subject entries
 *         | { seq, member: { name, publicKey }, sha256 = sha256(canonicalJson(member)), status: "roster-add" | "roster-remove", by, at, prev } roster entries
 *   at    = UTC "YYYY-MM-DDTHH:MM:SS(.sss)Z" only, not more than FUTURE_SKEW_MS ahead of the verifier's clock; never earlier than the entry before it
 *   prev  = sha256(canonicalJson(previous entry, signature included)); the first entry's prev is genesis = sha256("kit.approval-ledger.v1:anchor:" + anchor.commit)
 *   Because the ledger id, project and kind are in the signed body, a signature made for one ledger is worthless in another.
 *
 * RULES
 *   - Entries are never rewritten or re-sorted. The chain is always verified in full.
 *   - Roster: the bootstrap members come from the kit project registry; afterwards a member is added or removed only by a roster-add / roster-remove
 *     entry signed by a member already in the roster. Keys must be canonical, prime-order Ed25519 points; names are unique.
 *   - Latest wins, with a VETO: a withdrawal (or rejection) by ANY roster member holds the subject until the SAME member approves it again, or a
 *     strict majority of the current roster (each with an approval of the same content hash after the hold) lifts it. An approval that does not
 *     lift a hold is recorded but ineffective.
 *   - baseline entries (copy live before the gate, or migrated) are unsigned, only inside anchor.baselineThrough, and are never approvals.
 *   - Truncation and rollback are invisible to a chain alone: a verifier compares the head with a MONOTONIC WITNESS (witnessProblems) kept outside the
 *     ledger file, and the CLI walks git history (every commit against every parent). See witness.js and docs/CONCEPTS.md.
 */
import { sha256 } from "./sha256.js";
import { canonicalJson } from "./canonical.js";
import { ed25519Verify, checkPublicKey } from "./ed25519.js";

export const LEDGER_VERSION = "kit.approval-ledger.v1";
export const SIGNED_STATUSES = ["approved", "rejected", "withdrawn"];
/**
 * The ledger KINDS and the entry actions each declares. One signing format and one verifier serve every decision stream: Shariah concept approval, Persian native review and the
 * upload decisions of #112 (`uploads`: release, hold, unhold, rescan, delete). An entry's `status` must be an action of the ledger's kind (checkAppend refuses anything else) and,
 * when the owner-signed record gives the member `actions`, one of THEIR actions. `veto` kinds hold a subject after a withdrawal or rejection (see below); the uploads kind's state
 * is simply its latest action, whose authority is the member's scope.
 */
export const LEDGER_KINDS = {
  shariah: { subject: "id", actions: ["approved", "rejected", "withdrawn"], veto: true },
  persian: { subject: "file", actions: ["approved", "rejected", "withdrawn"], veto: true },
  uploads: { subject: "id", actions: ["release", "hold", "unhold", "rescan", "delete"], veto: false },
};
/** The pin of a baseline set: sha256 of the canonical JSON of the [{ file, sha256 }] pairs sorted by file. The OWNER signs it into the trust record (`baseline`); the verifier refuses any baseline entry otherwise. */
export const baselineHash = (items) => sha256(canonicalJson([...items].map((x) => ({ file: x.file, sha256: x.sha256 })).sort((p, q) => (p.file < q.file ? -1 : p.file > q.file ? 1 : 0))));
/** The witness key of a ledger: its id and its EPOCH (the genesis of its anchor), so a ledger replaced under a new owner-signed anchor is a new, empty epoch and the old one stays recorded. */
export const witnessKey = (ledger) => `${ledger.id}@${ledger.anchor?.genesis}`;
export const kindActions = (kind) => LEDGER_KINDS[kind]?.actions ?? [];
export const ROSTER_STATUSES = ["roster-add", "roster-remove", "roster-rotate"];
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const PROPOSAL_MAX_MS = 14 * 24 * 3600 * 1000;   // a roster proposal lives at most 14 days (its signed `expires`)
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** The previous-hash of the first entry: the sha256 of the commit the chain is anchored at. */
export const genesisFor = (commit) => sha256(`${LEDGER_VERSION}:anchor:${commit}`);
export const ledgerId = (project, kind) => `${project}:${kind}`;
/** What the approver signs (see the format above). */
export const signedBody = (ledger, entry) => { const { sig: _sig, ...e } = entry; return canonicalJson({ v: 1, ledger: ledger.id, project: ledger.project, kind: ledger.kind, ...e }); };
/** The hash the next entry carries as `prev`: the whole entry, signature included. */
export const entryHash = (e) => sha256(canonicalJson(e));
export const memberHash = (member) => sha256(canonicalJson({ name: member.name, publicKey: member.publicKey, ...(member.actions ? { actions: member.actions } : {}) }));
/** The head of a ledger: { seq, hash } (hash = genesis for an empty ledger). */
export const ledgerHead = (ledger) => { const n = ledger.entries.length; return { seq: n, hash: n ? entryHash(ledger.entries[n - 1]) : ledger.anchor.genesis }; };
/** The entry a new approval would be, without its signature (the signer adds `sig` over signedBody(ledger, entry)). */
export function nextEntry(ledger, fields) {
  return { seq: ledger.entries.length + 1, ...fields, prev: ledgerHead(ledger).hash };
}
const quorum = (n) => Math.floor(n / 2) + 1;
/** The subject of an entry (a concept id or a file), if it has one. */
export const subjectOf = (ledger, e) => e?.[ledger?.subject];

/**
 * Verifies the ledger: header against what the registry expects, the full chain, the roster's evolution, every signature, and the veto state machine.
 *   expect     { id, project, kind, subject, anchor? }  from the kit project registry
 *   bootstrap  [{ name, publicKey }]                     the registry's first roster
 *   now        ms since epoch (default Date.now()); entries later than now + FUTURE_SKEW_MS are refused
 * → { ok, problems, subjects: Map(subject → { status, sha256, entry }), roster, head }   `subjects` is EMPTY when anything is wrong (fail closed).
 */
export async function verifyLedger(ledger, { expect = null, bootstrap = [], now = Date.now() } = {}) {
  const problems = [], entries = ledger?.entries || [], key = ledger?.subject;
  if (key !== "id" && key !== "file") problems.push(`subject must be "id" or "file" (got ${JSON.stringify(key)})`);
  if (expect) {
    for (const f of ["id", "project", "kind", "subject"]) if (expect[f] !== undefined && ledger?.[f] !== expect[f]) problems.push(`${f} is "${ledger?.[f]}", but the kit project registry says "${expect[f]}" (the ledger's identity is not the project's to choose)`);
    if (expect.anchor && ledger?.anchor?.commit !== expect.anchor) problems.push(`anchor.commit is not the commit the registry records (${String(expect.anchor).slice(0, 12)})`);
  }
  const a = ledger?.anchor;
  if (!a || !/^[0-9a-f]{40}$/.test(a.commit || "")) problems.push("anchor.commit must be the 40-hex git commit the chain is anchored at");
  else if (a.genesis !== genesisFor(a.commit)) problems.push("anchor.genesis does not match sha256 of the anchor commit (the anchor was edited)");
  if (!Number.isInteger(a?.baselineThrough) || a.baselineThrough < 0) problems.push("anchor.baselineThrough must be a whole number");

  const roster = new Map();   // name -> publicKey (the CURRENT roster; a rotated key's earlier entries were verified against the key active when they were signed)
  const keyUse = () => [...roster.values()];
  const scopes = new Map();   // name -> allowed actions | null (every action of the kind); from the owner-signed record or a majority-signed roster-add
  const kindAct = kindActions(ledger?.kind);
  const seed = (r, where) => {
    const bad = checkPublicKey(r.publicKey);
    if (r.actions !== undefined && (!Array.isArray(r.actions) || !r.actions.length || r.actions.some((a) => !kindAct.includes(a)))) { problems.push(`${where}: ${r.name}'s actions must be a non-empty subset of the ${ledger?.kind} kind's actions (${kindAct.join(", ")})`); return; }
    if (!r.name || roster.has(r.name)) problems.push(`${where}: roster name "${r.name}" is missing or duplicated`);
    else if (bad) problems.push(`${where}: ${r.name}'s public key is ${bad}`);
    else if (keyUse().includes(r.publicKey)) problems.push(`${where}: ${r.name}'s public key is already another member's`);
    else { roster.set(r.name, r.publicKey); scopes.set(r.name, r.actions ?? null); }
  };
  for (const r of bootstrap) seed(r, "registry roster");
  // migration: only the one old file the owner-signed record names, only for a ledger kind that has an old format
  const mig = a?.migratedFrom;
  if (mig) {
    if (!expect?.migration) problems.push("anchor.migratedFrom is present, but the owner-signed record records no migration for this ledger (a Shariah ledger has none, and a persian one only the one the owner signed)");
    else if (mig.sha256 !== expect.migration.sha256 || mig.entries !== expect.migration.entries) problems.push("anchor.migratedFrom is not the migration the owner-signed record names");
  }

  const subjects = new Map(), tasks = [], proposals = new Map();
  let prevHash = a?.genesis, prevAt = -Infinity;
  entries.forEach((e, i) => {
    const at = `entry ${i + 1}${e?.[key] ? ` (${e[key]})` : e?.member ? ` (${e.member.name})` : ""}`;
    if (e.seq !== i + 1) problems.push(`${at}: seq ${e.seq}, expected ${i + 1} (entries are never re-sorted or removed)`);
    if (e.prev !== prevHash) problems.push(`${at}: prev does not match the previous entry (an entry before it was edited, back-dated, reordered or deleted)`);
    if (!AT.test(e.at || "") || !Number.isFinite(Date.parse(e.at))) problems.push(`${at}: at must be a UTC timestamp ending in Z`);
    else {
      if (Date.parse(e.at) > now + FUTURE_SKEW_MS) problems.push(`${at}: at ${e.at} is in the future (more than ${FUTURE_SKEW_MS / 60000} minutes ahead): refused, so a far-future entry cannot freeze the ledger`);
      if (Date.parse(e.at) < prevAt) problems.push(`${at}: at ${e.at} is earlier than the entry before it (${new Date(prevAt).toISOString()}): back-dated`);   // instants, not strings
      prevAt = Math.max(prevAt, Date.parse(e.at));
    }
    prevHash = entryHash(e);
    if (e.status === "baseline") {
      if (i >= (a?.baselineThrough ?? 0)) problems.push(`${at}: a baseline is only allowed in the first ${a?.baselineThrough ?? 0} entries (anchor.baselineThrough): copy live before the gate, recorded once`);
      if (e.sig) problems.push(`${at}: a baseline carries no signature`);
      if (e[key] != null) subjects.set(e[key], { status: "baseline", sha256: e.sha256, entry: e, hold: null });
      return;
    }
    const signed = kindAct.includes(e.status) || ROSTER_STATUSES.includes(e.status);
    if (!signed) { problems.push(`${at}: "${e.status}" is not an action of the ${ledger?.kind} kind (${kindAct.join(", ")})`); return; }
    const pk = roster.get(e.by);
    if (!e.by || !pk) { problems.push(`${at}: ${e.status} by "${e.by ?? ""}", who is not in the reviewer roster at this point of the chain`); return; }
    if (!ROSTER_STATUSES.includes(e.status) && scopes.get(e.by) && !scopes.get(e.by).includes(e.status)) problems.push(`${at}: ${e.by} is not permitted the action "${e.status}" (the owner-signed record scopes them to ${scopes.get(e.by).join(", ")})`);
    if (!e.sig) problems.push(`${at}: an unsigned ${e.status}`);
    else tasks.push({ at, pk, body: signedBody(ledger, e), sig: e.sig, by: e.by });   // pk is the key ACTIVE at this entry: a later rotation never breaks it
    if (ROSTER_STATUSES.includes(e.status)) {
      const m = e.member;
      if (!m || e.sha256 !== memberHash(m)) { problems.push(`${at}: the roster entry's sha256 is not the hash of its member`); return; }
      if (e.status === "roster-rotate") {
        // a rotation is the member's own act, signed with their CURRENT key; their name, holds and history carry over
        if (m.name !== e.by) { problems.push(`${at}: a rotation is signed by the member whose key changes`); return; }
        const bad = checkPublicKey(m.publicKey);
        if (bad) problems.push(`${at}: ${m.name}'s new key is ${bad}`);
        else if (keyUse().includes(m.publicKey)) problems.push(`${at}: the new key is already a member's`);
        else roster.set(m.name, m.publicKey);
        return;
      }
      // add / remove: a proposal that takes effect when a strict majority of the CURRENT roster has signed the same one (never one member alone)
      if (roster.size < 2) { problems.push(`${at}: ${e.status} on a roster of ${roster.size}: a one-member roster changes only through the owner-signed trust record (no member adds their own second key or removes themselves)`); return; }
      // a proposal EXPIRES (a signed `expires`, at most 14 days after it was signed): a stale one can never be completed later by a changed roster
      if (!AT.test(e.expires || "") || !(Date.parse(e.expires) > Date.parse(e.at)) || Date.parse(e.expires) - Date.parse(e.at) > PROPOSAL_MAX_MS) { problems.push(`${at}: a roster proposal carries a signed expiry after its time and within 14 days (expires)`); return; }
      const pid = `${e.status}|${e.sha256}`, sig = proposals.get(pid) || new Map();
      sig.set(e.by, { seq: i + 1, expires: e.expires }); proposals.set(pid, sig);
      const agree = [...sig].filter(([n, s]) => roster.has(n) && Date.parse(s.expires) >= Date.parse(e.at)).length;
      if (agree < quorum(roster.size)) return;
      proposals.delete(pid);
      // what the signers' owner-signed scopes allow together (null: every signer is unscoped, so nothing is limited)
      let allowed = null;
      for (const n of sig.keys()) { const sc = scopes.get(n); if (roster.has(n) && sc) allowed = allowed ? allowed.filter((a) => sc.includes(a)) : [...sc]; }
      if (e.status === "roster-add") {
        // a member added by a majority can hold no more than the signers hold: scoped signers cannot mint an unscoped (or wider) member, so the owner-signed scopes cannot be outgrown
        if (roster.has(m.name)) problems.push(`${at}: roster name "${m.name}" is duplicated`);
        else if (sig.has(m.name)) problems.push(`${at}: a member cannot add their own second key`);
        else if (allowed && (!Array.isArray(m.actions) || m.actions.some((a) => !allowed.includes(a)))) problems.push(`${at}: an added member carries actions limited to what the signers hold (${allowed.join(", ") || "none"}): scoped members cannot add a wider or unscoped one`);
        else seed(m, at);
      }
      else if (!roster.has(m.name) || roster.get(m.name) !== m.publicKey) problems.push(`${at}: roster-remove of "${m.name}", who is not in the roster with that key`);
      else if (allowed && (!scopes.get(m.name) || scopes.get(m.name).some((a) => !allowed.includes(a)))) problems.push(`${at}: a removal needs signers whose scopes cover the removed member's (${allowed.join(", ") || "none"} here): scoped members cannot remove a wider or unscoped one, so the owner-signed scopes cannot be outgrown`);
      else if ([...subjects.values()].some((s) => s.hold?.by === m.name)) problems.push(`${at}: ${m.name} has an open hold (a withdrawal or rejection): they cannot be removed until it is resolved`);
      else roster.delete(m.name);
      return;
    }
    // subject entry: the veto state machine. A hold is judged against the roster AT THE TIME it was placed.
    const s = e[key];
    if (!LEDGER_KINDS[ledger?.kind]?.veto) { subjects.set(s, { status: e.status, sha256: e.sha256, entry: e, hold: null }); return; }   // uploads: the latest action is the state
    let st = subjects.get(s) || { status: "none", sha256: null, entry: null, hold: null };
    if (e.status === "approved") {
      if (st.hold) {
        if (e.by === st.hold.by) st = { status: "approved", sha256: e.sha256, entry: e, hold: null };
        else if (st.hold.members.has(e.by)) {
          st.hold.pending.set(e.by, e.sha256);
          const agree = [...st.hold.pending].filter(([n, h]) => h === e.sha256 && roster.has(n)).length;
          if (agree >= st.hold.need) st = { status: "approved", sha256: e.sha256, entry: e, hold: null };
        }
      } else st = { status: "approved", sha256: e.sha256, entry: e, hold: null };
    } else st = { status: e.status, sha256: e.sha256, entry: e, hold: { by: e.by, members: new Set(roster.keys()), need: quorum(roster.size), pending: new Map() } };
    subjects.set(s, st);
  });
  // baselines are the OWNER's: the owner-signed record pins exactly this set (and a non-null anchor); no pin, no baseline
  const base = entries.filter((e) => e.status === "baseline");
  if (base.length) {
    if (!expect?.baseline) problems.push("the ledger has baseline entries, but the owner-signed trust record pins no baseline: a baseline counts as approved copy, so only the owner's signed pin can create one");
    else if (!expect.anchor) problems.push("a baseline needs the owner-signed record's anchor (the commit the baseline was taken at)");
    else if (expect.baseline.entries !== base.length || expect.baseline.sha256 !== baselineHash(base)) problems.push("the baseline entries are not the set the owner-signed trust record pins (file and hash, every one)");
  }
  const results = await Promise.all(tasks.map((t) => ed25519Verify(t.pk, t.body, t.sig)));
  results.forEach((ok, i) => { if (!ok) problems.push(`${tasks[i].at}: the signature is not ${tasks[i].by}'s over this entry in this ledger (forged, edited or replayed from another ledger)`); });
  return { ok: !problems.length, problems, subjects: problems.length ? new Map() : subjects, roster: [...roster].map(([name, publicKey]) => ({ name, publicKey })), head: ledgerHead(ledger || { entries: [], anchor: {} }) };
}

const cache = new WeakMap();
/** verifyLedger memoized per ledger object, expectation and bootstrap (the same ledger is asked about many concepts). → Promise */
export function verifiedLedger(ledger, opts = {}) {
  if (!ledger) return Promise.resolve({ ok: false, problems: ["no ledger: with nothing to verify nothing is approved, and absence is not a clean bill"], subjects: new Map(), roster: opts.bootstrap || [], head: null });
  const k = canonicalJson({ e: opts.expect ?? null, b: opts.bootstrap ?? [] });
  let m = cache.get(ledger);
  if (!m) { m = new Map(); cache.set(ledger, m); }
  if (!m.has(k)) m.set(k, verifyLedger(ledger, opts));
  return m.get(k);
}

/**
 * Monotonic witness: `seen` is the highest { seq, hash } any verifier has recorded for this ledger in an append-only store kept OUTSIDE the ledger
 * file (witness.js: a D1 table with append-only triggers at run time; a file outside the repository in CI). A ledger whose head is behind it (rollback,
 * truncation, a hidden withdrawal) or that disagrees with it at its position (a fork) is refused. → string[] (empty when fine)
 */
/**
 * What a signer (the CLI, the browser signing page) calls BEFORE writing: would the ledger still verify with this entry appended? A verification-refused entry is never
 * appended, so two members cannot brick a ledger by signing something the verifier rejects (a stale proposal, a removal of a vetoer, a weak key, ...).
 * → { ok, problems } for the candidate ledger. `ctx` is verifyLedger's ({ expect, bootstrap, now }).
 */
export async function checkAppend(ledger, entry, ctx) {
  const candidate = { ...ledger, entries: [...ledger.entries, entry] };
  const v = await verifyLedger(candidate, ctx);
  return { ok: v.ok, problems: v.problems };
}

export function witnessProblems(ledger, seen, { required = false } = {}) {
  const j = witnessJudge(ledger, seen, { required });
  return j ? [j.message] : [];
}
/** Typed form of witnessProblems: { code: "missing" | "behind" | "fork", message } | null. The endpoint chooses its HTTP status from `code`, never from the wording. */
export function witnessJudge(ledger, seen, { required = false } = {}) {
  if (!seen) return required ? { code: "missing", message: "no witness is recorded for this ledger, but the owner-signed record requires one: refused (a missing witness fails closed)" } : null;
  const h = ledgerHead(ledger);
  if (h.seq < seen.seq) return { code: "behind", message: `the ledger's head (seq ${h.seq}) is behind the witnessed head (seq ${seen.seq}): the ledger was rolled back or truncated` };
  const at = seen.seq === 0 ? ledger.anchor.genesis : entryHash(ledger.entries[seen.seq - 1]);
  if (at !== seen.hash) return { code: "fork", message: `the ledger disagrees with the witnessed head at seq ${seen.seq}: it was forked or rewritten after it was seen` };
  return null;
}
