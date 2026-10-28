/**
 * Sample comms config: SaasReport (saasreport.ai), English only (LTR). The copy is sample
 * text to adapt, not product claims; values starting with TODO must be provided by the project
 * (todos(config) lists them). Colours come from site tokens (colorsFromTokens).
 */
import { colorsFromTokens } from "../../src/index.js";
import { resolveTokens, colorRoles } from "@saasreport/site";

const SITE = "https://saasreport.ai";

// TODO: replace with the project's @saasreport/site tokens (site.config.js tokens.color) once the brand is set.
const tokens = { color: { accent: "#1F3A93", accentTint: "#E8ECF8", ink: "#0B0B0B", muted: "#5B5B66", rail: "#B8B8B8", line: "#E4E4EA", bg: "#F8F8FA", surface: "#FFFFFF" } };

export default {
  project: "saasreport",
  idPrefix: "saasreport",
  site: SITE,
  locales: ["en"],
  timeZone: "UTC",
  brand: {
    name: { en: "SaasReport" },
    domain: "saasreport.ai",
    logo: null, // TODO: a PNG lockup (e.g. `${SITE}/brand/logo-email.png`, 198x44); until then the name is the wordmark
    colors: colorsFromTokens({ color: colorRoles(resolveTokens(tokens).color) }),   // the roles @saasreport/site derives (accentText, onAccent, pillBorder), handed in: one derivation
    fonts: {
      en: {
        stack: "'Vazirmatn','Segoe UI',Arial,sans-serif",
        // The font files must be served from the site (mail clients cannot load them otherwise).
        faces: [
          { family: "Vazirmatn", weight: 400, src: `${SITE}/fonts/Vazirmatn-Regular.ttf` },
          { family: "Vazirmatn", weight: 700, src: `${SITE}/fonts/Vazirmatn-Bold.ttf` },
          { family: "Vazirmatn", weight: 800, src: `${SITE}/fonts/Vazirmatn-ExtraBold.ttf` },
        ],
      },
    },
  },
  sender: { address: "noreply@saasreport.ai", name: { en: "SaasReport" }, replyTo: null },
  signature: { en: { tagline: "AI-narrated reports from your Stripe data" } },
  legal: {
    entity: {
      name: "TODO: registered legal entity name",
      registration: "TODO: company registration number and registry",
      address: "TODO: registered office address",
    },
  },
  links: { contact: `${SITE}/#contact`, privacy: `${SITE}/privacy`, unsubscribe: `${SITE}/unsubscribe` },
  manifest: { adopted: "2026-09-30" },
  workers: {
    engine: { d1: { binding: "DB", database_name: "saasreport-web", database_id: "TODO: wrangler d1 create saasreport-web", migrations_dir: "../../migrations" } },
  },
  ops: [{ key: "lead-alert", blockKey: "ops-lead" }],
  // Every form (each template below) is delivered twice: the receipt and the owner's copy to the project's own info@; the address
  // is also the comms-engine secret OPS_NOTIFY_TO, checked against it at deploy and at send (kit.forms-config.v1, docs/FORMS.md).
  forms: { owner: { template: "lead-alert", secret: "OPS_NOTIFY_TO", address: "info@saasreport.ai" } },
  preview: { en: { use_case: "Monthly investor report", form_label: "Sandbox key request" } },
  templates: [
    {
      key: "sandbox-key",
      params: ["use_case"],
      copy: {
        en: {
          subject: "Your sandbox key request is in | ${reference}",
          preheader: "We issue sandbox keys after a short review.",
          title: "We have received your sandbox key request",
          intro: [
            "Thank you for requesting a sandbox key for ${use_case}. After a short review we will send your key with a quick-start guide for the API and agent tools.",
            "Sandbox keys reach simulators and sample data only; no real transaction can be made with them.",
          ],
          steps: ["We review your request and use case.", "We issue your sandbox key and quick-start guide.", "Your first agent runs a full flow against the simulators."],
          cta: { label: "Read the developer docs", href: `${SITE}/docs/` },
        },
      },
    },
    {
      key: "waitlist",
      copy: {
        en: {
          subject: "You are on the SaasReport waitlist | ${reference}",
          preheader: "Your place on the early-access list is saved.",
          title: "Your place on the waitlist is saved",
          intro: ["Thank you for your interest. You are on the early-access list, and we will email your invitation to this address as soon as your workspace is ready."],
          steps: ["Your place on the early-access list is recorded.", "We prepare your workspace and sample data.", "Your invitation arrives at this email address."],
        },
      },
    },
    {
      key: "contact",
      copy: {
        en: {
          subject: "We have received your message | ${reference}",
          preheader: "Your message is in and we will reply soon.",
          title: "We have received your message",
          intro: ["Thank you for contacting SaasReport. Your message is recorded and a member of our team will reply soon."],
          steps: ["Your message goes to the right team.", "We reply to this email address."],
          cta: { label: "Back to the website", href: SITE },
        },
      },
    },
    {
      key: "newsletter",
      unsubscribe: true,
      copy: {
        en: {
          subject: "You are subscribed to SaasReport updates | ${reference}",
          preheader: "Releases, guides and event invitations, a few times a month at most.",
          title: "You are subscribed",
          intro: ["Your address is on the SaasReport mailing list. We will write when we ship releases, publish guides or announce events."],
          steps: ["Your address is on the mailing list.", "New releases and events reach you first.", "You can unsubscribe at any time with the link below."],
        },
      },
    },
  ],
};
