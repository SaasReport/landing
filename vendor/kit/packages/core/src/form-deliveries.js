/**
 * The form-delivery ledger (kit.form-notification.v1, docs/FORMS.md): one row per form submission in comms_form_deliveries
 * (@saasreport/comms migration 0003), with the status of its two deliveries, the submitter's receipt and the owner's notification.
 * Written by the comms engine (POST /v1/comms/submit, reached through submitForm below); read by the site's GET /api/forms/deliveries[/<reference>] and, through it,
 * by the monitor's form-deliveries journey. Statuses only: no address, no submitted value. Runtime-neutral (a D1 binding in, data out).
 *
 *   submitForm(env, submission, { site })           the one call a site's form handler makes (below)
 *   requiredEngineSecrets(config), ownerSecretProblems(config, names)
 *                                                   the deploy gate: the comms-engine Worker holds forms.owner.secret (kit comms secrets)
 *   newReference(prefix), REFERENCE_RE              the reference of a submission: 80 bits, and the one pattern that accepts it
 *   lookupAllowed(db, ipHash, now)                  the per-client rate limit of GET /api/forms/deliveries/<reference>
 *   ledgerUrl(site, reference)                      <site>/api/forms/deliveries/<reference>
 *   recordOf(row, site)                             a D1 row → the kit.form-notification.v1 record
 *   readDelivery(db, reference, site)               the record, or null
 *   deliverySummary(db, { now, windowHours, pendingAfterMin })
 *                                                   counts over the window (kit.form-notification.v1 $defs.summary); ok is false when an
 *                                                   owner delivery failed or is still pending after pendingAfterMin
 */

export const DELIVERY_STATUSES = Object.freeze(["pending", "sent", "suppressed", "failed"]);
export const SUMMARY_DEFAULTS = Object.freeze({ windowHours: 24, pendingAfterMin: 15 });
export const OWNER_SECRET_NAMES = Object.freeze(["OPS_NOTIFY_TO"]);   // held equal to forms-config.schema.json forms.owner.secret and the registry set owner-secret-names by a test

// A reference is <prefix>-<16 characters of a 32-letter alphabet> = 80 bits from the platform CSPRNG. The ledger link in the owner's
// notification IS the reference (a bearer capability to a status record), so it is not guessable; the schema's pattern is this one.
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 32 letters: a byte maps without bias (256 / 32)
export const REFERENCE_CHARS = 16;
export const REFERENCE_BITS = REFERENCE_CHARS * Math.log2(REFERENCE_ALPHABET.length);
export const REFERENCE_RE = /^[A-Z][A-Z0-9]{0,3}-[A-HJ-NP-Z2-9]{16}$/;
export function newReference(prefix = "R") {
  if (!/^[A-Z][A-Z0-9]{0,3}$/.test(prefix)) throw new TypeError(`newReference: the prefix is 1-4 capital letters or digits, starting with a letter (got "${prefix}")`);
  return `${prefix}-${[...crypto.getRandomValues(new Uint8Array(REFERENCE_CHARS))].map((b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join("")}`;
}

/** GET /api/forms/deliveries/<reference> per client: at most `max` lookups in `windowMinutes` (the one source of the limit). */
export const LOOKUP_LIMIT = Object.freeze({ windowMinutes: 10, max: 30 });
export async function lookupAllowed(db, ipHash, now = new Date()) {
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  const since = new Date(t - LOOKUP_LIMIT.windowMinutes * 60_000).toISOString();
  await db.prepare("DELETE FROM comms_form_lookups WHERE at < ?").bind(since).run();
  // count and insert are ONE statement (atomic in SQLite and D1): concurrent lookups cannot all pass a count taken before any insert
  const r = await db.prepare("INSERT INTO comms_form_lookups (ip_hash, at) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM comms_form_lookups WHERE ip_hash = ?1 AND at >= ?3) < ?4")
    .bind(ipHash, new Date(t).toISOString(), since, LOOKUP_LIMIT.max).run();
  return Number(r?.meta?.changes) === 1;
}

/** The ts part of a drill header (the key of its row in comms_form_drills). */
export const drillTs = (value) => String(value).slice(0, String(value).indexOf("."));
/** What became of an accepted drill attempt: written to its comms_form_drills row (best effort: the attempt itself is already counted). */
export async function recordDrillOutcome(db, value, outcome) {
  try { await db.prepare("UPDATE comms_form_drills SET outcome = ? WHERE ts = ?").bind(String(outcome).slice(0, 40), drillTs(value)).run(); }
  catch (e) { console.error("[comms] drill: the outcome could not be recorded:", String(e?.message || e)); }
}

export const ledgerUrl = (site, reference) => `${String(site).replace(/\/$/, "")}/api/forms/deliveries/${encodeURIComponent(reference)}`;

/** A comms_form_deliveries row as the kit.form-notification.v1 record. */
export function recordOf(row, site = row.site) {
  return {
    reference: row.reference, form_id: row.form_id, site: row.site, test: Boolean(row.test), created_at: row.created_at, updated_at: row.updated_at ?? null,
    receipt: { status: row.receipt_status, dispatch_id: row.receipt_dispatch_id ?? null, error: row.receipt_error ?? null },
    owner: { status: row.owner_status, dispatch_id: row.owner_dispatch_id ?? null, error: row.owner_error ?? null },
    ledger_url: ledgerUrl(site, row.reference),
  };
}

export async function readDelivery(db, reference, site) {
  if (!REFERENCE_RE.test(String(reference || ""))) return null;
  const row = await db.prepare("SELECT * FROM comms_form_deliveries WHERE reference = ?").bind(reference).first();
  return row ? recordOf(row, site || row.site) : null;
}

export async function deliverySummary(db, { now = new Date(), windowHours = SUMMARY_DEFAULTS.windowHours, pendingAfterMin = SUMMARY_DEFAULTS.pendingAfterMin } = {}) {
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  const since = new Date(t - windowHours * 3_600_000).toISOString();
  const stale = new Date(t - pendingAfterMin * 60_000).toISOString();
  const r = await db.prepare(
    `SELECT COUNT(*) AS submissions,
            COALESCE(SUM(owner_status = 'sent'), 0) AS owner_sent,
            COALESCE(SUM(owner_status = 'failed'), 0) AS owner_failed,
            COALESCE(SUM(owner_status = 'pending' AND created_at < ?), 0) AS owner_pending_stale,
            COALESCE(SUM(receipt_status = 'failed'), 0) AS receipt_failed,
            MAX(CASE WHEN owner_status = 'failed' THEN created_at END) AS last_owner_failure_at,
            MAX(CASE WHEN test = 1 THEN created_at END) AS last_test_at
       FROM comms_form_deliveries WHERE created_at >= ?`
  ).bind(stale, since).first();
  // a drill attempt counts from the moment its header was accepted, whatever became of the submission (a 503 not_recorded leaves no
  // ledger row): the monitor drills once a day, so a failed attempt is done for the day, not retried by every later cron run
  const d = await db.prepare("SELECT MAX(seen_at) AS d FROM comms_form_drills WHERE seen_at >= ?").bind(since).first();
  const lastTest = [r?.last_test_at, d?.d].filter(Boolean).sort().at(-1) ?? null;
  const n = (k) => Number(r?.[k] || 0);
  return {
    ok: n("owner_failed") === 0 && n("owner_pending_stale") === 0,
    window_hours: windowHours, pending_after_min: pendingAfterMin,
    submissions: n("submissions"), owner_sent: n("owner_sent"), owner_failed: n("owner_failed"), owner_pending_stale: n("owner_pending_stale"),
    receipt_failed: n("receipt_failed"), last_owner_failure_at: r?.last_owner_failure_at ?? null,
    last_test_at: lastTest,
  };
}

// ---------- the client: the one call a site's form handler makes ----------

/**
 * Hand a submission to the project's comms engine (Service binding COMMS, POST /v1/comms/submit, kit.form-notification.v1
 * $defs.submission). The engine delivers it twice, the submitter's receipt and the owner's notification, and records both; the handler
 * never picks templates or recipients and never decides whether the owner hears of a submission. `kit check canon`
 * (form-bypasses-comms-submit) refuses a form handler that dispatches through the engine itself or reads the owner's recipients.
 *
 *   const out = await submitForm(env, { form_id, reference: newReference("C"), form_label, submitter: { email }, params, test }, { site });   // site: the origin, required
 *   out → { ok, receipt: "sent" | "suppressed" | "failed" | "pending", owner: "sent" | "failed" | "pending", error? }
 *
 * Never throws. A submission the engine never recorded (no binding, a refused or unreadable answer, an undeclared form, a 5xx) is
 * written to the ledger HERE, as a failed row with the reason (the site binds the same D1, env.DB), so the deliveries summary
 * counts it and the monitor goes red: a submission nobody recorded would be the silent class this path removes (review of 7cd5873).
 * `recorded` says whether any row exists; a caller never answers a visitor `ok` when it is false.
 */
const FAILED = (error, recorded = false) => ({ ok: false, recorded, receipt: "failed", owner: "failed", error });

/** The client-side failed row: written only when the engine did not record the submission (ON CONFLICT: the engine's row wins). */
async function recordFailure(env, submission, site, error) {
  if (!env?.DB) { console.error("[comms] submit: no DB to record the failure of", submission?.reference, error); return false; }
  try {
    const now = new Date().toISOString();
    const ref = String(submission?.reference || "");
    if (!REFERENCE_RE.test(ref)) { console.error("[comms] submit: no failure row for a reference that is not an 80-bit newReference:", ref.slice(0, 40)); return false; }
    await env.DB.prepare("INSERT INTO comms_form_deliveries (reference, form_id, site, test, created_at, updated_at, receipt_status, receipt_error, owner_status, owner_error) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, 'failed', ?) ON CONFLICT(reference) DO NOTHING")
      .bind(ref, String(submission?.form_id || "unknown").slice(0, 64), site, submission?.test === true ? 1 : 0, now, now, error.slice(0, 300), error.slice(0, 300)).run();
    return true;
  } catch (e) {
    console.error("[comms] submit: the failure of", submission?.reference, "could not be recorded either:", String(e?.message || e));
    return false;
  }
}

export async function submitForm(env, submission, { binding = "COMMS", url = "https://comms/v1/comms/submit", site } = {}) {
  // the row needs the site (comms_form_deliveries.site NOT NULL): a call without one is a programming error, refused before anything is sent
  if (typeof site !== "string" || !/^https:\/\/[^/\s]+/.test(site)) {
    console.error("[comms] submit: refused, the call names no site (submitForm(env, submission, { site: <origin> }))", submission?.reference);
    return FAILED("site_required");
  }
  // a legacy-shaped reference (R-xxxxxx, 30 bits) is not in this ledger: refused loudly, never dropped, nothing posted or written
  if (!REFERENCE_RE.test(String(submission?.reference ?? ""))) {
    console.error("[comms] submit: refused, the reference is not a newReference (<prefix>-16 characters)", String(submission?.reference ?? "").slice(0, 40));
    return FAILED("reference_invalid");
  }
  const fail = async (error) => FAILED(error, await recordFailure(env, submission, site, error));
  const comms = env?.[binding];
  if (!comms || typeof comms.fetch !== "function") return fail("comms_binding_missing");
  let res;
  try {
    res = await comms.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission) });
  } catch (e) {
    console.error("[comms] submit: the comms binding failed", submission?.reference, String(e?.message || e));
    return fail("comms_binding_error");
  }
  let out;
  try { out = await res.json(); } catch {
    console.error("[comms] submit: the comms engine answered", res.status, "with no JSON", submission?.reference);
    return fail(`comms_unreadable_${res.status}`);
  }
  const d = out?.delivery;
  if (!d) {
    console.error("[comms] submit: refused", res.status, out?.error, submission?.reference);
    return fail(`${out?.error || `comms_${res.status}`}${out?.field ? `:${out.field}` : ""}`);
  }
  // the engine answered with its record: the row exists, so the submission IS recorded. `outcome_recorded: false` says only that the
  // final status write failed (possibly after both emails went): the row stays pending, which the summary counts as failed once
  // stale, and a caller must not ask the visitor to submit again (a duplicate lead and duplicate emails)
  return { ok: Boolean(out.ok), recorded: true, ...(out.outcome_recorded === false ? { outcome_recorded: false } : {}), receipt: d.receipt.status, owner: d.owner.status, ...(out.ok ? {} : { error: d.owner.error || d.receipt.error || out.error || "delivery_failed" }) };
}

// ---------- build-time coverage: every form a site posts is a form the engine delivers ----------

/**
 * Problems when a site's form ids (its lead forms, events.rsvpForm when RSVP is on) are not all declared in the comms config:
 * such a form would be refused by the engine (404 undeclared_form) and nobody would hear of it. `kit comms check` runs it.
 */
export function formCoverageProblems(siteFormIds, commsConfig) {
  const declared = new Set(commsConfig?.forms?.declared || (commsConfig?.templates || []).map((t) => t.key));
  return [...new Set(siteFormIds)].filter((id) => !declared.has(id)).map((id) => `form "${id}" is posted by the site but not declared in the comms config (forms.declared / templates): the engine would refuse it and nobody would hear of it`);
}

// ---------- the drill flag: a test submission is accepted only from the monitor (a signed header) ----------

export const DRILL_HEADER = "x-kit-form-drill";
export const DRILL_SECRET = "FORMS_DRILL_KEY";
const DRILL_WINDOW_MS = 5 * 60_000;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
}
/** The header value the monitor sends: <unix ms>.<hmac(key, "<ms>.<form id>")>: bound to one form, accepted once (acceptDrill). */
export async function signDrill(key, formId, now = Date.now()) {
  const ts = String(Math.floor(now));
  return `${ts}.${await hmac(key, `${ts}.${formId}`)}`;
}
/**
 * Is `value` a drill header signed with `key` for this form within the last five minutes? Constant-time compare; no key (the Worker
 * has no FORMS_DRILL_KEY) means no drill is ever accepted. The signature alone proves nothing about freshness within the window:
 * acceptDrill also records the timestamp and refuses a second use.
 */
export async function verifyDrill(key, formId, value, now = Date.now()) {
  if (!key || typeof value !== "string" || value.length > 120) return false;
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const ts = value.slice(0, dot), sig = value.slice(dot + 1);
  if (!/^[0-9]{1,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(now - Number(ts)) > DRILL_WINDOW_MS) return false;
  const want = await hmac(key, `${ts}.${formId}`);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/**
 * A drill header accepted ONCE: verifyDrill, then the timestamp is written to comms_form_drills (PRIMARY KEY ts); a timestamp already
 * there is a replay and is refused. Fails closed: no ledger, or a write that fails, accepts nothing.
 */
export async function acceptDrill(db, key, formId, value, now = Date.now()) {
  if (!db || !(await verifyDrill(key, formId, value, now))) return false;
  try {
    await db.prepare("DELETE FROM comms_form_drills WHERE seen_at < ?").bind(new Date(now - 48 * 60 * 60_000).toISOString()).run();   // kept two days: it is also the record of the day's drill attempt (deliverySummary)
    const r = await db.prepare("INSERT INTO comms_form_drills (ts, form_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(ts) DO NOTHING").bind(value.slice(0, value.indexOf(".")), formId, new Date(now).toISOString()).run();
    return Number(r?.meta?.changes) === 1;
  } catch (e) {
    console.error("[comms] drill: the replay ledger could not be written, so no drill is accepted:", String(e?.message || e));
    return false;
  }
}


// ---------- the deploy gate: the engine holds the owner's recipients ----------

/** The secret names a project's comms-engine Worker must hold (from its comms config's forms.owner.secret). */
export function requiredEngineSecrets(config) {
  const secret = config?.forms?.owner?.secret;
  return (config?.templates || []).length ? [secret || "forms.owner.secret (not declared)"] : [];
}

/**
 * Problems when the comms-engine Worker's secret NAMES (`names`, from `wrangler secret list`) lack the owner's address, or when the deploy
 * environment's VALUE of that secret (`value`, read from the deploy job's own environment; undefined when it does not hold it) is not the
 * project's own info@ (forms.owner.address); [] when it may deploy. Never prints the value: a mismatch is reported without it.
 */
export function ownerSecretProblems(config, names, { value, requireValue = false } = {}) {
  const have = new Set(names || []);
  const out = requiredEngineSecrets(config).filter((n) => !have.has(n)).map((n) =>
    `${config.project}-comms-engine lacks the secret ${n}: the owner's address for every form (kit.forms-config.v1), the project's own ${config?.forms?.owner?.address || "info@<domain>"}. The owner sets it: wrangler secret put ${n} -c workers/comms-engine/wrangler.toml`);
  const secret = config?.forms?.owner?.secret;
  const want = String(config?.forms?.owner?.address || "").toLowerCase();
  if (secret && value === undefined && requireValue) out.push(`the deploy environment does not hold ${secret}: it cannot be checked against forms.owner.address (${want})`);
  if (secret && value !== undefined && String(value).trim().toLowerCase() !== want) out.push(`the deploy environment's ${secret} is not the project's own ${want} (forms.owner.address): one address per project, its info@ (value not shown)`);
  return out;
}
