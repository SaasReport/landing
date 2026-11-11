/**
 * Static HTML of generated widgets: everything readable without scripts (and in the page's Markdown twin);
 * assets/widgets.js then adds the behaviour (replay, step, run, send, tabs, filters). Semantic lists, tables, forms
 * and headings; logical CSS properties (theme/widgets.css) so one markup serves RTL and LTR.
 *
 *   renderWidget(widget, { locale, labels, chrome, level }) → html
 *   renderWidgetsBody(generated, code, { chrome, level }) → html of a whole page body (intro, audience filter,
 *                                                           use cases → scenarios → widgets)
 */
import { chromeFor, fillIn } from "./chrome.js";
import { esc, p, HTML_KIT } from "./html-kit.js";
import { kitRegistry } from "./registry.js";
import { localizeHtml, formatNumber, digits, digitSetOf, DIGIT_SETS, SEPARATORS } from "@saasreport/format";
import { scanHtml } from "@saasreport/format/scan";
import { formatInstant } from "@saasreport/calendar/instant";

/** Text and reader attributes in the locale's digits (Persian ۰-۹ for fa, Arabic-Indic for ar); code, URLs, Latin
 *  identifiers and other attributes keep Latin digits. The kit's one implementation: @saasreport/format localizeHtml. */
const SET = { arabext: "fa", arab: "ar", latn: "en" };
export function localDigits(html, digits) {
  if (!digits || digits === "latn") return html;
  return localizeHtml(html, SET[digits] || digits);
}

/** Latin (or Arabic-Indic) digits a reader would still see in rendered HTML: @saasreport/format/scan, the rule of
 *  `kit check digits`. Returns the offending text runs. */
export function latinDigits(html) {
  return scanHtml(html).filter((f) => f.kind !== "bidi-dot").map((f) => f.context);
}

export { esc };

function fmt(locale) {
  const nu = locale.digits || "latn", loc = SET[nu] || "en";
  const intl = `${locale.intl || locale.code}`;
  const tag = intl.includes("-u-") ? `${intl}-nu-latn` : `${intl}-u-nu-latn`;
  // Dates in the locale's own calendar; Solar Hijri by @saasreport/calendar's arithmetic, never ICU's Persian calendar.
  const date = { format: (d) => formatInstant(d, { locale: tag, calendar: locale.calendar, timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }) };
  const num = (n, d, fixed) => formatNumber(n, loc, d == null ? { maxDecimals: 3 } : fixed ? { decimals: d } : { maxDecimals: d });
  return { date: (iso) => digits(date.format(new Date(`${iso}T00:00:00Z`)), loc), num, digits: (s) => digits(s, loc), tag,
    numerals: DIGIT_SETS[digitSetOf(loc)], sep: SEPARATORS[loc] || SEPARATORS.en };
}

/**
 * One widget's static HTML. `embed: true` is for a page that shows the visual as part of its own story: no "how this is built" block, no
 * learn/try lead, and the archetype goes in `data-kw-archetype` (the runtime reads either), so nothing the visitor can read or inspect says what it is made with.
 */
export function renderWidget(w, { locale, labels, chrome, level = 4, scenarioTitle, registry = kitRegistry(), embed = false }) {
  const c = chrome || chromeFor(locale.code, {}, registry);
  const f = fmt(locale);
  const hid = `w-${w.id}-${w.locale}`;
  const plugin = registry.get(w.archetype);
  return localDigits(`<section class="kw kw--${w.archetype}" id="${esc(hid)}" ${embed ? "data-kw-archetype" : "data-widget"}="${w.archetype}" aria-labelledby="${esc(hid)}-t" data-reset-label="${esc(c.reset)}"${plugin.runtime == null ? ' data-kw-runtime="static"' : ""}>
<header class="kw__head"><h${level} id="${esc(hid)}-t">${esc(w.title === scenarioTitle ? c.a[w.archetype] : w.title)}</h${level}><span class="kw-badge" data-honesty="${w.honesty}">${esc(labels?.[w.honesty] || w.honesty)}</span></header>
${w.utility && !embed ? `<p class="kw__lead"><b>${esc(c.learns)}:</b> ${esc(w.utility.learns)} <b>${esc(c.tryIt)}:</b> ${esc(w.utility.does)}</p>` : ""}
${plugin.render(w, c, f, locale, HTML_KIT)}
${w.architecture && !embed ? `<details class="kw-about"><summary>${esc(c.about)}</summary><dl>
<dt>${esc(c.application)}</dt><dd>${w.application.href ? `<a href="${esc(w.application.href)}">${esc(w.application.surface)}</a>` : esc(w.application.surface)}</dd>
<dt>${esc(c.components)}</dt><dd><ul>${w.architecture.components.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></dd>
<dt>${esc(c.flow)}</dt><dd>${esc(w.architecture.flow)} <a href="${esc(w.architecture.url)}" rel="noopener">${esc(c.diagram)}</a></dd>
<dt>${esc(c.usedOn)}</dt><dd><ul>${w.usage.surfaces.map((u) => `<li><a href="${esc(u.path)}">${esc(u.path)}</a>: ${esc(u.how)}</li>`).join("")}</ul></dd>
</dl></details>` : ""}
</section>`, locale.digits);
}

/** A whole page body: title, intro, the audience filter, then use cases → scenarios → their widgets. */
export function renderWidgetsBody(generated, code, { chrome: overrides, title, intro, registry = kitRegistry() } = {}) {
  const locale = generated.locales.find((l) => l.code === code) || generated.locales[0];
  const c = chromeFor(locale.code, overrides, registry);
  const page = generated.page?.[locale.code] || { useCases: [], audiences: [] };
  const labels = generated.labels?.[locale.code];
  // the widgets page shows the widgets placed on it; a widget placed only in a section of another page stays there
  const mine = generated.widgets.filter((w) => w.locale === locale.code && (!w.usage || w.usage.surfaces.some((u) => u.placement === "page")));
  const scenarios = [...new Set(mine.map((w) => w.scenario))];
  const scInfo = Object.fromEntries((page.scenarios || []).map((s) => [s.id, s]));
  const audLabel = Object.fromEntries((page.audiences || []).map((a) => [a.id, a.label]));
  const useCases = (page.useCases?.length ? page.useCases : [...new Set(mine.map((w) => w.useCase))].map((id) => ({ id, label: id })));
  const block = (uc) => {
    const scs = scenarios.filter((s) => mine.find((w) => w.scenario === s).useCase === uc.id);
    if (!scs.length) return "";
    return `<section class="kw-uc" id="uc-${esc(uc.id)}" aria-labelledby="uc-${esc(uc.id)}-t"><h2 id="uc-${esc(uc.id)}-t">${esc(uc.label)}</h2>${p("kw-uc__sum", uc.summary)}
${scs.map((sid) => {
    const ws = mine.filter((w) => w.scenario === sid);
    const first = ws[0];
    return `<article class="kw-sc" id="sc-${esc(sid)}" data-audiences="${esc(first.audiences.join(" "))}" aria-labelledby="sc-${esc(sid)}-t">
<h3 id="sc-${esc(sid)}-t">${esc(scInfo[sid]?.title || first.title)}</h3>${p("kw-sc__sum", scInfo[sid]?.summary ?? first.summary)}
<p class="kw-sc__for">${esc(c.for)}: ${first.audiences.map((a) => `<span class="kw-chip">${esc(audLabel[a] || a)}</span>`).join(" ")}</p>
<div class="kw-grid">${ws.map((w) => renderWidget(w, { locale, labels, chrome: c, level: 4, registry, scenarioTitle: scInfo[sid]?.title || first.title })).join("\n")}</div></article>`;
  }).join("\n")}</section>`;
  };
  const filter = (page.audiences || []).length > 1 ? `<div class="kw-filter" role="group" aria-label="${esc(c.audiences)}"><button type="button" class="kw-chip" aria-pressed="true" data-kw-aud="">${esc(c.all)}</button>${page.audiences.map((a) => `<button type="button" class="kw-chip" aria-pressed="false" data-kw-aud="${esc(a.id)}">${esc(a.label)}</button>`).join("")}</div><p class="kw-empty" data-kw-empty hidden>${esc(c.empty)}</p>` : "";
  return localDigits(`<div class="kw-page" dir="${locale.dir}" lang="${esc(locale.code)}">
<header class="kw-page__head"><h1>${esc(title || page.title || "")}</h1>${p("kw-page__intro", intro || page.intro)}${filter}</header>
${useCases.map(block).join("\n")}
</div>`, locale.digits);
}
