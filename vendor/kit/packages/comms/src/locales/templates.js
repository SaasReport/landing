/**
 * The locale packs' parametrised copy, built from data: each locale file keeps its wording as `copy` (strings with {placeholders},
 * validated by kit.canon.json as a copy-pack) and this module only assembles it, so no reader-facing text is written in logic.
 * `team(brand)`, `legal(x)` (the footer paragraphs: html and text) and `unsubscribe(x)` are the functions the comms engine calls.
 */
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
const span = (v) => `<span style="direction:ltr;unicode-bidi:embed">${v}</span>`;
const link = (href, colour, label) => `<a href="${href}" style="color:${colour}">${label}</a>`;

export function templates(c) {
  return {
    team: (brand) => fill(c.team, { brand }),
    legal: (x) => {
      const reply = (html) => (x.replyTo ? fill(c.auto.reply, { replyTo: html ? span(x.replyTo) : x.replyTo }) : c.auto.noReply);
      const sent = (html) => fill(c.auto.sent, { sender: html ? span(x.sender) : x.sender });
      const contact = fill(c.auto.contact, { link: link(x.contact, x.link, fill(c.auto.contactLink, { brand: x.brand })) });
      const notice = {
        html: c.notice.text + (x.privacy ? c.notice.privacyLead + link(x.privacy, x.link, c.notice.privacyLabel) + c.notice.privacyTail : ""),
        text: c.notice.text + (x.privacy ? `\n${fill(c.notice.privacyText, { privacy: x.privacy })}` : ""),
      };
      const hasAddress = c.address.registration ? x.address || x.registration : x.address;
      const address = c.address.registration ? [x.holder, x.registration, x.address].filter(Boolean).join(c.address.sep) : `${x.holder}${c.address.sep}${x.address}`;
      const years = c.copyright.years ? (x.hijri === false ? c.copyright.years.without : c.copyright.years.with) : "";
      const vars = { years, holder: x.holder, brand: x.brand };
      return [
        { html: [sent(true), reply(true), contact].join(" "), text: [sent(false), reply(false)].join(" ") },
        notice,
        ...(hasAddress ? [{ html: address, text: address }] : []),
        { html: fill(c.copyright.html, vars), text: fill(c.copyright.text, vars) },
      ];
    },
    unsubscribe: (x) => ({
      html: fill(c.unsubscribe.html, { siteLink: link(x.site, x.link, x.domain), unsubLink: link(x.unsubscribe, x.link, c.unsubscribe.label) }),
      text: fill(c.unsubscribe.text, { domain: x.domain, unsubscribe: x.unsubscribe }),
    }),
  };
}
