/**
 * The page: <head> (meta, social cards, hreflang alternates, stylesheets, JSON-LD), the icon sprite, nav + drawer
 * (with a language switcher when the project has several locales), the landing sections, the footer, the modals
 * (forms and documents), the success template and the scripts. No inline scripts or handlers (CSP script-src 'self');
 * the only inline script is the JSON-LD data block.
 */
import { attr, attrs, button, ico, link, pad, rows } from "./html.js";
import { SECTIONS, consent } from "./sections/index.js";
import { ICONS } from "./icons.js";
import { fontType } from "./tokens.js";
import { shellMarkup } from "./shell-markup.js";
import { preferredSourceCard } from "./preferred.js";
import { menuFor } from "./pages.js";

const lines = (x) => x.join("\n");

/** Strip tags and collapse whitespace (FAQ answers for JSON-LD). */
export const plain = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Organization + WebSite + FAQPage graph (the FAQ read from the page's faq section). */
export function seoGraph(page) {
  const { site, content, L, url } = page;
  const seo = content.seo || {};
  const root = site.url.replace(/\/$/, "");
  const org = seo.org || {};
  const graph = [];
  graph.push({
    "@type": "Organization", "@id": `${root}/#org`, name: org.name ?? site.name,
    ...(org.alternateName ? { alternateName: org.alternateName } : {}),
    url: root,
    ...(org.logo ? { logo: { "@type": "ImageObject", url: root + org.logo.src, width: org.logo.width, height: org.logo.height } } : {}),
    ...(org.description ? { description: org.description } : {}),
    ...(org.knowsAbout ? { knowsAbout: org.knowsAbout } : {}),
    ...(org.sameAs?.length ? { sameAs: org.sameAs } : {}),
  });
  graph.push({ "@type": "WebSite", "@id": `${url}#website`, url, name: seo.website?.name ?? site.name, inLanguage: L.intl, publisher: { "@id": `${root}/#org` } });
  const faq = content.sections.find((s) => s.type === "faq");
  if (faq && seo.faq !== false) {
    graph.push({ "@type": "FAQPage", "@id": `${url}#faq`, inLanguage: L.intl,
      mainEntity: faq.items.map((x) => ({ "@type": "Question", name: plain(x.q), acceptedAnswer: { "@type": "Answer", text: plain(x.a) } })) });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

function head(page) {
  const { site, content, L, tokens, url, alternates, asset } = page;
  const m = content.meta;
  const og = tokens.images.og;
  const ogImage = /^https?:/.test(og.src) ? og.src : site.url.replace(/\/$/, "") + og.src;
  const ogTitle = m.ogTitle ?? m.title;
  const ogDescription = m.ogDescription ?? m.description;
  const out = [
    `<!doctype html>`,
    `<html lang="${L.lang}" dir="${L.dir}">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`,
    `<title>${m.title}</title>`,
    `<meta name="description" content="${attr(m.description)}">`,
    `<meta name="theme-color" content="${tokens.color.accent}">`,
    `<link rel="canonical" href="${attr(url)}">`,
    ...alternates.map((a) => `<link rel="alternate" hreflang="${attr(a.hreflang)}" href="${attr(a.url)}">`),
    `<meta name="robots" content="${attr(m.robots ?? "index, follow, max-image-preview:large, max-snippet:-1")}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="${L.og}">`,
    ...alternates.filter((a) => a.og && a.og !== L.og).map((a) => `<meta property="og:locale:alternate" content="${a.og}">`),
    `<meta property="og:site_name" content="${attr(site.name)}">`,
    `<meta property="og:title" content="${attr(ogTitle)}">`,
    `<meta property="og:description" content="${attr(ogDescription)}">`,
    `<meta property="og:url" content="${attr(url)}">`,
    `<meta property="og:image" content="${attr(ogImage)}">`,
    `<meta property="og:image:width" content="${og.width}">`,
    `<meta property="og:image:height" content="${og.height}">`,
    `<meta property="og:image:type" content="${og.type || "image/png"}">`,
    ...(m.ogImageAlt ? [`<meta property="og:image:alt" content="${attr(m.ogImageAlt)}">`] : []),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${attr(m.twitterTitle ?? ogTitle)}">`,
    `<meta name="twitter:description" content="${attr(m.twitterDescription ?? ogDescription)}">`,
    `<meta name="twitter:image" content="${attr(ogImage)}">`,
    ...tokens.icons.map((i) => `<link rel="${i.rel}" href="${attr(i.href)}"${i.sizes ? ` sizes="${i.sizes}"` : ""}${i.type ? ` type="${i.type}"` : ""}>`),
    ...(tokens.manifest ? [`<link rel="manifest" href="${attr(tokens.manifest)}">`] : []),
    ...(m.alternates || []).map((a) => `<link rel="alternate" type="${a.type}" title="${attr(a.title)}" href="${attr(a.href)}">`),
    ...(tokens.font.preload || []).map((src) => `<link rel="preload" href="${attr(src)}" as="font" type="${fontType(src)}" crossorigin>`),
    ...page.styles.map((href) => `<link rel="stylesheet" href="${attr(asset(href))}">`),
    `<script type="application/ld+json" data-seo-graph>${JSON.stringify(seoGraph(page)).replace(/</g, "\\u003c")}</script>`,
    `</head>`,
  ];
  return out;
}

function sprite(page) {
  const icons = { ...ICONS, ...(page.project.icons || {}) };
  return [
    ...comment(page.content.comments?.icons),
    `<svg width="0" height="0" style="position:absolute" aria-hidden="true">`,
    `  <defs>`,
    ...Object.entries(icons).map(([k, v]) => `    <symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`),
    `  </defs>`,
    `</svg>`,
  ];
}

const comment = (c) => (c ? [`<!-- ============ ${c} ============ -->`] : []);

function nav(page) {
  const { content, L, t, tokens, site, switcher } = page;
  const n = content.nav;
  const logo = tokens.logo.nav;
  const sh = shellMarkup({
    menu: menuFor(page.project || {}, L.code), t, home: "#top", script: page.asset ? page.asset("/shell.js") : "/shell.js?v=0",
    cta: n.cta.map((a) => button(a, { size: "sm" })).join(""),
    links: [...(n.drawer?.links || []).flat().filter((l) => l.href), ...switcher.map((x) => ({ href: x.path, label: x.name }))],
  });
  return [
    ...comment(content.comments?.nav),
    `<header class="nav" id="nav">`,
    `  <div class="wrap nav__in">`,
    `    <a class="brand" href="#top" aria-label="${attr(`${site.name} — ${t("home")}`)}"><img class="brand__logo" src="${attr(logo.src)}" alt="${attr(site.name)}" width="${logo.width}" height="${logo.height}"></a>`,
    `    <nav class="nav__links" aria-label="${attr(t("navMain"))}">`,
    ...n.links.flatMap((l, i) => (l.menu ? megaItem(l, i) : [`      ${link(l)}`])),
    `    </nav>`,
    `    <div class="nav__cta">`,
    ...switcher.map((s) => `      <a class="btn btn--ghost btn--sm" href="${attr(s.path)}" hreflang="${attr(s.hreflang)}" lang="${attr(s.lang)}" aria-label="${attr(`${t("language")}: ${s.name}`)}">${s.name}</a>`),
    ...n.cta.map((a) => `      ${button(a, { size: "sm" })}`),
    `      <span class="kshell__btns">${sh.buttons}</span>`,
    `    </div>`,
    `  </div>`,
    `  <div class="nav__progress" aria-hidden="true"><span></span></div>`,
    `</header>`,
    ``,
    // the site shell (src/shell.js), the same as on every inner page: the drawer carries the landing's drawer links
    // first, then the project's whole menu; the global search sits next to it
    sh.panels,
  ];
}

/**
 * A top-level nav item with a mega menu: { label, href?, menu: { id?, label?, columns: [{ title, links: [{ label, href |
 * modal, text? }] }], aside?: { title, text, action? } } }. The disclosure pattern: a button (aria-expanded,
 * aria-controls) and a panel of grouped links. The theme opens the panel on hover (pointer devices), when the button says
 * aria-expanded="true" (the page script toggles it on click, Enter and Space and closes it on Escape or an outside
 * click), and without scripts while focus is inside the item (html:not(.js)). On phones the drawer carries the links.
 */
function megaItem(l, i) {
  const m = l.menu, id = `mega-${m.id || i}`;
  const item = (x) => {
    const inner = `<b>${x.label}</b>${x.text ? `<small>${x.text}</small>` : ""}`;
    return x.href ? `<a class="mega__link" href="${attr(x.href)}"${x.modal ? ` data-modal="${attr(x.modal)}"` : ""}>${inner}</a>`
      : `<button type="button" class="mega__link" data-modal="${attr(x.modal)}">${inner}</button>`;
  };
  return [
    `      <div class="nav__item" data-mega>`,
    `        <button type="button" class="nav__toggle" aria-expanded="false" aria-controls="${id}" data-mega-toggle>${l.label}${ico("chevron", "ico--sm")}</button>`,
    `        <div class="mega" id="${id}"${m.label ? ` role="region" aria-label="${attr(m.label)}"` : ""}>`,
    `          <div class="mega__in${m.aside ? " mega__in--aside" : ""}">`,
    ...m.columns.map((c) => `            <div class="mega__col">${c.title ? `<p class="mega__title">${c.title}</p>` : ""}<ul>${c.links.map((x) => `<li>${item(x)}</li>`).join("")}</ul></div>`),
    ...(m.aside ? [`            <div class="mega__aside"><p class="mega__title">${m.aside.title}</p>${m.aside.text ? `<p>${m.aside.text}</p>` : ""}${m.aside.action ? button(m.aside.action, { size: "sm" }) : ""}</div>`] : []),
    `          </div>`,
    `        </div>`,
    `      </div>`,
  ];
}

/** Latin digits in a string → the locale's own (Persian digits on a Persian site). */
const digitsOf = (L) => (v) => String(v).replace(/[0-9]+/g, (d) => L.toDigits(d));

function footer(page) {
  const { content, t, tokens } = page;
  const f = content.footer;
  const logo = tokens.logo.footer;
  return [
    ...comment(content.comments?.footer),
    `<footer class="footer" id="contact">`,
    `  <div class="wrap footer__in">`,
    `    <div class="footer__brand">`,
    `      <a class="brand" href="#top"><img class="brand__logo brand__logo--footer" src="${attr(logo.src)}" alt="${attr(f.logoAlt)}" width="${logo.width}" height="${logo.height}"></a>`,
    ...(f.contact ? [`      ${button(f.contact, { style: "ghost", size: "sm", icon: "mail", iconSize: "sm" })}`] : []),
    `    </div>`,
    `    <nav class="footer__cols" aria-label="${attr(t("footerNav"))}">`,
    ...f.columns.map((col) => `      <div><b>${col.title}</b>${col.links.map(link).join("")}</div>`),
    `    </nav>`,
    `  </div>`,
    `  <div class="wrap footer__legal">`,
    // "Add to Google preferred sources" (project.preferredSource, placement "footer"; src/preferred.js)
    ...[preferredSourceCard(page.project?.preferredSource, { placement: "footer", code: page.L.code, name: page.site.name, url: page.project?.url, digits: digitsOf(page.L) })].filter(Boolean).map((c) => `    ${c}`),
    ...f.legal.map((p) => `    <p>${p}</p>`),
    `  </div>`,
    `</footer>`,
  ];
}

/** Input presets for the common form fields (autocomplete, direction, length). */
const PRESETS = {
  name: { autocomplete: "name", maxlength: 120 },
  email: { type: "email", autocomplete: "email", dir: "ltr", maxlength: 200 },
  company: { autocomplete: "organization", maxlength: 160 },
  role: { autocomplete: "organization-title", maxlength: 200 },
};

function field(f, page) {
  const { t } = page;
  if (f.control === "hidden") return `<input type="hidden" name="${attr(f.name)}">`;
  const o = { ...(PRESETS[f.name] || {}), ...f };
  const label = o.label ?? t(`fields.${o.labelKey || o.name}`);
  const req = o.required ? " required" : "";
  let control;
  switch (o.control || "input") {
    case "select": {
      const opts = [...(o.placeholder ? [`<option value="">${t("choose")}</option>`] : []), ...(o.options || []).map((x) => `<option>${x}</option>`)].join("");
      control = `<select name="${attr(o.name)}"${req}${o.source ? ` data-options="${attr(o.source)}"` : ""}>${opts}</select>`;
      break;
    }
    case "radios": control = `<div class="radios" data-options="${attr(o.source)}" data-name="${attr(o.name)}"></div>`; break;
    case "checks": control = `<div class="checks" data-caps></div><input type="hidden" name="${attr(o.name)}">`; break;
    case "chips": {
      // a multi-select chip group: a fieldset with its legend and one native checkbox per option (keyboard, screen
      // readers and the checked state for free); every chip is the same size and the group wraps evenly. The form
      // posts the checked values as a list (field.multiple in the project's lead forms).
      const opts = (o.options || []).map((x) => `<label class="fchips__o"><input type="checkbox" name="${attr(o.name)}" value="${attr(x)}"><span>${x}</span></label>`).join("");
      return `<fieldset class="f fchips${o.full ? " f--full" : ""}" data-chips="${attr(o.name)}"${o.required ? ` data-required="${attr(t("chooseOne"))}" aria-required="true"` : ""}><legend>${label}${o.required ? t("required") : ""}</legend><div class="fchips__opts">${opts}</div></fieldset>`;
    }
    case "textarea": control = `<textarea name="${attr(o.name)}" rows="${o.rows || 3}"${req}${o.maxlength ? ` maxlength="${o.maxlength}"` : ""}${o.placeholder ? ` placeholder="${attr(o.placeholder)}"` : ""}></textarea>`; break;
    default: control = `<input name="${attr(o.name)}"${o.type ? ` type="${o.type}"` : ""}${req}${o.autocomplete ? ` autocomplete="${o.autocomplete}"` : ""}${o.dir ? ` dir="${o.dir}"` : ""}${o.maxlength ? ` maxlength="${o.maxlength}"` : ""}>`;
  }
  return `<label class="f${o.full ? " f--full" : ""}"><span>${label}${o.required ? t("required") : ""}</span>${control}</label>`;
}

function modal(m, page) {
  const { t } = page;
  const close = `<button type="button" class="modal__x" data-close aria-label="${attr(t("close"))}">${ico("x")}</button>`;
  const headHtml = `<div class="modal__head"><p class="eyebrow">${m.eyebrow}</p><h3 id="${attr(m.titleId)}">${m.title}</h3>${m.lead ? `<p>${m.lead}</p>` : ""}</div>`;
  const out = [...(m.comment ? [`<!-- ${m.comment} -->`] : []), `<dialog class="modal${m.wide ? " modal--wide" : ""}" id="m-${attr(m.id)}" aria-labelledby="${attr(m.titleId)}">`];
  if (m.doc) {
    out.push(
      `  <div class="modal__card modal__card--doc">`,
      `    ${close}`,
      `    ${headHtml}`,
      `    <div class="doc">`,
      ...m.doc.map((b) => `      ${b.actions ? `<div class="actions">${b.actions.map((a) => button(a)).join("")}</div>` : `${b.h ? `<h4>${b.h}</h4>` : ""}<p>${b.p}</p>`}`),
      `    </div>`,
      `  </div>`,
    );
  } else {
    out.push(
      `  <form class="modal__card" data-form="${attr(m.form)}" novalidate>`,
      `    ${close}`,
      `    ${headHtml}`,
      ...(m.picker ? [`    <div class="pick" data-pick role="radiogroup" aria-label="${attr(m.picker.label)}"></div>`, `    <div class="pick__preview" data-pick-preview aria-live="polite"></div>`] : []),
      `    <div class="fgrid${m.inline ? " fgrid--inline" : ""}">`,
      ...m.fields.map((f) => `      ${field(f, page)}`),
      `    </div>`,
      `    <div class="modal__foot">`,
      `      <label class="consent"><input type="checkbox" name="consent" required><span>${consent(page, m.consent === "terms")}</span></label>`,
      m.secondary
        ? `      <div class="actions actions--split"><button class="btn btn--primary" type="submit"><span>${m.submit}</span></button><button type="button" class="btn btn--${m.secondary.style || "ghost"}"${attrs(m.secondary.attrs)}>${m.secondary.label}</button></div>`
        : `      <button class="btn btn--primary btn--block" type="submit"><span>${m.submit}</span></button>`,
      ...(m.fine ? [`      <p class="fine">${m.fine}</p>`] : []),
      `    </div>`,
      `  </form>`,
    );
  }
  out.push(`</dialog>`);
  return out;
}

function tail(page) {
  const { content, t, asset } = page;
  const c = content.comments || {};
  return [
    ...(content.modals?.length ? [...(c.modals ? [`<!-- ======================= ${c.modals} ======================= -->`, ``] : []), content.modals.map((m) => lines(modal(m, page))).join("\n\n"), ``] : []),
    ...(c.success ? [`<!-- ${c.success} -->`] : []),
    `<template id="tpl-success">`,
    `  <div class="success">`,
    `    <svg class="success__check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="m15 27 7 7 15-15"/></svg>`,
    `    <h3 data-s-title>${t("successTitle")}</h3>`,
    `    <p class="success__ref">${t("successRef")} <b dir="ltr" data-s-ref></b></p>`,
    `    <p data-s-msg></p>`,
    `    <button type="button" class="btn btn--primary" data-close>${t("gotIt")}</button>`,
    `  </div>`,
    `</template>`,
    ``,
    `<div class="toast" role="status" aria-live="polite" hidden></div>`,
    ``,
    ...page.scripts.map((s) => (s.module ? `<script type="module" src="${attr(asset(s.src))}"></script>` : `<script src="${attr(asset(s.src))}"${s.defer === false ? "" : " defer"}></script>`)),
    `</body>`,
    `</html>`,
    ``,
  ];
}

/** Render one landing page (one locale). `page`: { project, site, content, L, t, d, tokens, url, alternates, switcher, styles, scripts, asset }. */
export function renderPage(page) {
  const ctx = { ...page, c: page };
  const sections = page.content.sections.map((s) => {
    const fn = SECTIONS[s.type];
    if (!fn) throw new Error(`unknown section type "${s.type}" (known: ${Object.keys(SECTIONS).join(", ")})`);
    return lines(fn(s, ctx));
  });
  return lines([
    ...head(page),
    `<body>`,
    `<a class="skip" href="#main">${page.t("skip")}</a>`,
    ``,
    ...sprite(page),
    ``,
    ...nav(page),
    ``,
    `<main id="main">`,
    ``,
    sections.join("\n\n"),
    `</main>`,
    ``,
    ...footer(page),
    ``,
    ...tail(page),
  ]);
}

export { pad };
