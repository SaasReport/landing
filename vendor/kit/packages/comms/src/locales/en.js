/**
 * English (en): LTR, Latin digits, the Gregorian year in the copyright line.
 * `${param}` placeholders are filled by the comms engine at send time; everything else comes from the
 * project's comms config (x: brand, holder, sender, site, contact, privacy, address, registration, …).
 */
import { templates } from "./templates.js";

/** The footer, signature and unsubscribe wording (placeholders in {braces}), assembled by templates.js. */
export const copy = {
  team: "The {brand} team",
  auto: {
    sent: "This message was sent automatically from {sender}.",
    reply: "Replies reach {replyTo}.",
    noReply: "Please do not reply to it.",
    contact: "To contact us, use the contact form on the {link}.",
    contactLink: "{brand} website",
  },
  notice: {
    text: "This message and any attachments are confidential and intended only for the named recipient. If you have received it in error, please delete it and let us know; any use, disclosure or copying of it without permission is prohibited. The information you submitted is used only to respond to this request and is not shared with third parties. Nothing in this message is financial, legal or investment advice.",
    privacyLead: " Read our ", privacyLabel: "privacy notice", privacyTail: ".", privacyText: "Privacy notice: {privacy}",
  },
  address: { sep: ", ", registration: true },
  copyright: {
    html: "© ${year} {holder}. All rights reserved. {brand} and its logo are trademarks of {holder}.",
    text: "© ${year} {holder}. All rights reserved. {brand} and its logo are trademarks of {holder}.",
  },
  unsubscribe: {
    html: "You are receiving this because you subscribed at {siteLink}. {unsubLink} at any time.",
    label: "Unsubscribe",
    text: "You are receiving this because you subscribed at {domain}. Unsubscribe: {unsubscribe}",
  },
};
const tpl = templates(copy);

export default {
  lang: "en",
  dir: "ltr",
  digits: "0123456789",
  lineHeight: { p: "1.65", h1: "1.3", h2: "1.4", step: "1.6", legal: "1.6" },
  years: { year: { calendar: "gregory", numerals: "latn" } },
  greeting: { html: 'Dear <strong style="font-weight:700">${name}</strong>,', text: "Dear ${name}," },
  reference: "Reference",
  submitted: "Submitted",
  nextSteps: "What happens next",
  summary: "What you submitted",
  closing: "Kind regards,",
  team: tpl.team,
  ops: { title: "New request: ${form_label}", subject: "New request: ${form_label} | ${reference}" },
  sample: { name: "Sara Ahmed", submittedAt: "30 September 2026, 10:30", fieldName: "Name", fieldEmail: "Email", fieldCompany: "Organisation", fieldMessage: "Message", company: "Example Ltd", message: "This is a sample message for the preview." },
  legal: tpl.legal,
  unsubscribe: tpl.unsubscribe,
};
