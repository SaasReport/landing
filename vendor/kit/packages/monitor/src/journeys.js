/**
 * Journeys: what a visitor does on the site, each with assertions that fail loudly.
 *
 * Builtin journeys are derived from config.features, config.series, config.shows and config.site.url;
 * selectors, paths and expectations come from config.monitor (defaults match the kit's HTML).
 * Custom journeys come from config.monitor.journeys (functions or declarative checks).
 *
 * A journey gets a context: { site, config, now, today, page(url) → {p, errors}, get(path, init) → Response,
 * json(path) → data, expect(cond, message), selectors }. `page` opens a URL in the shared browser and
 * collects console errors; `get` is a plain fetch against the site.
 */
import { expect } from "./policy.js";
import { jalaliFor } from "@saasreport/calendar/instant";
import { signDrill, DRILL_HEADER, DRILL_SECRET } from "@saasreport/core/form-deliveries";

const on = (config, f) => config.features?.[f] !== false;

export const DEFAULT_SELECTORS = {
  heading: "h1",
  sections: { podcasts: "#podcasts", glossary: "#glossary", calendar: "#calendar", blog: "#blog", events: "#events" },
  glossaryToday: "[data-glossary-today]",        // landing widget, rendered lazily when scrolled into view
  glossaryEmpty: "[data-glossary-empty]",        // its "nothing today" state
  glossarySearch: "[data-gsearch]",
  glossaryTerm: "[data-gterm]",
  glossaryCategory: "[data-gcat]",
  show: "#{show}",                                // a show's section on /podcasts/
  transcript: "[data-transcript]",
  datePicker: null,                               // null → any custom element whose name ends with "-date-picker"
};

export const DEFAULT_PATHS = {
  landing: "/",
  glossary: "/glossary/",
  glossaryTerm: "/glossary/{slug}",
  glossaryToday: "/api/glossary/today",
  podcasts: "/podcasts/",
  podcastsApi: "/api/podcasts?series={series}&limit={limit}",
  calendar: "/calendar/",
  calendarApi: ["/api/calendar/today"],
  blogFeed: "/blog/feed.xml",
  blogPost: "/blog/{slug}",
  showFeed: "/podcasts/{show}/feed.xml",
  sitemap: "/sitemap.xml",
  llms: "/llms.txt",
  robots: "/robots.txt",
  formDeliveries: "/api/forms/deliveries",
  formSubmit: "/api/forms/{form}",
};

const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** Resolved monitor settings (selectors/paths merged over defaults). */
export function monitorSettings(config = {}) {
  const m = config.monitor || {};
  const sel = { ...DEFAULT_SELECTORS, ...(m.selectors || {}), sections: { ...DEFAULT_SELECTORS.sections, ...(m.selectors?.sections || {}) } };
  return { m, sel, paths: { ...DEFAULT_PATHS, ...(m.paths || {}) } };
}

/** Series that make podcast episodes: [{ series, show, maxSeconds }]. With `parts` (localParts), only series whose first
 * episode is already due (see hasStarted), so a show announced ahead of its start date is not reported as missing. */
export function podcastSeries(config = {}, parts = null) {
  return (config.series || []).filter((s) => s.podcast && (!parts || hasStarted(s, parts))).map((s) => {
    const show = (typeof s.podcast === "object" && s.podcast.show) || s.id;
    const maxSeconds = (typeof s.podcast === "object" ? s.podcast.maxSeconds : undefined) ?? config.shows?.[show]?.maxSeconds;
    return { series: s.id, show, maxSeconds: maxSeconds || null };
  });
}

// ---------- local time and "due today" ----------

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Calendar parts of `now` in the site timezone: { iso, weekday (0=Sun), day, localDay (per calendar system), hm }. */
export function localParts(config = {}, now = new Date()) {
  const timeZone = config.site?.timezone || "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = WEEKDAYS.indexOf(parts.weekday.slice(0, 3).toLowerCase());
  let localDay = Number(parts.day);
  const system = config.calendar?.system;
  if (system === "jalali" || system === "persian") {
    localDay = jalaliFor(now, timeZone).jd; // arithmetic Solar Hijri, never ICU's Persian calendar
  }
  return { iso, weekday, day: Number(parts.day), localDay, hm: `${parts.hour}:${parts.minute}` };
}

const weekdayOf = (v) => (typeof v === "number" ? v : WEEKDAYS.indexOf(String(v).slice(0, 3).toLowerCase()));

/** Has the series' first publishing slot (on or after `start`) passed? Series without `start` have always started. */
export function hasStarted(series, parts) {
  if (!series.start) return true;
  let first = series.start;
  const on = (Array.isArray(series.on) ? series.on : series.on == null ? [] : [series.on]).map(weekdayOf).filter((d) => d >= 0);
  if (series.every === "week" && on.length) {
    const d = new Date(`${series.start}T00:00:00Z`);
    while (!on.includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    first = d.toISOString().slice(0, 10);
  }
  if (parts.iso !== first) return parts.iso > first;
  return !series.at || parts.hm >= series.at;
}

/** Is the series due today and past its publishing time? (daily / weekly on a weekday / monthly on a day of month). */
export function isDueToday(series, parts) {
  if (series.start && parts.iso < series.start) return false;
  if (series.end && parts.iso > series.end) return false;
  if (series.at && parts.hm < series.at) return false;
  const on = Array.isArray(series.on) ? series.on : series.on == null ? [] : [series.on];
  switch (series.every) {
    case "day": return true;
    case "week": return on.map(weekdayOf).includes(parts.weekday);
    case "month": return on.map(Number).includes(parts.localDay);
    default: return false;
  }
}

/** The series due today (in the site's timezone and calendar system). */
export const seriesDueToday = (config = {}, now = new Date()) => {
  const parts = localParts(config, now);
  return (config.series || []).filter((s) => isDueToday(s, parts));
};

// ---------- builtin journeys ----------

const consoleClean = (errors, ignore = []) => {
  const re = ignore.map((x) => (x instanceof RegExp ? x : new RegExp(x)));
  const left = errors.filter((e) => !re.some((r) => r.test(e)));
  expect(!left.length, `console errors: ${left.join(" | ")}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Datepicker probe: explicit selector, or any element whose tag ends with "-date-picker". */
async function hasDatePicker(p, selector) {
  if (selector) return Boolean(await p.$(selector));
  return p.evaluate(() => [...document.querySelectorAll("*")].some((e) => /-date-picker$/.test(e.localName)));
}

/** Poll one form-delivery record until both deliveries are final (not pending), or the deadline passes. */
async function deliveryOf(get, path, { timeoutMs = 60_000, everyMs = 2_000 } = {}) {
  const end = Date.now() + timeoutMs;
  let rec = null;
  for (;;) {
    const r = await get(path);
    rec = r.ok ? await r.json() : { error: `${path} → ${r.status}` };
    if (rec.receipt && rec.owner && rec.receipt.status !== "pending" && rec.owner.status !== "pending") return rec;
    if (Date.now() >= end) return rec;
    await wait(everyMs);
  }
}

export const BUILTINS = {
  landing: {
    when: () => true,
    run: async ({ page, config, m, sel, paths, ignore }) => {
      const { p, errors } = await page(paths.landing);
      expect(await p.$(sel.heading), `no ${sel.heading} on ${paths.landing}`);
      const sections = m.landing?.sections || ["podcasts", "glossary", "calendar"].filter((f) => on(config, f));
      for (const s of sections) {
        const css = sel.sections[s] || s;
        expect(await p.$(css), `missing section ${css}`);
      }
      const lazy = m.landing?.lazy ?? (on(config, "glossary") && sel.glossaryToday
        ? [{ scrollTo: sel.sections.glossary, waitFor: [sel.glossaryToday, sel.glossaryEmpty].filter(Boolean).join(", "), expect: sel.glossaryToday, label: "term of the day" }]
        : []);
      for (const l of lazy) {
        // Scroll like a visitor (wheel steps), so IntersectionObservers of lazy sections fire. The section's position is measured again after
        // every step, never once: lazy content above it grows the page while it scrolls, and a target measured at the start ends short of
        // the section (two downstream sites, 2026-10-11 on: "term of the day did not load", the widget left at
        // the viewport's edge, so its observer never fired). Stops at 200 px from the top, when a step moves nothing (the page's end), or
        // when the section cannot be measured (the journey then asserts what it sees).
        await p.bringToFront?.();
        let before = null;
        for (let step = 0; step < 400; step++) {
          const top = await p.$eval(l.scrollTo, (e) => e.getBoundingClientRect().top).catch(() => null);   // an element that cannot be measured stops the scroll; the journey asserts what it sees
          if (top === null || top <= 200 || top === before) break;
          before = top;
          await p.mouse.wheel({ deltaY: Math.min(700, Math.ceil(top - 200)) }); await wait(120);
        }
        try { await p.waitForSelector(l.waitFor, { timeout: l.timeout || 15000 }); }
        catch { throw new Error(`${l.label || l.waitFor} did not load; errors: ${errors.join(" | ") || "none"}`); }
        if (l.expect) expect(await p.$(l.expect), `${l.label || l.expect} did not render`);
      }
      // monitor.landing.counts: { selector: n } (e.g. a widget's categories) must match exactly.
      for (const [css, n] of Object.entries(m.landing?.counts || {})) {
        const got = (await p.$$(css)).length;
        expect(got === n, `${css}: ${got} (expected ${n})`);
      }
      consoleClean(errors, ignore);
    },
  },

  glossary: {
    when: (config) => on(config, "glossary"),
    run: async ({ page, get, config, m, sel, paths, ignore }) => {
      const g = m.glossary || {};
      const { p, errors } = await page(paths.glossary);
      const cats = (await p.$$(sel.glossaryCategory)).length;
      expect(g.categories ? cats === g.categories : cats > 0, `glossary categories: ${cats}${g.categories ? ` (expected ${g.categories})` : ""}`);
      // The term to look for: config, else today's term from the API, else the first term on the page.
      let { query, slug, term } = g, strict = Boolean(term);
      if (!slug) {
        const r = await get(paths.glossaryToday).catch(() => null);   // no API answer: fall back to the first term on the page, asserted below
        const t = r?.ok ? (await r.json().catch(() => ({}))).term : null;   // no term: fall back to the page, asserted below
        if (t?.slug) { slug = t.slug; term = t.term || t.title; strict = Boolean(term); }
      }
      if (!slug) {
        const first = await p.$eval(sel.glossaryTerm, (a) => ({ href: a.getAttribute("href") || "", text: (a.querySelector("b,strong,h2,h3") || a).textContent.trim() })).catch(() => null);   // no term found is asserted by the expect on the next line
        expect(first, `no glossary terms (${sel.glossaryTerm})`);
        slug = decodeURIComponent(first.href.replace(/\/+$/, "").split("/").pop());
        term = first.text;
      }
      query = query || term;
      if (query) {
        const total = (await p.$$(sel.glossaryTerm)).length;
        await p.type(sel.glossarySearch, query);
        await wait(300);
        const visible = await p.$$eval(sel.glossaryTerm, (as) => as.filter((a) => !a.hidden && a.offsetParent !== null).map((a) => a.textContent));
        expect(visible.length > 0 && (total <= 1 || visible.length < total) && visible.some((t) => t.includes(query)),
          `search «${query}» shows ${visible.length} of ${total} terms`);
      }
      const t = await page(fill(paths.glossaryTerm, { slug: encodeURIComponent(slug) }));
      const h1 = await t.p.$eval(sel.heading, (h) => h.textContent.trim());
      expect(strict ? h1 === term : h1.length > 0, `term page ${sel.heading} is «${h1}», expected «${term}»`);
      expect(/"@type"\s*:\s*"DefinedTerm"/.test(await t.p.content()), "no DefinedTerm JSON-LD");
      consoleClean([...errors, ...t.errors], ignore);
      return `${slug}`;
    },
  },

  podcasts: {
    when: (config) => on(config, "podcasts") && podcastSeries(config).length > 0,
    run: async ({ page, get, json, config, m, sel, paths, ignore, now }) => {
      const list = podcastSeries(config, localParts(config, now));
      const minBytes = m.podcasts?.minBytes ?? 50_000;
      const { p, errors } = await page(paths.podcasts);
      for (const show of new Set(list.map((x) => x.show))) {
        const css = fill(sel.show, { show });
        expect(await p.$(css), `show ${css} not on ${paths.podcasts}`);
      }
      const notes = [];
      for (const { series, maxSeconds } of list) {
        const d = await json(fill(paths.podcastsApi, { series: encodeURIComponent(series), limit: 1 }));
        const e = (d.episodes || d.items || [])[0];
        expect(e, `no ${series} episode`);
        if (maxSeconds) expect(e.duration_ms > 0 && e.duration_ms <= maxSeconds * 1000, `${e.slug} runs ${e.duration_ms} ms (max ${maxSeconds * 1000})`);
        expect(e.audio, `${e.slug} has no audio url`);
        // The t=0 rule: an episode on production must carry an accepted pipeline provenance record (the API reports why not).
        // …and the whole archive, not only the newest episode: the API audits every published row.
        if (m.podcasts?.provenance !== false) expect(d.audit && d.audit.unaccepted === 0, d.audit ? `${d.audit.unaccepted} of ${d.audit.published} published episodes have no accepted provenance, e.g. ${d.audit.problems.slice(0, 3).map((x) => `${x.slug}: ${x.problem}`).join("; ")}` : "the API does not audit provenance (kit too old)");
        // A due day that still has no episode after the catch-up window is an alert; catch-ups that did happen are reported on their own.
        if (m.podcasts?.provenance !== false && d.audit) expect(!d.audit.missing_count, `${d.audit.missing_count} due day(s) have no episode (catch-up did not fill them), e.g. ${(d.audit.missing || []).slice(0, 3).map((x) => `${x.date} ${x.slug}`).join("; ")}`);
        if (d.audit?.catchup?.count && !notes.some((n) => n.startsWith("catch-ups:"))) notes.push(`catch-ups: ${d.audit.catchup.count} episode(s) made by the cron for missed days (${d.audit.catchup.slugs.slice(0, 3).join(", ")})`);
        if (m.podcasts?.provenance !== false) expect(e.provenance_problem === null, `${e.slug}: ${e.provenance_problem ?? "the API does not report provenance (kit too old)"}`);
        const a = await get(e.audio, { headers: { range: "bytes=0-1023" } });
        expect(a.status === 206, `${e.audio} range → ${a.status}`);
        const size = Number((a.headers.get("content-range") || "").split("/")[1]);
        expect(size > minBytes, `${e.audio} is ${size} bytes (min ${minBytes})`);
        try { await a.body?.cancel(); } catch { /* the stream is already closed or errored: nothing is left to release */ }
        const ep = await page(e.url || `/podcasts/${e.slug}`);
        expect(await ep.p.$(sel.transcript), `${e.url || e.slug} has no transcript (${sel.transcript})`);
        errors.push(...ep.errors);
        notes.push(`${series}: ${e.slug} ${Math.round((e.duration_ms || 0) / 1000)}s`);
      }
      consoleClean(errors, ignore);
      return notes.join("; ");
    },
  },

  publishing: {
    when: (config) => (config.series || []).length > 0,
    run: async ({ get, json, config, m, paths, now }) => {
      const parts = localParts(config, now);
      const due = (config.series || []).filter((s) => isDueToday(s, parts));
      const notes = [];
      const slugs = m.publishing?.slugs || {};
      for (const s of due) {
        if (s.glossary && on(config, "glossary")) {
          const t = await json(paths.glossaryToday);
          expect(t.term, `${s.id}: no term of the day`);
          if (s.podcast && on(config, "podcasts")) expect(t.episode, `${s.id}: today's episode (${t.number ?? "?"}, ${t.term.slug}) is not published`);
          notes.push(`${s.id}: ${t.term.slug}`);
          continue;
        }
        const tpl = slugs[s.id] || s.slugPattern;
        const slug = tpl ? fill(tpl, { date: parts.iso, series: s.id }) : null;
        if (s.podcast && on(config, "podcasts")) {
          const d = await json(fill(paths.podcastsApi, { series: encodeURIComponent(s.id), limit: 3 }));
          const eps = d.episodes || d.items || [];
          const localIso = (x) => (x ? localParts(config, new Date(x)).iso : "");
          const hit = slug ? eps.find((e) => e.slug === slug) : eps.find((e) => localIso(e.published_at || e.date) === parts.iso || e.date === parts.iso);
          expect(hit, `${s.id}: ${slug || `an episode of ${parts.iso}`} is not published`);
          notes.push(`${s.id}: ${hit.slug}`);
        }
        if (s.post && slug && on(config, "blog")) {
          const r = await get(fill(paths.blogPost, { slug }));
          expect(r.ok, `${fill(paths.blogPost, { slug })} → ${r.status}`);
          if (!s.podcast) notes.push(`${s.id}: ${slug}`);
        }
      }
      return notes.length ? notes.join("; ") : `nothing due ${parts.iso}`;
    },
  },

  calendar: {
    when: (config) => on(config, "calendar"),
    run: async ({ page, json, m, sel, paths, ignore }) => {
      const c = m.calendar || {};
      const checks = [
        ...[].concat(paths.calendarApi || []).map((path) => ({ path })),
        ...(c.checks || []),
      ];
      for (const chk of checks) {
        const d = await json(chk.path);
        expect(d && d.ok !== false, `${chk.path} → ok: false`);
        if (chk.expect) {
          const r = await chk.expect(d);
          expect(r === true || r === undefined, typeof r === "string" ? r : `${chk.path}: unexpected response`);
        }
      }
      const { p, errors } = await page(paths.calendar);
      expect(await hasDatePicker(p, sel.datePicker), `no date picker on ${paths.calendar}`);
      consoleClean(errors, ignore);
    },
  },

  feeds: {
    when: () => true,
    run: async ({ get, config, paths, now }) => {
      const feeds = [], empty = new Set(); // empty: feeds of shows whose series have not started yet (no items expected)
      if (on(config, "blog")) feeds.push(paths.blogFeed);
      if (on(config, "podcasts")) {
        const started = new Set(podcastSeries(config, localParts(config, now)).map((x) => x.show));
        for (const show of new Set(podcastSeries(config).map((x) => x.show).concat(Object.keys(config.shows || {})))) {
          const f = config.shows?.[show]?.feed || fill(paths.showFeed, { show });
          feeds.push(f);
          if (!started.has(show) && podcastSeries(config).some((x) => x.show === show)) empty.add(f);
        }
      }
      for (const f of new Set(feeds)) {
        const r = await get(f); const x = await r.text();
        if (empty.has(f)) expect(r.ok && x.includes("<rss"), `${f} is not an RSS feed (${r.status})`);
        else expect(r.ok && x.includes("<rss") && x.includes("<item"), `${f} is not an RSS feed with items (${r.status})`);
      }
      const checked = [...new Set(feeds)];
      if (on(config, "sitemap")) {
        const r = await get(paths.sitemap); const x = await r.text();
        expect(r.ok && /<(urlset|sitemapindex)/.test(x), `${paths.sitemap} → ${r.status}, not a sitemap`);
        if (on(config, "glossary")) expect(x.includes("/glossary/"), `${paths.sitemap} has no /glossary/`);
        checked.push(paths.sitemap);
      }
      if (on(config, "llms")) {
        const r = await get(paths.llms); const x = await r.text();
        expect(r.ok && /^#\s/m.test(x), `${paths.llms} → ${r.status}, no markdown heading`);
        checked.push(paths.llms);
      }
      const robots = await get(paths.robots);
      expect(robots.ok, `${paths.robots} → ${robots.status}`);
      if (on(config, "sitemap")) expect(/sitemap:/i.test(await robots.text()), `${paths.robots} does not list the sitemap`);
      checked.push(paths.robots);
      return checked.join(" ");
    },
  },

  // Every form is delivered twice, the receipt and the owner's notification (docs/FORMS.md). The site's ledger summary answers 503
  // when an owner delivery failed or is still pending past its window: the journey fails, alerts through every route, shows on /status.
  // Site-wide (one ledger), so it does not repeat per locale. Off only with monitor.forms: false (a site with no form).
  "form-deliveries": {
    when: (config) => config.monitor?.forms !== false,
    perLocale: false,
    run: async ({ get, paths }) => {
      const r = await get(paths.formDeliveries);
      const s = await r.json().catch(() => ({}));   // an unreadable answer fails on the next line with its status
      expect(r.status === 200 && s.ok === true,
        `form deliveries: ${r.status}${s.error ? ` ${s.error}` : ""}; owner failed ${s.owner_failed ?? "?"}, owner pending past ${s.pending_after_min ?? "?"} min ${s.owner_pending_stale ?? "?"}, last owner failure ${s.last_owner_failure_at || "none"} (window ${s.window_hours ?? "?"} h)`);
    },
  },
  // The drill: a synthetic, test-marked submission of monitor.drill.form, then both deliveries proved in the ledger. Runs on
  // POST /run?mode=drill and, scheduled, on the first cron run of monitor.drill.weekday (a name or 0-6) at or after monitor.drill.at
  // (HH:MM, site time; the series mechanism, isDueToday), once a day: a run is skipped when the ledger already holds today's test
  // row (summary.last_test_at), so the cron's other runs of that day send nothing. The flag `test` is accepted by the
  // site only with the header signed by the shared secret FORMS_DRILL_KEY (both Workers): nobody else can mark a submission a test.
  // A test's receipt goes to the owner, never to the form's address. Other runs leave it out (it writes to the owner).
  "form-drill": {
    when: (config) => config.monitor?.forms !== false && Boolean(config.monitor?.drill?.form),
    perLocale: false,
    run: async ({ get, config, paths, trigger, site, now, env }) => {
      const d = config.monitor.drill;
      const parts = localParts(config, now);
      const slot = d.weekday !== undefined && isDueToday({ every: "week", on: [weekdayOf(d.weekday)], at: d.at }, parts);
      if (!(trigger === "drill" || (trigger === "cron" && slot))) return;
      if (trigger === "cron") {   // the scheduled drill is once a day: the ledger says whether it already ran
        const r = await get(paths.formDeliveries);
        const s = await r.json().catch(() => ({}));   // asserted on the next line
        expect((r.status === 200 || r.status === 503) && "last_test_at" in s, `drill: cannot tell whether today's drill already ran (${paths.formDeliveries} → ${r.status}${s.error ? ` ${s.error}` : ""})`);
        if (s.last_test_at && localParts(config, new Date(s.last_test_at)).iso === parts.iso) return;
      }
      const key = env?.[DRILL_SECRET];
      expect(key, `drill: the monitor has no ${DRILL_SECRET} (the shared secret that signs a test submission)`);
      const host = new URL(site).host;
      const body = { name: "ALERT DRILL (TEST)", email: `monitor-drill@${host}`, ...(d.fields || {}), consent: true, test: true };
      const r = await get(fill(paths.formSubmit, { form: d.form }), { method: "POST", headers: { "content-type": "application/json", origin: site, [DRILL_HEADER]: await signDrill(key, d.form, now.getTime()) }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));   // asserted on the next line
      expect(r.ok && out.ok && out.reference, `drill: POST ${fill(paths.formSubmit, { form: d.form })} → ${r.status} ${out.error || ""}`);
      const rec = await deliveryOf(get, `${paths.formDeliveries}/${encodeURIComponent(out.reference)}`, { timeoutMs: d.timeoutMs || 60_000 });
      expect(rec.test === true, `drill ${out.reference}: the ledger row is not marked test`);
      expect(rec.receipt?.status === "sent" && rec.owner?.status === "sent",
        `drill ${out.reference}: receipt ${rec.receipt?.status || rec.error} ${rec.receipt?.error || ""}; owner ${rec.owner?.status || rec.error} ${rec.owner?.error || ""}`);
    },
  },
};

// ---------- custom journeys ----------

/** Declarative custom journey: { name, path, status?, contains?, selectors?, json?(data), browser? }. */
function declarative(j) {
  return async ({ page, get, ignore }) => {
    const needsBrowser = j.browser ?? Boolean(j.selectors?.length);
    if (needsBrowser) {
      const { p, errors } = await page(j.path);
      for (const s of j.selectors || []) expect(await p.$(s), `${j.path}: missing ${s}`);
      if (j.contains) { const html = await p.content(); for (const c of [].concat(j.contains)) expect(html.includes(c), `${j.path}: does not contain «${c}»`); }
      if (j.consoleErrors !== true) consoleClean(errors, ignore);
      return;
    }
    const r = await get(j.path);
    expect(r.status === (j.status ?? 200) || (j.status == null && r.ok), `${j.path} → ${r.status}`);
    if (j.json) {
      const v = await j.json(await r.json());
      expect(v === true || v === undefined, typeof v === "string" ? v : `${j.path}: unexpected JSON`);
    } else if (j.contains) {
      const x = await r.text();
      for (const c of [].concat(j.contains)) expect(x.includes(c), `${j.path}: does not contain «${c}»`);
    }
  };
}

/**
 * The journeys to run, derived from config: [{ name, builtin, run(ctx) }].
 * config.monitor.journeys may contain builtin names (strings; then only those builtins run, in that order)
 * and custom journeys ({ name, run(ctx) } or declarative); config.monitor.skip removes names.
 */
export function journeys(config = {}) {
  const m = config.monitor || {};
  const listed = Array.isArray(m.journeys) ? m.journeys : [];
  const names = listed.filter((j) => typeof j === "string");
  for (const n of names) if (!BUILTINS[n]) throw new Error(`monitor: unknown builtin journey "${n}"`);
  const skip = new Set(m.skip || []);
  const builtins = (names.length ? names : Object.keys(BUILTINS))
    .filter((n) => !skip.has(n) && BUILTINS[n].when(config))
    .map((name) => ({ name, builtin: true, run: BUILTINS[name].run }));
  const custom = listed.filter((j) => j && typeof j === "object").map((j, i) => {
    const name = j.name || `custom-${i + 1}`;
    if (typeof j.run === "function") return { name, builtin: false, run: j.run };
    if (!j.path) throw new Error(`monitor: custom journey "${name}" needs run() or path`);
    return { name, builtin: false, run: declarative(j) };
  }).filter((j) => !skip.has(j.name));
  const all = [...builtins, ...localeJourneys(config, builtins.map((b) => b.name)), ...custom];
  const dup = all.map((j) => j.name).find((n, i, a) => a.indexOf(n) !== i);
  if (dup) throw new Error(`monitor: duplicate journey name "${dup}"`);
  return all;
}

/**
 * A multi-locale site (the root config of @saasreport/core defineConfig with site.locales): every builtin journey runs again
 * for each other locale, named "<journey>@<locale>", with that locale's config and every site path under its prefix
 * ("/glossary/" → "/ar/glossary/", "/" → "/ar/"). Custom journeys run once, as written.
 */
function localeJourneys(config, names) {
  const map = config.__locales, list = config.site?.locales;
  if (!map || !Array.isArray(list) || list.length < 2) return [];
  return list.filter((l) => l !== config.site.defaultLocale && map[l]).flatMap((l) => {
    const c = map[l], base = c.site.base || `/${l.toLowerCase()}`;
    const pre = (p) => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && p !== base && !p.startsWith(`${base}/`) ? `${base}${p}` : p);
    return names.filter((n) => BUILTINS[n].perLocale !== false && BUILTINS[n].when(c)).map((n) => ({
      name: `${n}@${l}`, builtin: true, locale: l,
      run: (ctx) => BUILTINS[n].run({ ...ctx, config: c, today: localParts(c, ctx.now).iso,
        get: (p, init) => ctx.get(pre(p), init), page: (p) => ctx.page(pre(p)), json: (p) => ctx.json(pre(p)) }),
    }));
  });
}

/** Just the names (handy for docs, CLI and tests). */
export const journeyList = (config) => journeys(config).map((j) => j.name);

/** The context object passed to every journey. */
export function journeyContext(config, { page, get, site, now = new Date(), trigger = "manual", env = {} }) {
  const { m, sel, paths } = monitorSettings(config);
  const json = async (path) => { const r = await get(path); expect(r.ok, `${path} → ${r.status}`); return r.json(); };
  return { site, config, m, sel, paths, page, get, json, expect, now, trigger, env, today: localParts(config, now).iso, ignore: m.ignoreConsole || [] };
}
