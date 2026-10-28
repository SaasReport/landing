/**
 * The spec generator: a comms config in, the comms-engine spec files out (manifest, blocks, links,
 * providers; kit.comms.* schemas). Pure: no I/O, the same output on every run.
 */
import { resolveConfig } from "./config.js";
import { styler } from "./html.js";
import { noticeBlocks, noticeSelection } from "./notices.js";

const CE = (r) => r.manifest.constitutionRef;

function block(r, block_id, kind, value) {
  return { block_id, entity_class: "comms-block", kind, channels: ["email"], value, constitution_ref: CE(r) };
}

/** Block and template id helpers: the primary locale has no suffix; other locales end in .<lang>. */
export function ids(config, lang) {
  const r = config.locales?.[0]?.pack ? config : resolveConfig(config);
  const primary = !lang || lang === r.primary.lang;
  const sfx = primary ? "" : `.${lang}`;
  const local = r.sender.address.split("@")[0];
  return {
    from: `from.${local}${sfx}`,
    replyTo: `reply_to.${local}${sfx}`,
    header: `header.${r.idPrefix}-mark${sfx}`,
    signature: `footer.signature.${r.idPrefix}${sfx}`,
    legal: `footer.legal.${r.idPrefix}${sfx}`,
    unsubscribe: `footer.unsubscribe.${r.idPrefix}${sfx}`,
    notice: (b) => `footer.notice.${r.idPrefix}.${b.kind === "base" ? "base" : `${b.kind}.${b.key.toLowerCase()}`}${sfx}`,
    subject: (k) => `subject.${k}${sfx}`,
    preheader: (k) => `preheader.${k}${sfx}`,
    body: (k) => `body.${k}${sfx}`,
    ack: (k) => `${r.idPrefix}.${k}.ack${sfx}.v1`,
    ops: (k) => `${r.idPrefix}.ops.${k}${sfx}.v1`,
  };
}

/** The acknowledgement template id for a form key and locale ("fa", "en-US", …). */
export function templateId(config, key, locale) {
  return ids(config, locale && locale.split("-")[0]).ack(key);
}

/** The style context of one resolved locale. */
export function styleFor(r, loc) {
  return styler({
    dir: loc.dir, font: loc.fonts.stack, colors: r.colors, lineHeight: loc.pack.lineHeight,
    cssPrefix: r.cssPrefix, digits: loc.pack.digits,
  });
}

function legalVars(r, loc) {
  const brand = r.brand.name[loc.lang];
  const e = r.legalEntity;
  // An entity value that is empty or still a TODO is not set: the footer leaves its line out and the brand stays the
  // copyright holder (todos(config) still lists it for the owner).
  const pick = (v) => { const x = (v && typeof v === "object" ? v[loc.lang] ?? v.default : v) || null; return x && !/^TODO\b/.test(String(x).trim()) ? x : null; };
  return {
    brand, holder: pick(e.name) || brand, address: pick(e.address), registration: pick(e.registration),
    sender: r.sender.address, replyTo: r.sender.replyTo || null, site: r.site, domain: r.domain,
    contact: r.links.contact, privacy: r.links.privacy || null, unsubscribe: r.links.unsubscribe || null,
    link: r.colors.accentText || r.colors.accent, hijri: r.legal?.hijri,   // links are text: the AA-safe role, never the raw accent
  };
}

const escText = (v) => String(v).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);

/** The project's legal-notice blocks in one locale (base, audiences, jurisdictions), or [] without legal.notices. */
export function localeNotices(r, loc, opts = {}) {
  return noticeBlocks(r.legal?.notices, loc.lang, { brand: r.brand.name, site: r.site, entity: r.legalEntity, ...opts });
}

function chromeBlocks(r, loc, opts = {}) {
  const id = ids(r, loc.lang);
  const s = styleFor(r, loc);
  const x = legalVars(r, loc);
  const p = loc.pack;
  const name = r.brand.name[loc.lang];
  const sig = r.signature?.[loc.lang] || {};
  const team = sig.team || p.team(name);
  const closing = sig.closing || p.closing;
  const tagline = sig.tagline || null;
  const paras = (r.legal?.paragraphs?.[loc.lang] || p.legal)(x);
  const logo = r.brand.logo ? { ...r.brand.logo, alt: r.brand.logo.alt?.[loc.lang] || name } : null;
  const out = [
    block(r, id.from, "from", { address: r.sender.address, display_name: r.sender.name?.[loc.lang] || name }),
  ];
  if (r.sender.replyTo) out.push(block(r, id.replyTo, "reply_to", { address: r.sender.replyTo }));
  out.push(
    block(r, id.header, "header", { html: s.header({ logo, name, domain: r.domain }), text: `${name}\n================\n` }),
    block(r, id.signature, "signature", {
      html: s.signature({ closing, team, tagline, site: r.site, domain: r.domain }),
      text: `\n${closing}\n${team}\n${tagline ? `${tagline}\n` : ""}${r.site}\n`,
    }),
    block(r, id.legal, "legal", {
      html: s.legal(paras.map((q) => q.html)),
      text: "\n—\n" + paras.filter((q) => q.text != null).map((q) => `${q.text}\n`).join(""),
    }),
  );
  for (const b of localeNotices(r, loc, opts)) {
    out.push(block(r, id.notice(b), "legal", {
      html: s.noticeBlock({ title: escText(b.title), paragraphs: b.paragraphs.map(escText), first: b.kind === "base" }),
      text: `\n—\n${b.title}\n${b.paragraphs.join("\n")}\n`,
    }));
  }
  if (r.links.unsubscribe && r.templates.some((t) => t.unsubscribe)) {
    const u = p.unsubscribe(x);
    out.push(block(r, id.unsubscribe, "legal", { html: s.notice(u.html), text: `${u.text}\n` }));
  }
  return out;
}

function templateEntry(r, loc, fields) {
  const m = r.manifest;
  return {
    template_id: fields.template_id, entity_class: "comms-template", channel: "email",
    category: fields.category, persona: fields.persona, locale: loc.tag, direction: loc.dir,
    subject: { block_ref: fields.subject },
    ...(fields.preheader ? { preheader_block: fields.preheader } : {}),
    body_blocks: fields.body_blocks,
    from_block: ids(r, loc.lang).from,
    reply_to_block: r.sender.replyTo ? ids(r, loc.lang).replyTo : null,
    link_refs: fields.link_refs || [],
    required_params: fields.required_params,
    audit_event_family: `${r.idPrefix}.comms.dispatched.v1`, retry_policy: m.retryPolicy, ttl_seconds: m.ttlSeconds,
    suppress_when: fields.suppress_when, framework_refs: fields.framework_refs,
    constitution_ref: m.constitutionRef,
    ...(fields.notice_blocks ? { notice_blocks: fields.notice_blocks, notice_default: fields.notice_default } : {}),
  };
}

/**
 * The notice fields of a template: the optional blocks a recipient can pick (notice_blocks, in display order) and
 * the template's default pick (notice_default). The compiler inserts the picked blocks after the base notice.
 */
function noticeFields(r, id, nb, own) {
  const of = (kind) => Object.fromEntries(nb.filter((b) => b.kind === kind).map((b) => [b.key, id.notice(b)]));
  const sel = noticeSelection(r.legal.notices, own);
  const offered = { audiences: of("audience"), jurisdictions: of("jurisdiction") };
  return {
    notice_blocks: { base: id.notice(nb.find((b) => b.kind === "base")), ...offered },
    // Only blocks that are published: a draft jurisdiction in the default is dropped until it is signed off.
    notice_default: { audiences: sel.audiences.filter((a) => offered.audiences[a]), jurisdictions: sel.jurisdictions.filter((j) => offered.jurisdictions[j]) },
  };
}

function linkRefs(r, t) {
  const refs = [];
  if (r.links.privacy) refs.push("link.privacy");
  if (t?.unsubscribe && r.links.unsubscribe) refs.push("link.unsubscribe");
  return refs;
}

/** The locale of the owner's notification: its ops entry's locale, else the primary one (the same rule as the ops templates). */
function ownerLoc(r) {
  const o = r.ops.find((x) => x.key === r.forms.owner.template);
  return r.locales.find((l) => l.lang === (o?.locale && o.locale.split("-")[0])) || r.primary;
}

/** Build the four spec files from a comms config: { "manifest.json", "blocks.json", "links.json", "providers.json" }. */
export function buildSpecs(config, opts = {}) {
  const r = resolveConfig(config);
  const m = r.manifest;
  const blocks = [];
  const templates = [];
  const notices = {};   // per locale: the notice blocks (published ones; drafts and placeholders per opts)
  for (const loc of r.locales) {
    notices[loc.lang] = localeNotices(r, loc, opts);
    blocks.push(...chromeBlocks(r, loc, opts));
  }

  for (const loc of r.locales) {
    const id = ids(r, loc.lang);
    const s = styleFor(r, loc);
    const p = loc.pack;
    const FIELDS = s.h2(p.summary) + "${fields_html}";
    const n = (i) => s.num(i);
    for (const t of r.templates) {
      const cp = t.copy[loc.lang];
      blocks.push(block(r, id.subject(t.key), "subject", { text: cp.subject }));
      blocks.push(block(r, id.preheader(t.key), "preheader", { text: cp.preheader }));
      const extraHtml = cp.extra ? s.h2(cp.extra.heading) + cp.extra.html : "";
      const extraText = cp.extra ? `\n${cp.extra.heading}:\n${cp.extra.text}\n` : "";
      let html = s.cardOpen() + s.h1(cp.title) + s.para(p.greeting.html, 16) + s.refPill(p.reference, p.submitted)
        + cp.intro.map((q) => s.para(q)).join("") + extraHtml + s.h2(p.nextSteps) + s.steps(cp.steps) + FIELDS;
      if (cp.cta) html += s.cta(cp.cta.label, cp.cta.href);
      html += s.CARD_CLOSE;
      const text = `${cp.title}\n\n${p.greeting.text}\n${p.reference}: \${reference} — \${submitted_at}\n\n`
        + cp.intro.join("\n\n") + "\n" + extraText
        + `\n${p.nextSteps}:\n` + cp.steps.map((q, i) => `${n(i + 1)}. ${q}`).join("\n")
        + `\n\n${p.summary}:\n\${fields_text}\n`
        + (cp.cta ? `\n${cp.cta.label}: ${cp.cta.href}\n` : "");
      blocks.push(block(r, id.body(t.key), "body", { html, text }));
      const nb = notices[loc.lang];
      const base = nb.find((b) => b.kind === "base");
      templates.push(templateEntry(r, loc, {
        template_id: id.ack(t.key), category: t.category || "transactional", persona: t.persona || "prospect",
        subject: id.subject(t.key), preheader: id.preheader(t.key),
        body_blocks: [id.header, id.body(t.key), id.signature, ...(base ? [id.notice(base)] : []), id.legal, ...(t.unsubscribe ? [id.unsubscribe] : [])],
        link_refs: linkRefs(r, t),
        required_params: ["name", "reference", "submitted_at", "fields_html", "fields_text", ...(t.params || [])],
        suppress_when: t.suppressWhen || m.suppress.ack, framework_refs: t.frameworkRefs || m.frameworkRefs.ack,
        ...(base ? noticeFields(r, id, nb, t.notices) : {}),
      }));
    }
  }

  // Ops notifications: to the project's operators, in the ops locale (the primary one unless set).
  for (const o of r.ops) {
    const loc = r.locales.find((l) => l.lang === (o.locale && o.locale.split("-")[0])) || r.primary;
    const id = ids(r, loc.lang);
    const s = styleFor(r, loc);
    const p = loc.pack;
    const cp = { ...p.ops, ...(o.copy?.[loc.lang] || {}) };
    const bk = o.blockKey || `ops-${o.key}`;
    // the owner's notification of a form submission (forms.owner.template): the engine's submit fills form_id, site, ledger_url and
    // test_marker; the body shows them as data (the form id and the site, then the ledger row as a link), no new copy
    const owner = r.forms?.owner.template === o.key;
    const meta = owner ? s.para("${form_id} — ${site}", 13, r.colors.muted, "direction:ltr;unicode-bidi:isolate") : "";
    const ledger = owner ? s.cta("${ledger_url}", "${ledger_url}") : "";
    blocks.push(block(r, id.subject(bk), "subject", { text: owner ? `\${test_marker}${cp.subject}` : cp.subject }));
    blocks.push(block(r, id.body(bk), "body", {
      html: s.cardOpen() + s.h1(cp.title) + s.refPill(p.reference, p.submitted) + meta + s.h2(p.summary) + "${fields_html}" + ledger + s.CARD_CLOSE,
      text: `${cp.title}\n${p.reference}: \${reference} — \${submitted_at}\n${owner ? "\${form_id} — \${site}\n" : ""}\n\${fields_text}\n${owner ? "\n\${ledger_url}\n" : ""}`,
    }));
    templates.push(templateEntry(r, loc, {
      template_id: id.ops(o.key), category: "operational", persona: "operator",
      subject: id.subject(bk), body_blocks: [id.header, id.body(bk), id.legal],
      link_refs: linkRefs(r, null),
      required_params: ["form_label", "reference", "submitted_at", "fields_html", "fields_text", ...(owner ? ["form_id", "site", "ledger_url", "test_marker"] : []), ...(o.params || [])],
      suppress_when: o.suppressWhen || m.suppress.ops, framework_refs: o.frameworkRefs || m.frameworkRefs.ops,
    }));
  }

  const links = [];
  for (const k of ["privacy", "unsubscribe"]) {
    if (r.links[k]) links.push({ link_id: `link.${k}`, entity_class: "comms-link", url: r.links[k], constitution_ref: CE(r) });
  }
  const mailSender = `${r.project}-mail-sender`;
  return {
    "manifest.json": {
      schema: m.schema, registry_id: `${r.idPrefix}:registry:comms-templates`, version: m.version, adopted: m.adopted,
      constitution_ref: m.constitutionRef, templates,
      // the declared forms (kit.forms-config.v1): the engine delivers each through POST /v1/comms/submit only, twice, and refuses its
      // templates on the plain dispatch endpoint, so no handler can send the receipt alone
      ...(r.forms ? {
        forms: r.forms.declared.map((key) => ({ form_id: key, ack_template_id: ids(r, r.primary.lang).ack(key), ack_templates: Object.fromEntries(r.locales.map((l) => [l.lang, ids(r, l.lang).ack(key)])), owner_template_id: ids(r, ownerLoc(r).lang).ops(r.forms.owner.template) })),
        owner: { template_id: ids(r, ownerLoc(r).lang).ops(r.forms.owner.template), secret: r.forms.owner.secret, address: r.forms.owner.address },
      } : {}),
    },
    "blocks.json": { schema: "kit.comms.blocks.v1", version: m.version, blocks },
    "links.json": { schema: "kit.comms.links.v1", version: m.version, links },
    "providers.json": {
      schema: "kit.comms.providers.v1", registry_id: `${r.idPrefix}:registry:comms-providers`, version: m.version,
      notes: [`Cloudflare-native: the Comms Engine compiles, governs and audits; ${mailSender} (CF Email Sending binding) delivers.`],
      providers: [{ id: "cf-email.primary", kind: "email", binding: "MAIL_SENDER", worker: mailSender }],
      routing: [{ channel: "email", category_match: "*", provider: "cf-email.primary" }],
    },
  };
}

/** The spec files as text, formatted like the reference generator (2-space JSON, trailing newline, no \u escapes). */
export function specFiles(config) {
  return Object.fromEntries(Object.entries(buildSpecs(config)).map(([f, v]) => [f, JSON.stringify(v, null, 2) + "\n"]));
}
