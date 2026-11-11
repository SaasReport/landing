/**
 * Calendar-driven reports: structured tables from @saasreport/calendar and the posts built from them.
 *   calendarTables(config, { from, to, ahead }) → business days per profile, day-by-day status, holidays, events
 *   weekReport(config, day, { topic, podcastUrl }) → { title, summary, body_md, tags, range }
 *   monthReport(config, monthKey, { theme, topics }) → { title, summary, body_md, tags }
 *   buildPost(plan, entry) → the blog post for a planner entry (topic / report / term)
 *   articleMd(config, item) → a topic's article with its `sources` line (links) appended
 * All texts come from the strings table (config.strings over the fa/en defaults).
 */
import * as C from "@saasreport/calendar";
import { toDay, iso, jsWeekday, ymd, monthKey, monthBounds, monthLabel, monthName, dayLabel, dayMonth, toCalWeekdays, weekdayName, zonedToUtc } from "./dates.js";
import { digits, fill, strings } from "./i18n.js";

/** Options for @saasreport/calendar functions from a config (and a profile key). */
export function calOptions(config, profile) {
  const weekend = profile && config.calendar.profiles[profile] ? config.calendar.profiles[profile].weekend : config.calendar.weekend;
  return { weekend: toCalWeekdays(weekend), holidays: config.calendar.holidays === "iran" };
}
const holidaysOn = (config, n) => (config.calendar.holidays === "iran" ? C.holidaysOn(n) : []);
const eventsOn = (config, n) => (config.calendar.holidays === "iran" ? C.eventsOn(n) : []);

/** Structured calendar data for [from, to] (day numbers or ISO dates). */
export function calendarTables(config, { from, to, ahead } = {}) {
  const a = toDay(from), b = toDay(to ?? from);
  const aheadDays = ahead ?? config.calendar.ahead ?? 30;
  const o = calOptions(config), T = config.calendar.settlement;
  const days = [];
  for (let n = a; n <= b; n++) {
    const st = C.dayStatus(n, o), hol = holidaysOn(config, n);
    const predicted = hol.length > 0 && hol.every((h) => h.status === "predicted");
    const s = T ? C.settlement(n, T, o) : null;
    days.push({
      day: n, iso: iso(n), label: dayLabel(config, n), short: dayMonth(config, n), weekday: jsWeekday(n),
      business: st.business, weekend: st.weekend, holiday: st.holiday, predicted, uncertain: st.uncertain,
      status: st.business ? "business" : st.holiday ? (predicted ? "predicted" : "holiday") : "weekend",
      holidays: hol.map((h) => ({ title: h.title, predicted: h.status === "predicted" })),
      events: eventsOn(config, n).map((e) => ({ title: e.title, kind: e.kind, holiday: e.holiday })),
      settlement: s ? { day: s.date, iso: iso(s.date), label: dayLabel(config, s.date), short: dayMonth(config, s.date), uncertain: s.uncertain } : null,
    });
  }
  const counts = Object.values(config.calendar.profiles).map((p) => {
    const po = calOptions(config, p.key);
    return { key: p.key, label: p.label, weekend: p.weekend, business: days.filter((d) => C.isBusinessDay(d.day, po)).length, total: days.length };
  });
  const list = (lo, hi) => { const r = []; for (let n = lo; n <= hi; n++) for (const h of holidaysOn(config, n)) r.push({ day: n, iso: iso(n), label: dayLabel(config, n), title: h.title, predicted: h.status === "predicted" }); return r; };
  const holidays = list(a, b), upcoming = list(a, a + aheadDays);
  const monthEnd = days.find((d) => ymd(config, d.day + 1).d === 1)?.day ?? null;
  const business = days.filter((d) => d.business);
  return {
    from: a, to: b, days, counts, holidays, ahead: upcoming, aheadDays,
    finance: days.flatMap((d) => d.events.filter((e) => e.kind === "finance").map((e) => ({ day: d.day, label: d.label, title: e.title }))),
    monthEnd, firstBusiness: business[0]?.day ?? null, lastBusiness: business.at(-1)?.day ?? null,
    uncertain: days.some((d) => d.uncertain) || upcoming.some((h) => h.predicted),
    predicted: holidays.some((h) => h.predicted), settlement: T,
  };
}

const S = (config) => strings(config);

/** A topic's article, followed by its sources as one line of links (strings `sourcesLabel`, `sourcesSep`). */
export function articleMd(config, item) {
  const a = String(item?.article || "").trim(), src = Array.isArray(item?.sources) ? item.sources : [];
  if (!src.length) return a;
  const str = S(config);
  return `${a}\n\n**${str.sourcesLabel}** ${src.map((x) => `[${x.title}](${x.url})`).join(str.sourcesSep)}`;
}
const profileLabel = (config, str, p) => p.label || str[`profile_${p.key}`] || p.key;
const weekendLabel = (config, str, js) => js.map((d) => weekdayName(config, d)).join(str.and);
const calendarRef = (config, str) => (config.features?.calendar !== false ? `[${str.calendarEngine}](${config.paths?.calendar || "/calendar/"})` : str.calendarEngine);
const statusText = (str, d) => ({ business: str.statusBusiness, holiday: str.statusHoliday, predicted: str.statusPredicted, weekend: str.statusWeekend })[d.status];

/** "۱۱ مهر تا ۱۷ مهر ۱۴۰۵" for a week starting on day n. */
export function weekRange(config, start, len = 7) {
  const str = S(config), end = start + len - 1;
  return fill(str.weekRange, { from: dayMonth(config, start), to: dayMonth(config, end), year: digits(config, ymd(config, end).y) });
}

/** Week summary lines: with calendar.weekMerge, profiles sharing a weekend are one line ("A and B"). */
function weekCounts(config, str, counts) {
  if (!config.calendar.weekMerge) return counts;
  const out = [];
  for (const c of counts) {
    const same = out.find((o) => o.weekend.join() === c.weekend.join());
    if (same) same.label = `${profileLabel(config, str, same)}${str.and}${profileLabel(config, str, c)}`;
    else out.push({ ...c });
  }
  return out;
}

/** Weekly post: the topic article (if any) followed by the week's business calendar. */
export function weekReport(config, day, { topic = null, podcastUrl = null, start = null } = {}) {
  const str = S(config), n = toDay(day);
  const first = start ?? n, last = first + 6;
  const tb = calendarTables(config, { from: first, to: last });
  const range = weekRange(config, first);
  const h = topic ? "###" : "##", T = tb.settlement, f = (k, v) => fill(str[k], v);
  const body = [
    ...(topic ? [articleMd(config, topic), ``, ...(podcastUrl ? [f("weekAudio", { url: podcastUrl }), ``] : []), `## ${f("weekTablesHeading", { range })}`, ``] : []),
    T ? f("weekAutoNote", { calendar: calendarRef(config, str), t: T }) : f("weekAutoNoteNoSettlement", { calendar: calendarRef(config, str) }),
    ``,
    `${h} ${str.weekSummaryHeading}`,
    ...weekCounts(config, str, tb.counts).map((c) => f("profileLine", { label: profileLabel(config, str, c), weekend: weekendLabel(config, str, c.weekend), n: digits(config, c.business) })),
    tb.monthEnd != null ? f("monthEndIn", { month: monthName(config, ymd(config, tb.monthEnd).y, ymd(config, tb.monthEnd).m), date: dayLabel(config, tb.monthEnd) }) : str.monthEndNot,
    ``,
    `${h} ${str.dayByDayHeading}`,
    `| ${[str.colDay, str.colStatus, ...(T ? [f("colSettlement", { t: T })] : []), str.colEvents].join(" | ")} |`,
    `| ${["---", "---", ...(T ? ["---"] : []), "---"].join(" | ")} |`,
    ...tb.days.map((d) => `| ${[d.label, statusText(str, d), ...(T ? [d.settlement.short] : []), d.events.map((e) => e.title).join(str.eventSep ?? str.listSep) || "—"].join(" | ")} |`),
    ...(config.calendar.holidays === "iran" ? [
      ``,
      `${h} ${f("aheadHeading", { n: digits(config, tb.aheadDays) })}`,
      ...(tb.ahead.length ? tb.ahead.map((x) => `- ${x.label}: ${x.title}${x.predicted ? str.predictedMark : ""}`) : [f("aheadNone", { n: digits(config, tb.aheadDays) })]),
      ``,
      tb.uncertain ? str.uncertainNote : str.certainNote,
    ] : []),
    ...(str.weekFooter ? [``, str.weekFooter] : []),
  ].join("\n");
  const primary = tb.counts[0];
  const calSummary = f("weekCalSummary", {
    counts: tb.counts.map((c) => f("weekCalSummaryCount", { n: digits(config, c.business), label: profileLabel(config, str, c) })).join(str.listSep),
    ahead: tb.ahead.length ? f("weekCalSummaryAhead", { n: digits(config, tb.ahead.length), days: digits(config, tb.aheadDays) }) : "",
  });
  return {
    title: topic ? topic.title : f("weekTitle", { range }), summary: topic ? topic.summary : calSummary, body_md: body, range,
    tags: topic ? [...(topic.tags || []), str.tagWeekly] : [str.tagWeekly, str.tagBusinessDay, ...(T ? [str.tagSettlement] : [])],
    tables: tb, business: primary?.business ?? null,
  };
}

/** Monthly report: the theme intro and the month's topics (if any) followed by the business month. */
export function monthReport(config, key, { theme = null, topics = [] } = {}) {
  const str = S(config), f = (k, v) => fill(str[k], v);
  const { first, last, length, y, m } = monthBounds(config, key);
  const tb = calendarTables(config, { from: first, to: last, ahead: 0 });
  const name = monthLabel(config, key), mName = monthName(config, y, m);
  const h = theme ? "###" : "##";
  const body = [
    ...(theme ? [theme.intro.trim(), ``,
      ...(topics.length ? [`## ${f("monthPlanHeading", { month: mName })}`, str.monthPlanIntro, ``, ...topics.map((w) => `- ${dayLabel(config, toDay(w.date))}: **${w.title}**`), ``] : []),
      `## ${str.monthTablesHeading}`, ``] : []),
    f("monthAutoNote", { name, calendar: calendarRef(config, str) }),
    ``,
    `${h} ${str.businessDaysHeading}`,
    `| ${str.colCalendar} | ${str.colWeekend} | ${str.colBusiness} |`,
    `| --- | --- | --- |`,
    ...tb.counts.map((c) => `| ${profileLabel(config, str, c)} | ${weekendLabel(config, str, c.weekend)} | ${f("countOf", { n: digits(config, c.business), total: digits(config, length) })} |`),
    ``,
    ...(tb.firstBusiness != null ? [f("firstBusiness", { date: dayLabel(config, tb.firstBusiness) }), f("lastBusiness", { date: dayLabel(config, tb.lastBusiness) }), ``] : []),
    ...(config.calendar.holidays === "iran" ? [
      `${h} ${str.holidaysHeading}`,
      ...(tb.holidays.length ? tb.holidays.map((x) => `- ${x.label}: ${x.title}${x.predicted ? str.predictedMark : ""}`) : [str.holidaysNone]),
      ...(tb.finance.length ? [``, `${h} ${str.financeHeading}`, ...tb.finance.map((e) => `- ${e.label}: ${e.title}`)] : []),
      ``,
      tb.predicted ? str.monthPredictedNote : str.monthCertainNote,
    ] : []),
  ].join("\n");
  const primary = tb.counts[0]?.business ?? 0;
  return {
    title: theme ? f("monthTitleWithTheme", { theme: theme.title, name }) : f("monthTitle", { name }),
    summary: f("monthSummary", { n: digits(config, primary), holidays: tb.holidays.length ? f("holidaysCount", { n: digits(config, tb.holidays.length) }) : str.noHolidays, name }),
    body_md: body, tags: [str.tagMonthly, str.tagBusinessDay, ...(config.calendar.holidays === "iran" ? [str.tagHolidays] : [])], tables: tb,
  };
}

/**
 * The blog post for a planner entry: { slug, series, kind, title, summary, body_md, tags, topic, published_at, source }.
 * `series.postKind` (a string, or a function of the entry) sets the stored post kind (default: the series kind).
 * Weekly topic series get the week's tables (series.tables = "week"); report series the month's (or week's).
 */
export function buildPost(plan, e) {
  const config = plan.config, s = config.series.find((x) => x.id === e.series);
  const base = { slug: e.slug, series: s.id, kind: (typeof s.postKind === "function" ? s.postKind(e) : s.postKind) || e.kind, published_at: e.publishAt, source: "auto", topic: e.item ? e.key : null };
  if (e.kind === "term") {
    const t = e.item;
    return { ...base, title: t.term, summary: t.short, body_md: t.definition, tags: [e.category?.name].filter(Boolean) };
  }
  const podcastUrl = s.podcast && config.features.podcasts ? `${config.site.base || ""}${config.paths.podcasts}${e.slug}` : null; // site.base: "/ar" on a locale of a multi-locale site
  if (e.kind === "topic") {
    if (s.tables === "week") return { ...base, ...weekReport(config, e.day, { topic: e.item, podcastUrl: e.item ? podcastUrl : null }) };
    if (s.tables === "month") return { ...base, ...monthReport(config, monthKey(config, e.day), { theme: e.item ? { title: e.item.title, intro: e.item.article } : null }) };
    if (!e.item) return null;
    return { ...base, title: e.item.title, summary: e.item.summary, body_md: articleMd(config, e.item), tags: e.item.tags || [] };
  }
  // report
  if (s.tables === "week" || s.every === "week") return { ...base, ...weekReport(config, e.day, { topic: e.item ? { ...e.item, article: e.item.intro, summary: e.item.intro } : null }) };
  const { first, last } = monthBounds(config, e.key);
  const topics = config.series.filter((x) => x.kind === "topic").flatMap((x) => (plan.content[x.id]?.items || [])
    .filter((w) => { const d = toDay(w.date); return d >= first && d <= last && plan.isSlot(x.id, d); }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { ...base, ...monthReport(config, e.key, { theme: e.item, topics }) };
}

/** Publish time helper: local `at` on day n in the site's time zone → ISO UTC. */
export const publishAt = (config, day, at = "06:00") => zonedToUtc(toDay(day), at, config.site.timezone);
