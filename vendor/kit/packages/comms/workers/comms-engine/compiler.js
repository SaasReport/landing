/**
 * Part of the comms engine (constitution §38).
 * Deterministic template compiler — interpolates ${name} into block values
 * by canonical lookup. No falsy fallbacks, no silent defaults: a missing
 * param surfaces as an error so we cannot send a half-rendered email.
 */

// >>> canonical escaper — generated from private/lib/html-escape/index.js; do not edit
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
// <<< canonical escaper

// A param whose NAME ends with `_html` is a pre-built, already-sanitised HTML
// fragment (canonical convention: fields_html, actions_html). The calling
// handler assembles it server-side and escapes every user-supplied value inside
// it before composing the fragment. EVERY OTHER param is untrusted plain text
// (name, organisation, label, application_id, …) and MUST be HTML-escaped before
// it is interpolated into an HTML body — otherwise a form field like
// `company = <a href="https://evil.com">Click here</a>` or
// `heard_from = "><img src=x onerror=eval(atob(...))>` becomes link-injection /
// stored XSS in the admin notification email. The renderer is the LAST line of
// defence and never trusts its inputs (defence-in-depth: handlers escape too).
const isRawHtmlParam = (k) => /_html$/.test(k);

function interpolate(text, params, { escapeForHtml = false } = {}) {
  return String(text).replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
    if (params[k] === undefined) throw new Error(`missing_param:${k}`);
    const v = String(params[k]);
    return escapeForHtml && !isRawHtmlParam(k) ? escapeHtml(v) : v;
  });
}

/**
 * The shell every compiled email is wrapped in: direction and language from the template's locale, the
 * project's self-hosted fonts, background and link colour. Part of the compiler, so no template can opt out.
 * `shell`: { dir, lang, fontStack, fontFaces: [{ family, weight, style, src, format }], background, link, cssPrefix }.
 */
function wrapShell(subject, inner, preheaderBlock, params, shell) {
  const { dir, lang, fontStack, fontFaces = [], background, link, cssPrefix } = shell;
  const start = dir === "rtl" ? "right" : "left";
  const preheader = preheaderBlock ? escapeHtml(interpolate(preheaderBlock.value.text, params)) : "";
  const faces = fontFaces.map((f) =>
    `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style || "normal"};src:url('${f.src}') format('${f.format || "truetype"}')}\n`).join("");
  return `<!doctype html>
<html dir="${dir}" lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
<style>
${faces}body,table,td,p,a,h1,h2,h3,li{font-family:${fontStack} !important}
a{color:${link}}
@media (max-width:620px){.${cssPrefix}-card{padding:24px 18px !important}.${cssPrefix}-h1{font-size:22px !important}.${cssPrefix}-head{padding:24px 18px 0 !important}.${cssPrefix}-foot{padding-left:18px !important;padding-right:18px !important}.${cssPrefix}-domain{display:none !important}}
</style>
</head>
<body dir="${dir}" style="margin:0;padding:0;background:${background};direction:${dir};text-align:${start}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="background:${background};direction:${dir}">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="width:100%;max-width:600px;direction:${dir};text-align:${start}">
${inner}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The body blocks with the recipient's legal notices: the base notice is in body_blocks already; the picked
 * audience and jurisdiction blocks (`notices`, or the template's notice_default) go right after it, in the
 * template's display order. An audience or jurisdiction the template does not offer is an error, never ignored.
 */
function bodyBlocksWithNotices(template, notices) {
  const nb = template.notice_blocks;
  if (!nb) {
    if (notices && ((notices.audiences || []).length || (notices.jurisdictions || []).length)) throw new Error("unknown_notice:no notices configured");
    return template.body_blocks;
  }
  const sel = notices || template.notice_default || {};
  const want = { audiences: new Set(sel.audiences || []), jurisdictions: new Set((sel.jurisdictions || []).map((j) => String(j).toUpperCase())) };
  const extra = [];
  for (const kind of ["audiences", "jurisdictions"]) {
    for (const k of want[kind]) if (!nb[kind]?.[k]) throw new Error(`unknown_notice:${kind}.${k}`);
    for (const [k, id] of Object.entries(nb[kind] || {})) if (want[kind].has(k)) extra.push(id);
  }
  const at = template.body_blocks.indexOf(nb.base);
  if (at < 0) return [...template.body_blocks, ...extra];
  return [...template.body_blocks.slice(0, at + 1), ...extra, ...template.body_blocks.slice(at + 1)];
}

export function compileTemplate({ template, blocks, links, params, shell, notices }) {
  try {
    const subjectBlock = blocks.get(template.subject.block_ref);
    if (!subjectBlock) return { ok: false, error: "missing_block", detail: template.subject.block_ref, status: 500 };
    const subject = interpolate(subjectBlock.value.text, params);

    const fromBlock = blocks.get(template.from_block);
    if (!fromBlock) return { ok: false, error: "missing_block", detail: template.from_block, status: 500 };
    const replyToBlock = template.reply_to_block ? blocks.get(template.reply_to_block) : null;
    if (template.reply_to_block && !replyToBlock) {
      return { ok: false, error: "missing_block", detail: template.reply_to_block, status: 500 };
    }

    for (const lr of template.link_refs || []) {
      if (!links.get(lr)) return { ok: false, error: "missing_link", detail: lr, status: 500 };
    }

    const htmlParts = [];
    const textParts = [];
    for (const bRef of bodyBlocksWithNotices(template, notices)) {
      const b = blocks.get(bRef);
      if (!b) return { ok: false, error: "missing_block", detail: bRef, status: 500 };
      const html = b.value.html || "";
      const text = b.value.text || "";
      // HTML body: escape untrusted plain-text params (raw `*_html` fragments
      // pass through). Plain-text body: no escaping — it is not an HTML context
      // and escaping would corrupt it (&amp; etc.).
      htmlParts.push(interpolate(html, params, { escapeForHtml: true }));
      textParts.push(interpolate(text, params));
    }

    // Every outbound email gets the project's shell for the template's locale
    // (direction, language, self-hosted fonts). No template can opt out.
    if (!shell) return { ok: false, error: "missing_shell", detail: template.locale, status: 500 };
    const html = wrapShell(subject, htmlParts.join("\n"), template.preheader_block ? blocks.get(template.preheader_block) : null, params, shell);
    const text = textParts.join("\n");

    return {
      ok: true,
      subject,
      html,
      text,
      from_address: fromBlock.value.address,
      from_display: fromBlock.value.display_name,
      reply_to_address: replyToBlock ? replyToBlock.value.address : null,
    };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (msg.startsWith("missing_param:")) {
      return { ok: false, error: "missing_param", detail: msg.split(":")[1], status: 400 };
    }
    if (msg.startsWith("unknown_notice:")) {
      return { ok: false, error: "unknown_notice", detail: msg.slice("unknown_notice:".length), status: 400 };
    }
    return { ok: false, error: "compile_failed", detail: msg, status: 500 };
  }
}
