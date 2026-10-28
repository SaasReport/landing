/**
 * Part of the comms engine (constitution §38).
 * Provider dispatcher — the ONE place that talks to the delivery primitive.
 * The comms architecture is Cloudflare-native: <project>-mail-sender (CF
 * Email Sending binding) is the delivery layer; the Comms Engine is the
 * governance + compilation + audit layer that sits in front of it.
 *
 * Constitution §38 §7 — allowlisted by the comms-manifest-alive gate as
 * the only call-site permitted to invoke env.MAIL_SENDER.
 */

export async function dispatchEmail({ env, compiled, to, url = "https://mail-sender/send" }) {
  if (!env.MAIL_SENDER || typeof env.MAIL_SENDER.fetch !== "function") {
    return { ok: false, error: "mail_sender_binding_missing" };
  }
  const fromHeader = compiled.from_display
    ? `${compiled.from_display} <${compiled.from_address}>`
    : compiled.from_address;
  const errors = [];
  const responseIds = [];
  let accepted = 0;   // recipients the mail sender accepted (2xx), whatever its reply body says
  for (const [index, recipient] of to.entries()) {
    const payload = {
      from: compiled.from_address,
      fromName: compiled.from_display,
      to: recipient,
      subject: compiled.subject,
      text: compiled.text,
      html: compiled.html,
      replyTo: compiled.reply_to_address || undefined,
    };
    let resp;
    try {
      resp = await env.MAIL_SENDER.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) {
      errors.push({ recipient_index: index, error: String((e && e.message) || e) });   // by position: an address never leaves the engine
      continue;
    }
    if (!resp.ok) {
      // Capture the mail-sender response body — it carries the real
      // transport error (e.g. the CF Email Service rejection reason).
      const detail = await resp.text().catch(() => "");   // the status is the error; the body is only detail
      errors.push({ recipient_index: index, status: resp.status, detail: detail.slice(0, 400) });
      continue;
    }
    accepted++;
    try {
      const j = await resp.json();
      if (j && j.message_id) responseIds.push(j.message_id);
    } catch (e) { console.error("comms dispatcher: best-effort step failed", e); }
  }
  if (errors.length && !accepted) {
    return { ok: false, error: "all_recipients_failed", detail: errors };
  }
  return { ok: true, provider_response_id: responseIds[0] || null, partial_failures: errors.length ? errors : undefined };
}
