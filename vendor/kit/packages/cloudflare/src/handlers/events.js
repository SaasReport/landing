/**
 * Events: /events/, /events/<slug>, /events/<slug>.ics, /events/<slug>/add (Google / Apple / Outlook chooser),
 * /api/events, and (config.events.rsvp) POST /api/forms/event-rsvp → D1 `leads` + optional COMMS acknowledgement.
 */
import { renderMarkdown, calendarLinks, eventIcs as coreEventIcs } from "@saasreport/core";
import { esc, html, json, jsonRes, redirect, sha256 } from "../util.js";
import { icon } from "../shell.js";
import { readJsonBody } from "../body.js";
import { submitForm, acceptDrill, recordDrillOutcome, newReference, DRILL_HEADER, DRILL_SECRET } from "@saasreport/core/form-deliveries";

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
/** The route's form name (/api/forms/<name>): the form a drill header is bound to, the monitor's `drill.form`. */
const RSVP_FORM_PATH = "event-rsvp";
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);

/** One event as an iCalendar file (core eventIcs with the site's wording for online events). */
export function eventIcs(k, e) {
  const url = k.abs(`/events/${e.slug}`);
  return coreEventIcs(k.rawConfig, { slug: e.slug, title: e.title, start: e.starts_at, end: e.ends_at, details: `${e.summary}\n${url}`, url,
    location: e.format === "online" ? k.t("events.online") : e.location || "", status: e.status }, k.now());
}

export function createEvents(k) {
  const { t, config } = k;
  const H = k.href, [lw, lb] = k.where();
  const fmtLabel = (e) => t(`format.${e.format}`);
  const where = (e) => (e.format === "online" ? t("events.online") : e.location || t("events.tbd"));
  const links = (e) => calendarLinks({ title: e.title, start: e.starts_at, end: e.ends_at, details: k.abs(`/events/${e.slug}`), location: where(e), timezone: config.site.timezone });
  const calButtons = (e, office = false) => {
    const c = links(e);
    return `<a class="btn btn--ghost btn--sm" data-cal="google" href="${esc(c.google)}" target="_blank" rel="noopener">${icon("cal")}${esc(t("events.google"))}</a><a class="btn btn--ghost btn--sm" data-cal="apple" href="${H("/events/")}${esc(e.slug)}.ics">${icon("cal")}${esc(t("events.apple"))}</a><a class="btn btn--ghost btn--sm" data-cal="outlook" href="${esc(c.outlook)}" target="_blank" rel="noopener">${icon("cal")}${esc(t("events.outlook"))}</a>${office ? `<a class="btn btn--ghost btn--sm" data-cal="office" href="${esc(c.office)}" target="_blank" rel="noopener">${icon("cal")}${esc(t("events.office"))}</a>` : ""}`;
  };
  const card = (e) => {
    const past = Date.parse(e.ends_at) < k.now().getTime();
    return `<article class="ecard${past ? " is-past" : ""}${e.status === "cancelled" ? " is-cancel" : ""}"><a href="${H("/events/")}${esc(e.slug)}">
  <span class="ecard__date"><b>${esc(k.fmtPart(e.starts_at, { day: "numeric" }))}</b><small>${esc(k.fmtPart(e.starts_at, { month: "short" }))}</small></span>
  <span class="ecard__body"><span class="kb">${esc(fmtLabel(e))}</span>${e.status === "cancelled" ? `<span class="kb kb--cancel">${esc(t("events.cancelled"))}</span>` : ""}
  <h3>${esc(e.title)}</h3><p>${esc(e.summary)}</p><span class="meta">${icon("clock")}${esc(k.fmtWhen(e.starts_at))}${e.format !== "online" && e.location ? `${esc(t("meta.sep"))}${icon("pin")}${esc(e.location)}` : ""}</span></span></a></article>`;
  };
  const ogOf = (o) => (o?.image ? { image: o.image, ...(o.alt ? { alt: o.alt } : {}) } : {});
  const lead = () => config.events.lead || t("events.lead");
  const byslug = (env, slug) => env.DB.prepare(`SELECT * FROM events WHERE slug = ?${lw}`).bind(slug, ...lb).first();

  async function index(env) {
    const now = k.now().toISOString();
    const up = (await env.DB.prepare(`SELECT * FROM events WHERE ends_at >= ?${lw} ORDER BY starts_at LIMIT 50`).bind(now, ...lb).all()).results || [];
    const past = (await env.DB.prepare(`SELECT * FROM events WHERE ends_at < ?${lw} ORDER BY starts_at DESC LIMIT 12`).bind(now, ...lb).all()).results || [];
    const body = `
${k.hero("events", { lead: lead() })}
<section class="wrap"><h2 class="sec">${esc(t("events.upcoming"))}</h2>
  ${up.length ? `<div class="grid grid--2">${up.map(card).join("")}</div>` : t.opt("events.emptyNote") ? `<div class="empty empty--box"><b>${esc(t("events.empty"))}</b><p>${esc(t("events.emptyNote"))}</p></div>` : `<p class="empty empty--box">${esc(t("events.empty"))}</p>`}</section>
${past.length ? `<section class="wrap"><h2 class="sec">${esc(t("events.past"))}</h2><div class="grid grid--2">${past.map(card).join("")}</div></section>` : ""}`;
    const jsonld = k.graph({ "@type": "ItemList", itemListElement: up.map((e, i) => ({ "@type": "ListItem", position: i + 1, url: k.abs(`/events/${e.slug}`), name: e.title })) },
      k.crumbs([[t("nav.home"), "/"], [t("events.title"), "/events/"]]));
    return html(k.page({ title: k.pageTitle("events", t("events.title")), description: t.opt("events.description") || lead(), path: "/events/", body, active: "events", jsonld, placement: "events",
      og: ogOf(config.events.og), after: k.subscribe("events") }));
  }

  async function addPage(env, slug) {
    const e = await byslug(env, slug);
    if (!e) return null;
    const body = `<section class="hero wrap"><p class="eyebrow">${esc(t("events.addTitle"))}</p><h1>${esc(e.title)}</h1>
<p>${esc(t("events.addLead", { when: k.fmtWhen(e.starts_at) }))}</p>
<div class="hero__act wrapx">${calButtons(e, true)}</div>
<p class="note">${esc(t("events.addNote"))} <a class="link" href="${H("/events/")}${esc(e.slug)}">${esc(t("events.page"))}</a></p></section>`;
    return html(k.page({ title: `${t("events.addTitle")}: ${e.title} | ${config.site.name}`, description: e.summary, path: `/events/${e.slug}`, robots: "noindex, follow", body, active: "events" }));
  }

  async function eventPage(env, slug) {
    const e = await byslug(env, slug);
    if (!e) return null;
    const open = config.events.rsvp && e.status === "scheduled" && Date.parse(e.starts_at) > k.now().getTime();
    const form = open ? `<b>${esc(t("events.rsvp"))}</b>
      <form class="form" data-form="event-rsvp" novalidate>
        <input type="hidden" name="event" value="${esc(e.slug)}">
        <label><span>${esc(t("form.name"))}</span><input name="name" required maxlength="120" autocomplete="name"></label>
        <label><span>${esc(t("form.email"))}</span><input name="email" type="email" required maxlength="200" autocomplete="email" dir="ltr"></label>
        <label><span>${esc(t("form.company"))}</span><input name="company" maxlength="160" autocomplete="organization"></label>
        <label><span>${esc(t("form.role"))}</span><input name="role" maxlength="120"></label>
        <input name="website" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true">
        <label class="form__ok"><input type="checkbox" name="consent" required><span>${config.events.privacyUrl ? `<a href="${esc(config.events.privacyUrl)}">${esc(t("form.consent"))}</a>` : esc(t("form.consent"))}</span></label>
        <button class="btn btn--primary" type="submit">${esc(t.opt("events.rsvpButton") || t("events.rsvp"))}</button>
      </form>` : config.events.rsvp ? `<b>${esc(t("events.rsvpClosed"))}</b>` : "";
    const body = `
<article class="wrap post">
  <nav class="crumbs" aria-label="${esc(t("crumbs"))}"><a href="${H("/events/")}">${esc(t("events.title"))}</a></nav>
  <header class="post__head"><span class="kb">${esc(fmtLabel(e))}</span>${e.status === "cancelled" ? `<span class="kb kb--cancel">${esc(t("events.cancelled"))}</span>` : ""}<h1>${esc(e.title)}</h1><p class="lead">${esc(e.summary)}</p>
    <div class="meta"><span>${icon("cal")}${esc(k.fmtWhen(e.starts_at))}</span><span>${icon("clock")}${esc(t("events.until", { time: k.fmtTime(e.ends_at) }))}</span>${e.format !== "online" && e.location ? `<span>${icon("pin")}${esc(e.location)}</span>` : ""}</div>
    <div class="share"><b>${esc(t("events.addToCal"))}</b>${calButtons(e)}</div></header>
  <div class="post__grid">
    <div class="post__body"><div class="md">${renderMarkdown(e.body_md, { origin: config.site.url }).html}</div></div>
    ${form ? `<aside class="aside">${form}</aside>` : ""}
  </div>
</article>`;
    // The join link is not published (it goes to registered attendees); options.events.publicJoinUrl: true exposes it.
    const loc = e.format === "online" ? { "@type": "VirtualLocation", url: (config.events.publicJoinUrl && e.join_url) || k.abs(`/events/${e.slug}`) } : { "@type": "Place", name: e.location || t("events.tbd"), address: e.location || t("events.tbd") };
    const jsonld = k.graph({ "@type": "Event", "@id": `${k.abs(`/events/${e.slug}`)}#event`, name: e.title, description: e.summary, startDate: e.starts_at, endDate: e.ends_at, url: k.abs(`/events/${e.slug}`),
      eventStatus: e.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
      eventAttendanceMode: e.format === "online" ? "https://schema.org/OnlineEventAttendanceMode" : e.format === "hybrid" ? "https://schema.org/MixedEventAttendanceMode" : "https://schema.org/OfflineEventAttendanceMode",
      location: e.format === "hybrid" ? [loc, { "@type": "VirtualLocation", url: k.abs(`/events/${e.slug}`) }] : loc, organizer: k.orgRef(), inLanguage: config.site.localeBase,
      ...((config.events.itemOg || config.events.og)?.image ? { image: k.abs((config.events.itemOg || config.events.og).image) } : {}) },
    k.crumbs([[t("nav.home"), "/"], [t("events.title"), "/events/"], [e.title, `/events/${e.slug}`]]));
    const og = config.events.itemOg || config.events.og;
    return html(k.page({ title: k.itemTitle("events", e.title), description: e.summary, path: `/events/${e.slug}`, body, active: "events", jsonld, og: { type: "article", title: e.title, ...(og?.image ? { image: og.image } : {}) } }));
  }

  async function rsvp(request, env, ctx) {
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    const origin = request.headers.get("origin");
    if (origin) { try { const o = new URL(origin); if (o.host !== new URL(request.url).host && o.origin !== config.site.origin) return json({ ok: false, error: "forbidden_origin" }, 403); } catch { return json({ ok: false, error: "forbidden_origin" }, 403); } }
    if (!(request.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "bad_content_type" }, 415);
    const { value: body, response: refused } = await readJsonBody(request);
    if (refused) return refused;
    if (!body || typeof body !== "object") return json({ ok: false, error: "invalid_json" }, 400);
    // a test submission (the monitor's drill) only with the signed header, authenticated BEFORE anything is written: anyone else asking
    // for `test` is refused, never quietly downgraded (the drill proves the path; a visitor's receipt must not be redirected). The
    // header is bound to this form and accepted once (a replay is refused).
    let test = false;
    if (body.test !== undefined) {
      if (body.test !== true) return json({ ok: false, error: "invalid_field", field: "test" }, 422);
      if (!(await acceptDrill(env.DB, env[DRILL_SECRET], RSVP_FORM_PATH, request.headers.get(DRILL_HEADER), k.now().getTime()))) return json({ ok: false, error: "drill_not_signed", field: "test" }, 403);
      test = true;
    }
    const ref = newReference("R");
    if (body.website) return json({ ok: true, reference: ref }); // honeypot
    if (body.consent !== true) return json({ ok: false, error: "consent_required", field: "consent" }, 422);
    const v = { event: clean(body.event, 90), name: clean(body.name, 120), email: clean(body.email, 200).toLowerCase(), company: clean(body.company, 160), role: clean(body.role, 120) };
    for (const f of ["event", "name", "email"]) if (!v[f]) return json({ ok: false, error: "missing_field", field: f }, 422);
    if (!EMAIL_RE.test(v.email)) return json({ ok: false, error: "invalid_email", field: "email" }, 422);
    const e = await byslug(env, v.event);
    if (!e || e.status !== "scheduled" || Date.parse(e.starts_at) < k.now().getTime()) return json({ ok: false, error: "event_unavailable", field: "event" }, 422);
    const salt = env.IP_SALT || config.site.id;
    const ipHash = await sha256(`${request.headers.get("cf-connecting-ip") || "0.0.0.0"}|${salt}`);
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE ip_hash = ? AND created_at > ?").bind(ipHash, new Date(k.now().getTime() - 10 * 60_000).toISOString()).first();
    if ((recent?.n || 0) >= 8) return json({ ok: false, error: "rate_limited" }, 429);
    const now = k.now().toISOString();
    await env.DB.prepare("INSERT INTO leads (id, form, ref, name, email, email_hash, company, fields_json, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(ref, "event-rsvp", e.slug, v.name, v.email, await sha256(v.email), v.company || null, JSON.stringify(v), ipHash, now).run();
    // delivered by the comms engine as a declared form (docs/FORMS.md): the receipt to the visitor and the owner's notification,
    // both recorded in comms_form_deliveries; this handler never sends either itself
    const fields = [[t("events.title"), e.title], [t("form.name"), v.name], [t("form.email"), v.email], ...(v.company ? [[t("form.company"), v.company]] : []), ...(v.role ? [[t("form.role"), v.role]] : [])];
    const out = await submitForm(env, {
      form_id: config.events.rsvpForm, reference: ref, form_label: config.events.rsvpForm, submitter: { email: v.email }, test, locale: config.site.lang,
      params: { name: v.name, reference: ref, submitted_at: k.fmtWhen(now), event: e.title, event_when: k.fmtWhen(e.starts_at), event_where: where(e),
        event_url: k.abs(`/events/${e.slug}`), event_add: k.abs(`/events/${e.slug}/add`),
        fields_html: fields.map(([label, value]) => `<p><strong>${esc(label)}</strong><br>${esc(value)}</p>`).join(""), fields_text: fields.map(([label, value]) => `${label}: ${value}`).join("\n") },
    }, { site: config.site.origin });
    const status = out.receipt;
    const upd = env.DB.prepare("UPDATE leads SET comms_status = ? WHERE id = ?").bind(status, ref).run();
    ctx?.waitUntil ? ctx.waitUntil(upd) : await upd;
    // a submission no ledger holds is not accepted: the visitor is told, so they can write again, and nothing is silently lost
    if (test) await recordDrillOutcome(env.DB, request.headers.get(DRILL_HEADER), out.recorded ? "recorded" : "not_recorded");
    // 503 only when no ledger row exists. An engine row whose final status write failed IS recorded: the visitor is not asked to write
    // again (a duplicate lead and duplicate emails); the answer says so and the monitor counts the pending row
    if (!out.recorded) return json({ ok: false, error: "not_recorded", reference: ref }, 503);
    return json({ ok: true, reference: ref, email_status: status, recorded: true, ...(out.outcome_recorded === false ? { outcome_recorded: false } : {}) });
  }

  async function handle(request, env, url, ctx) {
    const p = url.pathname;
    if (p === `/api/forms/${RSVP_FORM_PATH}`) return config.events.rsvp ? rsvp(request, env, ctx) : null;
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    if (p === "/events") return redirect(`${H("/events/")}${url.search}`);
    if (p === "/events/") return index(env);
    if (p === "/api/events") {
      const rows = (await env.DB.prepare(`SELECT slug, title, summary, starts_at, ends_at, format, location, status FROM events WHERE ends_at >= ?${lw} ORDER BY starts_at LIMIT 50`).bind(k.now().toISOString(), ...lb).all()).results || [];
      return jsonRes(await k.api("events", { ok: true, events: rows.map((e) => ({ ...e, when_label: k.fmtWhen(e.starts_at), url: k.abs(`/events/${e.slug}`), ics: k.abs(`/events/${e.slug}.ics`), add: k.abs(`/events/${e.slug}/add`) })) }, { url, env, rows }));
    }
    let m = p.match(/^\/events\/([a-z0-9-]{1,90})\/add\/?$/);
    if (m) return (await addPage(env, m[1])) || k.notFound();
    m = p.match(/^\/events\/([a-z0-9-]{1,90})\.ics$/);
    if (m) {
      const e = await byslug(env, m[1]);
      return e ? new Response(eventIcs(k, e), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="${e.slug}.ics"` } }) : k.notFound();
    }
    m = p.match(/^\/events\/([a-z0-9-]{1,90})\/?$/);
    if (m) return (await eventPage(env, m[1])) || k.notFound();
    return null;
  }
  return { handle };
}
