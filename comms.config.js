// The comms config (kit.comms-config.v1, docs/FORMS.md): the one place the project's email identity is declared. Every sentence is in
// content/copy.json, every company fact in the core registry; nothing here is typed twice.
import { colorsFromTokens } from "@saasreport/comms";
import { resolveTokens, colorRoles } from "@saasreport/site";
import tokens from "./tokens.json" with { type: "json" };
import copy from "./content/copy.json" with { type: "json" };
import company from "./vendor/core/registry/company.json" with { type: "json" };
import naming from "./vendor/core/registry/naming.json" with { type: "json" };

const SITE = `https://${naming.domain}`;
const owner = company.contacts.support_email;
const { _note, ...t } = tokens;
const A = copy.form.autoreply;

export default {
  project: naming.project,
  idPrefix: naming.project,
  site: SITE,
  locales: ["en"],
  timeZone: "UTC",
  brand: {
    name: { en: company.company.trading_name },
    domain: naming.domain,
    logo: null,
    colors: colorsFromTokens({ color: colorRoles(resolveTokens({ color: t.color }).color) }),
    fonts: { en: { stack: "'Liberation Sans',Arial,sans-serif", faces: [{ family: "Liberation Sans", weight: 400, src: `${SITE}/fonts/LiberationSans-Regular.ttf` }, { family: "Liberation Sans", weight: 700, src: `${SITE}/fonts/LiberationSans-Bold.ttf` }] } },
  },
  sender: { address: company.senders.system, name: { en: company.company.trading_name }, replyTo: company.senders.reply_to },
  signature: { en: { tagline: copy.meta.title } },
  legal: { entity: { name: company.company.legal_name ?? "TODO: registered legal entity name", registration: company.company.registration_number ?? "TODO: company registration number", address: "TODO: registered office address" } },
  links: { contact: `${SITE}/#start`, privacy: `${SITE}/#privacy`, unsubscribe: `${SITE}/#start` },
  manifest: { adopted: copy.meta.asOf },
  workers: { engine: { d1: { binding: "DB", database_name: `${naming.project}-comms-engine-production`, database_id: "TODO: wrangler d1 create (pending: the owner)", migrations_dir: "migrations" } } },
  ops: [{ key: "lead-alert", blockKey: "ops-lead" }],
  forms: { owner: { template: "lead-alert", secret: "OPS_NOTIFY_TO", address: owner } },
  preview: { en: { use_case: copy.form.ownerLabel } },
  templates: [{ key: "early-access", copy: { en: { subject: A.subject, preheader: A.preheader, title: A.title, intro: A.intro, steps: A.steps, cta: { label: copy.meta.title, href: SITE } } } }],
};
