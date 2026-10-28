/**
 * The Comms Engine Worker: the single dispatch point for every outbound email of a project.
 *
 * The comms-engine Worker (constitution §38, Comms Rail): templates are declared in
 * specs/manifest.json, compiled from canonical blocks, filtered through the suppression list, delivered via
 * the `<project>-mail-sender` Service binding (MAIL_SENDER) and audited in D1 (DB).
 *
 * Red line: nothing on the site calls the mail primitive directly. This Worker has no public route; callers
 * reach it via Service binding.
 *
 * Endpoints (service binding):
 *   POST /v1/comms/dispatch   — compile + suppress + send + audit; `notices: { audiences, jurisdictions }`
 *                               picks the recipient's legal-notice blocks (default: the template's notice_default)
 *   POST /v1/comms/submit     — a form submission (kit.form-notification.v1 $defs.submission): recorded in comms_form_deliveries,
 *                               then delivered twice, the submitter's receipt and the owner's notification (recipients: the engine
 *                               secret forms.owner.secret); answers the record. The forms' templates are sent ONLY here: a dispatch
 *                               of one of them is refused (409 form_template_requires_submit), so no handler can send the receipt alone.
 *   POST /v1/comms/suppress   — add to suppression list
 *   GET  /v1/comms/manifest   — manifest snapshot: every template with the params it requires (required_params)
 *   GET  /healthz
 *
 * onEvent(type, data, env, ctx) (optional): called after each dispatch with a normalised event for outbound webhooks
 * ("comms.dispatched", "comms.failed", "comms.suppressed"; data has ids, template, channel, category and counts, never an
 * address). Wire it to @saasreport/channels webhookEvent + @saasreport/cloudflare/webhooks enqueueWebhooks.
 *
 * A project's Worker entry is a few lines:
 *   import { createCommsEngine } from "@saasreport/comms/engine";
 *   export default createCommsEngine({ config, specs: { manifest, blocks, links, providers } });
 */
import { readJsonBody } from "@saasreport/cloudflare/body";
import { compileTemplate } from "./compiler.js";
import { dispatchEmail } from "./dispatcher.js";
import { emitAuditChain } from "./audit.js";
import { isSuppressed, addSuppression, SUPPRESSION_REASONS } from "./suppression.js";
import { engineRuntime, copyrightYears } from "../../src/runtime.js";
import { ledgerUrl, recordOf, REFERENCE_RE } from "@saasreport/core/form-deliveries";

export { compileTemplate, dispatchEmail, emitAuditChain, isSuppressed, addSuppression };

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s || ""));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the engine for one project: `config` is its comms config (or pass `runtime` from engineRuntime),
 * `specs` the generated spec files. Returns { fetch, dispatchCore, submitCore } — export it as the Worker default.
 */
/** Reached by Service binding only, so a Content-Length is not required; the cap still applies while the body streams. */
const BODY = Object.freeze({ maxBytes: 256 * 1024, contentLength: "optional" });

export function createCommsEngine({ config, runtime, specs, onEvent }) {
  const rt = runtime || engineRuntime(config);
  const { manifest, blocks, links, providers } = specs;
  const TEMPLATES = new Map(manifest.templates.map((t) => [t.template_id, t]));
  // a suppress_when reason no rule reads would silently never suppress: refused when the engine is built
  for (const t of manifest.templates) for (const r of t.suppress_when || []) if (!SUPPRESSION_REASONS.includes(r)) throw new Error(`template ${t.template_id}: unknown suppression reason "${r}" in suppress_when (${SUPPRESSION_REASONS.join(", ")})`);
  const BLOCKS = new Map(blocks.blocks.map((b) => [b.block_id, b]));
  const LINKS = new Map(links.links.map((l) => [l.link_id, l]));
  const PROVIDERS = new Map(providers.providers.map((p) => [p.id, p]));
  const P = rt.idPrefix;
  const TENANT = `${P}:tenant:platform`;
  const ACTOR = `${P}:engine:platform:comms`;
  const MAIL_URL = `https://${rt.mailSenderName}/send`;
  const shellFor = (tpl) => rt.shells[tpl.locale] || rt.shells[rt.primaryLocale];
  // the declared forms (manifest.forms, kit.forms-config.v1): their templates go out through submitCore only
  const FORMS = new Map((manifest.forms || []).map((f) => [f.form_id, f]));
  // the autoreply of a form exists once per declared locale (ack_templates, keyed by language); the primary one is ack_template_id.
  // Every variant is a form template (refused on plain dispatch), and a submission's locale picks its variant
  const ackVariants = (f) => [...new Set([f.ack_template_id, ...Object.values(f.ack_templates || {})])];
  const FORM_TEMPLATES = new Set([...FORMS.values()].flatMap((f) => [...ackVariants(f), f.owner_template_id]));
  for (const id of FORM_TEMPLATES) if (!TEMPLATES.has(id)) throw new Error(`manifest.forms names template ${id}, which the manifest does not hold`);
  const OWNER_SECRET = manifest.owner?.secret || rt.ownerSecret;
  const OWNER_ADDRESS = String(manifest.owner?.address || "").toLowerCase();   // the project's own info@ (forms.owner.address)
  if (FORMS.size && !OWNER_ADDRESS.startsWith("info@")) throw new Error("manifest.owner.address: the project's own info@ address is required (forms.owner.address)");
  // every autoreply carries the project's standard signature and legal footer (one kit template, filled from the config): a form whose
  // acknowledgement lacks either is refused when the engine is built, so no submitter ever gets a reply without them
  for (const [f, ackId] of [...FORMS.values()].flatMap((f) => ackVariants(f).map((id) => [f, id]))) {
    const kinds = new Set((TEMPLATES.get(ackId).body_blocks || []).map((id) => (BLOCKS.get(id)?.kind === "legal" && String(id).startsWith("footer.legal.") ? "footer" : BLOCKS.get(id)?.kind)));
    for (const k of ["header", "signature", "footer"]) if (!kinds.has(k)) throw new Error(`form ${f.form_id}: its autoreply ${ackId} has no ${k === "footer" ? "legal footer" : k} block: every autoreply carries the project's standard ${k === "footer" ? "legal footer" : k}`);
  }

  function resolveProvider(channel, category) {
    for (const r of providers.routing) {
      if (r.channel !== channel) continue;
      if (r.category_match !== "*" && r.category_match !== category) continue;
      const p = PROVIDERS.get(r.provider);
      if (p) return p;
    }
    return null;
  }

  /** Hand a normalised event to onEvent without ever failing the dispatch. */
  const emit = (type, data, env, ctx) => {
    if (typeof onEvent !== "function") return;
    const p = Promise.resolve().then(() => onEvent(type, data, env, ctx)).catch((e) => console.error(`[${P}-comms] onEvent ${type} failed`, String(e)));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  };

  /** `via` is internal: { submit: true, subjectPrefix } from submitCore, the only caller allowed to send a form's templates. */
  async function dispatchCore(body, env, ctx, via = {}) {
    const out = (payload, status = 200) => ({ status, payload });
    const { template_id, to, params: callerParams = {}, idempotency_key, tenant_id = TENANT, notices } = body || {};
    if (FORM_TEMPLATES.has(template_id) && via.submit !== true) {
      // a handler sending a form's receipt (or the owner alert) itself is the receipt-only path: refused, the form goes through submit
      return out({ ok: false, error: "form_template_requires_submit", template_id, detail: "a declared form is delivered through POST /v1/comms/submit (submitForm), which sends the receipt and the owner's notification together" }, 409);
    }
    const params = { ...copyrightYears(rt.years, rt.timeZone), ...callerParams };
    if (!template_id) return out({ ok: false, error: "missing_template_id" }, 400);
    if (!Array.isArray(to) || !to.length) return out({ ok: false, error: "missing_recipients" }, 400);

    const tpl = TEMPLATES.get(template_id);
    if (!tpl) return out({ ok: false, error: "unknown_template", template_id }, 404);
    for (const p of tpl.required_params || []) {
      if (params[p] === undefined) return out({ ok: false, error: "missing_param", param: p, template_id }, 400);
    }

    const compiled = compileTemplate({ template: tpl, blocks: BLOCKS, links: LINKS, params, shell: shellFor(tpl), notices });
    if (!compiled.ok) return out({ ok: false, error: compiled.error, detail: compiled.detail }, compiled.status || 500);
    if (via.subjectPrefix) compiled.subject = `${via.subjectPrefix}${compiled.subject}`;   // a test submission: [TEST] on both emails

    const recipientHashes = await Promise.all(to.map((a) => sha256Hex(String(a).toLowerCase())));
    const requestedAt = new Date().toISOString();

    // the suppression list and the idempotency record live in D1: without them nobody knows whom a send may reach or whether
    // it already went, so the dispatch is refused, never sent on an unknown (zero silent failure, wo-0009)
    if (!env.DB) return out({ ok: false, error: "no_suppression_store", detail: "the comms engine needs its D1 binding (DB) to check suppression and idempotency" }, 503);
    if (idempotency_key) {
      try {
        const prior = await env.DB.prepare(
          `SELECT dispatch_id, send_status FROM comms_dispatch WHERE idempotency_key = ? AND template_id = ? AND send_status IN ('sent', 'sending', 'partial') LIMIT 1`
        ).bind(idempotency_key, template_id).first();
        if (prior?.send_status === "sent") return out({ ok: true, dispatch_id: prior.dispatch_id, idempotent_replay: true });
        // reserved and unfinished, or sent to only some recipients: never reported as sent, never sent again blindly
        if (prior) return out({ ok: false, error: prior.send_status === "partial" ? "dispatch_partial" : "dispatch_in_flight", dispatch_id: prior.dispatch_id }, 409);
      } catch (e) {
        console.error(`[${P}-comms] idempotency lookup failed; the dispatch is refused`, String(e));
        return out({ ok: false, error: "idempotency_check_failed" }, 503);
      }
    }

    const filteredTo = [];
    for (let i = 0; i < to.length; i++) {
      const supp = await isSuppressed(env.DB, recipientHashes[i], tpl.category, tpl.suppress_when || []);
      // a hold for an unknown (the lookup failed) is not a suppression: the dispatch is refused, so the caller knows
      if (supp.held) return out({ ok: false, error: "suppression_check_failed", reason: supp.reason }, 503);
      if (!supp.suppressed) filteredTo.push(to[i]);
    }
    if (!filteredTo.length) {
      emit("comms.suppressed", { template_id, channel: tpl.channel, category: tpl.category, suppressed: to.length }, env, ctx);
      return out({ ok: true, dispatch_id: null, suppressed: true, suppressed_count: to.length });
    }

    const provider = resolveProvider(tpl.channel, tpl.category);
    if (!provider) return out({ ok: false, error: "no_provider_for_channel_category" }, 500);

    const dispatchId = `${P}:comms:${tpl.channel}:${crypto.randomUUID()}`;
    const auditRef = dispatchId.replace(`${P}:comms:`, `${P}:audit:comms:`);
    const subjectHash = await sha256Hex(compiled.subject);
    const bodyHash = await sha256Hex(`${compiled.html}\n---\n${compiled.text}`);


    // recorded before it is sent: a send whose record cannot be written does not happen, and a retry finds the record
    try {
      await env.DB.prepare(
        `INSERT INTO comms_dispatch
         (dispatch_id, template_id, channel, category, to_hashes_json, rendered_subject_hash, rendered_body_hash, provider_id, provider_response_id, requested_at, dispatched_at, tenant_id, idempotency_key, audit_chain_ref, send_status, send_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(dispatchId, template_id, tpl.channel, tpl.category, JSON.stringify(recipientHashes), subjectHash, bodyHash,
        provider.id, null, requestedAt, null, tenant_id, idempotency_key || null, auditRef, "sending", null).run();
    } catch (e) {
      // the key is held by a live dispatch that raced this one (the unique index): in flight, not a failure to record
      if (/UNIQUE/i.test(String(e?.message || e))) return out({ ok: false, error: "dispatch_in_flight" }, 409);
      console.error(`[${P}-comms] dispatch row could not be written; nothing is sent`, String(e));
      return out({ ok: false, error: "dispatch_not_recorded" }, 503);
    }

    // audited as requested only once it is reserved: a refused dispatch leaves no record of a request that never happened
    await emitAuditChain(env, {
      event_family_id: `${P}.comms.requested.v1`, source_event_id: dispatchId, emitted_at: requestedAt,
      actor_id: ACTOR, tenant_id,
      payload_summary: `template=${template_id} channel=${tpl.channel} category=${tpl.category} recipients=${filteredTo.length}`,
      audit_chain_ref: auditRef,
    });

    const sendResult = await dispatchEmail({ env, compiled, to: filteredTo, url: MAIL_URL });
    const dispatchedAt = sendResult.ok ? new Date().toISOString() : null;
    const failedCount = sendResult.ok ? (sendResult.partial_failures || []).length : filteredTo.length;
    const sendStatus = !sendResult.ok ? "failed" : failedCount ? "partial" : "sent";
    const sendError = sendResult.ok ? null
      : `${sendResult.error || "send_failed"}: ${typeof sendResult.detail === "string" ? sendResult.detail : JSON.stringify(sendResult.detail ?? "")}`.slice(0, 1000);

    let recorded = true;
    try {
      await env.DB.prepare(
        `UPDATE comms_dispatch SET send_status = ?, dispatched_at = ?, provider_response_id = ?, send_error = ? WHERE dispatch_id = ?`
      ).bind(sendStatus, dispatchedAt, sendResult.provider_response_id || null, sendError, dispatchId).run();
    } catch (e) {
      // the mail went (or failed) and its record still says "sending": a retry is refused as a replay, never sent twice;
      // the caller is told the record is stale
      recorded = false;
      console.error(`[${P}-comms] dispatch row could not be updated to ${sendStatus}`, String(e));
    }

    if (sendStatus === "partial") {
      // some recipients got it, some did not: reported as not ok, with how many failed; the row says partial (no blind retry)
      emit("comms.failed", { dispatch_id: dispatchId, template_id, channel: tpl.channel, category: tpl.category, error: "partial_send", failed: failedCount }, env, ctx);
      console.error(`[${P}-comms] partial send dispatch=${dispatchId}: ${failedCount} of ${filteredTo.length} failed`);
      return out({ ok: false, error: "partial_send", dispatch_id: dispatchId, sent: filteredTo.length - failedCount, failed: failedCount, ...(recorded ? {} : { recorded: false }) }, 207);
    }
    if (!sendResult.ok) {
      emit("comms.failed", { dispatch_id: dispatchId, template_id, channel: tpl.channel, category: tpl.category, error: sendResult.error || "send_failed" }, env, ctx);
      console.error(`[${P}-comms] send failed dispatch=${dispatchId} template=${template_id}: ${sendError}`);
      return out({ ok: false, error: sendResult.error, detail: sendResult.detail, dispatch_id: dispatchId, ...(recorded ? {} : { recorded: false }) }, 502);
    }

    const emits = emitAuditChain(env, {
      event_family_id: `${P}.comms.dispatched.v1`, source_event_id: dispatchId, emitted_at: dispatchedAt,
      actor_id: ACTOR, tenant_id,
      payload_summary: `template=${template_id} provider=${provider.id} subject_hash=${subjectHash.slice(0, 12)} body_hash=${bodyHash.slice(0, 12)}`,
      audit_chain_ref: auditRef,
    });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(emits); else await emits;
    emit("comms.dispatched", { dispatch_id: dispatchId, template_id, channel: tpl.channel, category: tpl.category, provider: provider.id, sent: filteredTo.length, suppressed: to.length - filteredTo.length }, env, ctx);

    return out({ ok: true, dispatch_id: dispatchId, provider: provider.id, sent: filteredTo.length, suppressed: to.length - filteredTo.length, message_id: sendResult.provider_response_id || null, ...(recorded ? {} : { recorded: false }) });
  }

  // Submissions are attacker input: no regex reads them (the ReDoS gate, packages/uploads/test/regex-gate.test.mjs). Linear scans.
  const STOP = new Set([" ", "\t", "\n", "\r", "\f", "\v", "<", ">", ",", "\"", "'"]);
  /** One address: a single @, both sides non-empty, no space or delimiter, a dot in the domain with two or more characters after it. */
  const isAddress = (a) => {
    if (typeof a !== "string" || a.length < 6 || a.length > 254) return false;
    let at = -1;
    for (let i = 0; i < a.length; i++) {
      const c = a[i];
      if (STOP.has(c) || c.charCodeAt(0) < 32) return false;
      if (c === "@") { if (at !== -1) return false; at = i; }
    }
    const dot = a.lastIndexOf(".");
    return at > 0 && dot > at + 1 && a.length - dot - 1 >= 2;
  };
  /** Every token with an @ in it (an address, or what could be one) becomes <address>. */
  const redact = (text) => {
    let out = "", tok = "";
    const flush = () => { out += tok.includes("@") ? "<address>" : tok; tok = ""; };
    for (const c of text) { if (STOP.has(c)) { flush(); out += c; } else tok += c; }
    flush();
    return out;
  };
  const isFormId = (v) => {
    if (typeof v !== "string" || v.length < 1 || v.length > 64) return false;
    for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c === 45 && i > 0); if (!ok) return false; }
    return true;
  };
  /** An error for the ledger: code and detail, never an address, at most 300 characters. */
  const errorOf = (payload) => redact(`${payload.error || "send_failed"}${payload.detail ? `: ${typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail)}` : ""}`.slice(0, 2000)).slice(0, 300);
  /** A BCP 47 shape (the schema's pattern), read by a linear scan, never a regex over submitted text: 2-3 letters, then subtags of 1-8 letters or digits. */
  const isLocaleTag = (v) => {
    if (typeof v !== "string" || v.length > 35) return false;
    const [lang, ...rest] = v.split("-");
    const alpha = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
    return lang.length >= 2 && lang.length <= 3 && [...lang].every(alpha) && rest.every((t) => t.length >= 1 && t.length <= 8 && [...t].every((c) => alpha(c) || (c >= "0" && c <= "9")));
  };
  const SUBMISSION_KEYS = ["form_id", "reference", "form_label", "submitter", "params", "test", "locale", "notices"];
  const submissionProblem = (b) => {
    if (!b || typeof b !== "object" || Array.isArray(b)) return "body";
    for (const k of Object.keys(b)) if (!SUBMISSION_KEYS.includes(k)) return k;
    if (!isFormId(b.form_id)) return "form_id";
    if (typeof b.reference !== "string" || !REFERENCE_RE.test(b.reference)) return "reference";
    if (!b.submitter || typeof b.submitter !== "object" || !isAddress(b.submitter.email)) return "submitter.email";
    if (!b.params || typeof b.params !== "object" || Array.isArray(b.params)) return "params";
    if (b.test !== undefined && typeof b.test !== "boolean") return "test";
    if (b.locale !== undefined && (!isLocaleTag(b.locale))) return "locale";
    if (b.form_label !== undefined && (typeof b.form_label !== "string" || !b.form_label || b.form_label.length > 200)) return "form_label";
    return null;
  };

  /**
   * A form submission, delivered twice (docs/FORMS.md): recorded first (a submission whose record cannot be written sends nothing),
   * then the receipt (to the submitter; to the owner for a test) and the owner's notification (to the engine secret's recipients),
   * each through dispatchCore with its own comms_dispatch row and idempotency key, then both outcomes written back. An owner delivery
   * that is not sent (no recipients, refused, partial, suppressed) is a failure: recorded, logged, raised as comms.form.owner_failed.
   * Re-submitting a reference re-drives only the deliveries that did not go.
   */
  /** The autoreply in the submission's language; the primary one only when that language is not declared. */
  const ackFor = (form, locale) => form.ack_templates?.[String(locale || "").split("-")[0].toLowerCase()] || form.ack_template_id;

  async function submitCore(body, env, ctx) {
    const out = (payload, status = 200) => ({ status, payload });
    const bad = submissionProblem(body);
    if (bad) return out({ ok: false, error: "invalid_submission", field: bad }, 400);
    const form = FORMS.get(body.form_id);
    if (!form) return out({ ok: false, error: "undeclared_form", form_id: body.form_id, detail: "the form is not declared in the comms config (forms.declared / templates)" }, 404);
    if (!env.DB) return out({ ok: false, error: "no_ledger", detail: "the comms engine needs its D1 binding (DB) to record the submission" }, 503);
    const { reference } = body;
    const now = new Date().toISOString();
    let row;
    try {
      await env.DB.prepare("INSERT INTO comms_form_deliveries (reference, form_id, site, test, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(reference) DO NOTHING")
        .bind(reference, form.form_id, rt.site, body.test === true ? 1 : 0, now).run();
      row = await env.DB.prepare("SELECT * FROM comms_form_deliveries WHERE reference = ?").bind(reference).first();
    } catch (e) {
      console.error(`[${P}-comms] submission ${reference} could not be recorded; nothing is sent`, String(e?.message || e));
      return out({ ok: false, error: "ledger_not_recorded" }, 503);
    }
    if (!row) { console.error(`[${P}-comms] submission ${reference}: the ledger row did not come back; nothing is sent`); return out({ ok: false, error: "ledger_not_recorded" }, 503); }
    if (row.form_id !== form.form_id) return out({ ok: false, error: "reference_conflict", detail: "the reference is recorded for another form" }, 409);

    const owners = String((OWNER_SECRET && env[OWNER_SECRET]) || "").split(",").map((a) => a.trim()).filter(Boolean);
    // exactly the project's own info@: the secret is checked against the config at deploy, and again here, so a stale or foreign value
    // never receives a submission (and is recorded as a failure, never sent somewhere else quietly)
    const ownersOk = owners.length === 1 && isAddress(owners[0]) && owners[0].toLowerCase() === OWNER_ADDRESS;
    const missing = !owners.length
      ? `owner_recipients_missing: the comms engine has no ${OWNER_SECRET || "owner secret"} (forms.owner.secret)`
      : `owner_not_project_info: ${OWNER_SECRET || "owner secret"} must be exactly the project's own info@ (forms.owner.address)`;
    const isTest = Boolean(row.test);
    const subjectPrefix = isTest ? "[TEST] " : "";
    const site = rt.site;
    const ledger_url = ledgerUrl(site, reference);
    const next = { ...row };

    if (!["sent", "suppressed"].includes(row.receipt_status)) {
      // a test's receipt goes to the owner, never to the address in the form: a drill proves the path without writing to anyone else
      const to = isTest ? (ownersOk ? owners : null) : [body.submitter.email];
      if (!to) Object.assign(next, { receipt_status: "failed", receipt_error: missing });
      else {
        // its own try/catch: a throw in the receipt path (a compiler or D1 error) is this delivery's failure, never a skipped owner copy
        try {
          const r = await dispatchCore({ template_id: ackFor(form, body.locale), to, params: { ...body.params, reference }, idempotency_key: reference, ...(body.notices ? { notices: body.notices } : {}) }, env, ctx, { submit: true, subjectPrefix });
          if (r.payload.error === "dispatch_in_flight") { /* a concurrent submit of this reference is sending it: left pending, never marked failed */ }
          else Object.assign(next, r.payload.ok
            ? { receipt_status: r.payload.suppressed ? "suppressed" : "sent", receipt_dispatch_id: r.payload.dispatch_id || null, receipt_error: null }
            : { receipt_status: "failed", receipt_dispatch_id: r.payload.dispatch_id || row.receipt_dispatch_id || null, receipt_error: errorOf(r.payload) });
        } catch (e) { Object.assign(next, { receipt_status: "failed", receipt_error: errorOf({ error: "receipt_threw", detail: String(e?.message || e) }) }); }
      }
    }
    if (row.owner_status !== "sent") {
      if (!ownersOk) Object.assign(next, { owner_status: "failed", owner_error: missing });
      else {
        const params = { ...body.params, reference, form_id: form.form_id, form_label: body.form_label || form.form_id, site, ledger_url, test_marker: subjectPrefix };
        try {
          const r = await dispatchCore({ template_id: form.owner_template_id, to: owners, params, idempotency_key: `${reference}:owner` }, env, ctx, { submit: true });
          if (r.payload.error === "dispatch_in_flight") { /* a concurrent submit is sending it: pending (the monitor fails a stale pending) */ }
          else Object.assign(next, r.payload.ok && !r.payload.suppressed
            ? { owner_status: "sent", owner_dispatch_id: r.payload.dispatch_id || null, owner_error: null }
            : { owner_status: "failed", owner_dispatch_id: r.payload.dispatch_id || row.owner_dispatch_id || null,
                owner_error: r.payload.suppressed ? "owner_suppressed: the owner's address is on the suppression list (a bounce or a complaint): fix the inbox or the secret" : errorOf(r.payload) });
        } catch (e) { Object.assign(next, { owner_status: "failed", owner_error: errorOf({ error: "owner_threw", detail: String(e?.message || e) }) }); }
      }
    }
    next.updated_at = new Date().toISOString();
    let recorded = true;
    try {
      // monotonic: a delivery a concurrent submit already recorded as gone is never written back to pending or failed
      const R = "receipt_status IN ('sent', 'suppressed')", O = "owner_status = 'sent'";
      await env.DB.prepare(`UPDATE comms_form_deliveries SET
          receipt_dispatch_id = CASE WHEN ${R} THEN receipt_dispatch_id ELSE ? END, receipt_error = CASE WHEN ${R} THEN receipt_error ELSE ? END,
          receipt_status = CASE WHEN ${R} THEN receipt_status ELSE ? END,
          owner_dispatch_id = CASE WHEN ${O} THEN owner_dispatch_id ELSE ? END, owner_error = CASE WHEN ${O} THEN owner_error ELSE ? END,
          owner_status = CASE WHEN ${O} THEN owner_status ELSE ? END, updated_at = ? WHERE reference = ?`)
        .bind(next.receipt_dispatch_id ?? null, next.receipt_error ?? null, next.receipt_status, next.owner_dispatch_id ?? null, next.owner_error ?? null, next.owner_status, next.updated_at, reference).run();
      const now2 = await env.DB.prepare("SELECT * FROM comms_form_deliveries WHERE reference = ?").bind(reference).first();
      if (now2) Object.assign(next, now2);
    } catch (e) {
      // the row stays pending: the monitor counts a pending owner delivery past its window as a failure, so this is not silent either
      recorded = false;
      console.error(`[${P}-comms] submission ${reference}: the delivery outcome could not be recorded`, String(e?.message || e));
    }
    const delivery = recordOf(next, site);
    const ownerOk = next.owner_status === "sent";
    if (!ownerOk) {
      console.error(`[${P}-comms] owner notification failed reference=${reference} form=${form.form_id}: ${next.owner_error}`);
      emit("comms.form.owner_failed", delivery, env, ctx);
    } else emit("comms.form.delivered", delivery, env, ctx);
    return out({ ok: ownerOk && ["sent", "suppressed"].includes(next.receipt_status), delivery, ...(recorded ? {} : { outcome_recorded: false }) });
  }

  async function handleSuppress(request, env) {
    const read = await readJsonBody(request, BODY);
    if (read.response) return read.response;
    if (read.invalid || !read.value || typeof read.value !== "object") return json({ ok: false, error: "json_parse_failed" }, 400);
    const body = read.value;
    const { recipient, recipient_hash, reason, scope = "global", actor_id = `${P}:admin:platform:ops` } = body;
    if (!reason || (!recipient && !recipient_hash)) return json({ ok: false, error: "missing_required" }, 400);
    if (!SUPPRESSION_REASONS.includes(reason)) return json({ ok: false, error: "unknown_reason", reasons: SUPPRESSION_REASONS }, 400);   // a reason no rule reads would never suppress
    const recipientHash = recipient_hash ? String(recipient_hash).toLowerCase() : await sha256Hex(String(recipient).toLowerCase());
    if (!/^[0-9a-f]{64}$/.test(recipientHash)) return json({ ok: false, error: "invalid_recipient_hash" }, 400);
    try { await addSuppression(env.DB, { recipientHash, reason, scope, actor_id }); }
    catch (e) { return json({ ok: false, error: "suppression_not_recorded", detail: String(e?.message || e) }, 503); }   // the caller must retry: nothing was recorded
    await emitAuditChain(env, {
      event_family_id: `${P}.comms.suppression_added.v1`, source_event_id: recipientHash, emitted_at: new Date().toISOString(),
      actor_id, tenant_id: TENANT, payload_summary: `reason=${reason} scope=${scope}`,
      audit_chain_ref: `${P}:audit:comms:suppress:${recipientHash.slice(0, 12)}`,
    });
    return json({ ok: true, recipient_hash: recipientHash });
  }

  async function fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, component: rt.engineName, templates: TEMPLATES.size });
    if (request.method === "POST" && url.pathname === "/v1/comms/dispatch") {
      const read = await readJsonBody(request, BODY);
      if (read.response) return read.response;
      if (read.invalid || !read.value || typeof read.value !== "object") return json({ ok: false, error: "json_parse_failed" }, 400);
      const body = read.value;
      const { status, payload } = await dispatchCore(body, env, ctx);
      return json(payload, status);
    }
    if (request.method === "POST" && url.pathname === "/v1/comms/submit") {
      const read = await readJsonBody(request, BODY);
      if (read.response) return read.response;
      if (read.invalid || !read.value || typeof read.value !== "object") return json({ ok: false, error: "json_parse_failed" }, 400);
      const { status, payload } = await submitCore(read.value, env, ctx);
      return json(payload, status);
    }
    if (request.method === "POST" && url.pathname === "/v1/comms/suppress") return handleSuppress(request, env);
    if (request.method === "GET" && url.pathname === "/v1/comms/manifest") {
      return json({ schema: manifest.schema, version: manifest.version,
        templates: manifest.templates.map((t) => ({ template_id: t.template_id, channel: t.channel, category: t.category, locale: t.locale, required_params: t.required_params || [] })) });
    }
    return json({ ok: false, error: "not_found", path: url.pathname }, 404);
  }

  // dispatchCore is handed out without its internal `via`: from outside, a form's templates are refused (409) like over the binding
  return { fetch, dispatchCore: (body, env, ctx) => dispatchCore(body, env, ctx), submitCore };
}
