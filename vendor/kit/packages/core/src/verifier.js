/**
 * The REMOTE VERIFIER (docs/CONCEPTS.md section 5), pure and portable: the project's broker Worker (@saasreport/broker, kit #120) hosts it with its own bindings; the signing key is INJECTED.
 * Inside a process the agent controls, three things cannot be made trustworthy: the owner pin (an environment variable), the network and the code itself. So the CLI gate's answer is
 * authoritative only through THIS verifier, whose verdict the gate believes only when it is signed by the key the owner-signed record pins (verdict.js), bound to the commit, the
 * ledger head, the record, the content state and the gate's nonce.
 *
 *   request   { project, kind, sha, nonce }           everything else comes from the verifier's side: it reads the repository AT THE COMMIT itself
 *   context   { repo, owner, ownerKeys, db, source, signKey, floor }
 *               repo       the caller's AUTHENTICATED repository (an OIDC token), never the body (a body `repo` is ignored)
 *               source     reads the repository at `sha`: record(project), file(path), history(file, expect, ledger), contentState(kind, expect, ledger): the checks that need the repository
 *                          (git history, the content state) run THERE, on the verifier's own copy
 *               pin        the broker's pins for this project, outside the repository: { minSeq, verifier, witness }
 *               floor      the broker's pinned minimum, the owner-signed checkpoint's shape: { recordSeq, ledgers: { kind: { seq, hash } } }
 *   response  { ok, problems, now, verdict, signature }  the verdict is signed with the injected key, ok or not
 * A verdict never replaces the witness check: the verifier witnesses the record and the ledger itself, and the gate still checks the witness.
 */
import { verifyLedger, ledgerHead } from "./ledger.js";
import { verifyTrustRecord, recordHash, pinProblems } from "./trust.js";
import { recordTrustWitness, recordWitness, serverNow, readBodyBounded } from "./witness.js";
import { signVerdict, verifyVerdict, newNonce } from "./verdict.js";

const SHA = /^[0-9a-f]{40}$/, NONCE = /^[0-9a-f]{32}$/;

export async function verifyRequest(body, ctx = {}) {
  const { repo, owner, ownerKeys, db, source, signKey, floor, pin } = ctx, project = body?.project, kind = body?.kind;
  const bad = (m) => ({ ok: false, problems: [m], now: null });
  if (!/^[a-z0-9-]+$/.test(project || "") || !["shariah", "persian", "uploads"].includes(kind) || !SHA.test(body?.sha || "") || !NONCE.test(body?.nonce || "")) return bad("bad request: project, kind, a 40-hex sha and a 32-hex nonce are required");
  const pp = pinProblems(pin, { needVerifier: true }); if (pp.length) return bad(`the broker's own pin is required config (minSeq and the verifier): ${pp.join("; ")}`);
  if (!db) return bad("the verifier has no witness database: refused (fail closed)");
  if (!source || !signKey || !repo) return bad("the verifier needs its source reader, its signing key and the caller's authenticated repository: refused");
  const now = await serverNow(db), problems = [];
  let rec; try { rec = await source.record(project); } catch (e) { return bad(`the trust records could not be read: ${e.message}`); }
  const t = await verifyTrustRecord(rec, { project, repo, owner, ownerKeys, pin, now: now ? Date.parse(now) : null, nowSource: "the witness's clock" });
  let head = { seq: 0, hash: "" }, rHash = "", cHash = "";
  if (!t.ok) problems.push(...t.problems);
  else {
    rHash = t.approvals.record.hash;
    const record = t.approvals.record.body, tw = await recordTrustWitness(db, record, { owner, ownerKeys, repo, project, floor, pin });
    if (!tw.ok) problems.push(...tw.problems);
    const expect = t.approvals[kind];
    if (!expect) problems.push(`the owner-signed record names no ${kind} ledger for ${project}`);
    else {
      let ledger = null;
      try { ledger = JSON.parse(await source.file(expect.ledger)); } catch { problems.push(`${expect.ledger} at ${body.sha.slice(0, 12)} is missing or not JSON`); }
      if (ledger) {
        head = ledgerHead(ledger);
        const v = await verifyLedger(ledger, { expect, bootstrap: expect.bootstrap, ...(now ? { now: Date.parse(now) } : {}) });
        if (!v.ok) problems.push(...v.problems);
        else {
          const lw = await recordWitness(db, ledger, { expect, bootstrap: expect.bootstrap, floor: floor?.ledgers?.[kind], ...(now ? { now: Date.parse(now) } : {}) });
          if (!lw.ok) problems.push(...lw.problems);
        }
        problems.push(...(await source.history(expect.ledger, expect, ledger)));
        const cs = await source.contentState(kind, expect, ledger);
        problems.push(...cs.problems); cHash = cs.hash;
      }
    }
  }
  const signed = await signVerdict({ repo, sha: body.sha, ledgerHead: head, recordHash: rHash, contentHash: cHash, nonce: body.nonce, now, ok: !problems.length }, signKey);
  return { ok: !problems.length, problems, now, ...signed };
}

/** The Worker handler: `context(request)` → the broker's context (or null: unauthorized). The body is read with a streaming cap (readJson may be @saasreport/uploads/bounded's readBoundedJson). */
export function verifierEndpoint({ context, maxBytes = 1 << 20, readJson = null } = {}) {
  if (typeof context !== "function") throw new Error("verifierEndpoint: `context` is required (the broker's own owner pin, credential, database, source reader and signing key, and the caller's authenticated repository)");
  return async (request) => {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const ctx = await context(request);
    if (!ctx) return new Response("unauthorized", { status: 401 });
    let body;
    if (readJson) { try { body = await readJson(request, { maxBytes }); } catch (e) { return new Response(e?.message || "bad request", { status: e?.status || 400 }); } }
    else { const r = await readBodyBounded(request, maxBytes); if (r.error) return new Response("too large", { status: r.error }); try { body = JSON.parse(r.text); } catch { return new Response("bad request", { status: 400 }); } }
    const r = await verifyRequest(body, ctx);
    return new Response(JSON.stringify(r), { status: r.verdict ? 200 : 422, headers: { "content-type": "application/json" } });   // a refusal with a verdict is a 200: the verdict says ok:false
  };
}

/**
 * The CLI side: ask the verifier and check the SIGNED verdict. `pinned` = the owner-signed record's { url, publicKey }, `bind` = { repo, sha, ledgerHead, recordHash, contentHash }.
 * → { ok, problems }. Unreachable, unsigned, wrongly signed, replayed or for another state: a failure (the gate fails closed).
 */
export async function remoteVerify(fetchFn, pinned, token, request, bind) {
  const nonce = request.nonce ?? newNonce();
  try {
    const r = await fetchFn(pinned.url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...request, nonce }) });
    const j = await r.json().catch(() => null);   // an unreadable body is no verdict: verifyVerdict(null) refuses it on the next line
    const problems = await verifyVerdict(j, pinned.publicKey, { ...bind, nonce });
    return { ok: !problems.length, problems, now: j?.verdict?.now ?? null };
  } catch (e) { return { ok: false, problems: [`the remote verifier is unreachable (${e.message}): refused, the gate fails closed`], now: null }; }
}
void recordHash;
