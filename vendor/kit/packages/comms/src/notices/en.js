/**
 * Legal notices, English (en): plain-language wording DRAFTS for the base notice, the audience blocks and the
 * jurisdiction blocks. They claim no licence, registration or regulatory status. Entity facts are placeholders
 * ({{legal_entity}}, {{registration}}, …): a paragraph with an unfilled placeholder is left out of what is
 * published, and noticeTodos() lists it for the owner. Jurisdiction blocks are drafts that need counsel review
 * and are not published until their status is changed (see ../notices.js).
 *
 * Built-in values: {{brand}}, {{site}}, {{domain}}. Everything else comes from the project.
 */
const NAMES = {
  IR: ["Iran", "Iran"],
  SA: ["Saudi Arabia", "Saudi Arabia"],
  AE: ["United Arab Emirates", "the United Arab Emirates"],
  GB: ["United Kingdom", "the United Kingdom"],
  EU: ["European Union and EEA", "the European Union and the European Economic Area"],
  US: ["United States", "the United States"],
  SG: ["Singapore", "Singapore"],
  MY: ["Malaysia", "Malaysia"],
  ID: ["Indonesia", "Indonesia"],
};

/** The same structure for every jurisdiction: who it is for there, no offer there, and the owner's statement. */
export const jurisdiction = (code, [title, inline]) => {
  const k = code.toLowerCase();
  return {
    title,
    paragraphs: [
      `For readers in ${inline}: this material is intended only for {{audience_${k}}}. It is not directed at, and should not be relied on by, anyone else in ${inline}.`,
      `Nothing here is an offer, invitation or solicitation in ${inline} to buy, sell or subscribe for any product or service, or to enter into any agreement. Products and features described here may not be available in ${inline}.`,
      `{{regulatory_statement_${k}}}`,
    ],
  };
};

export default {
  lang: "en",
  dir: "ltr",
  page: {
    eyebrow: "Legal",
    title: "Legal notices",
    crumb: "Legal notices",
    description: "The notices that apply to {{brand}} material on this site and in our emails: who it is for, and what it is not.",
    lead: "These notices apply to the material on this site and in the emails we send. The general notice always applies; each section after it applies to the readers it names.",
    contents: "On this page",
    general: "Applies to everyone",
    audience: "Audience",
    jurisdiction: "Jurisdiction",
    draft: "Draft: needs counsel review",
    placeholder: "To be filled in by the owner",
  },
  base: {
    title: "Important information",
    paragraphs: [
      "The material from {{brand}} on this site and in our messages is for general information only. It is not investment, financial, legal, tax or Shariah advice, and it is not a recommendation to take or avoid any action.",
      "It is not an offer, invitation or solicitation to buy, sell or subscribe for any security, financial product or service, or to adopt any investment strategy.",
      "Figures, data, screenshots, scenarios and illustrations are examples. Sample, sandbox and demo data are illustrative and are not real customer data. None of them is a forecast or a promise of any result.",
      "Unless a section below says otherwise, this material describes {{brand}} technology for people who build, test and run financial products. Make your own assessment, and take advice from a suitably qualified adviser before making any financial decision.",
      "We may change or withdraw any part of this material at any time without notice.",
      "Published by {{legal_entity}} ({{registration}}), {{registered_address}}.",
    ],
  },
  audiences: {
    retail: {
      title: "For the general public",
      paragraphs: [
        "This material is general information. It was prepared without regard to anyone's objectives, financial situation or needs, so it may not suit yours. Do not act on it alone; consider independent advice first.",
      ],
    },
    professional: {
      title: "For professional readers",
      paragraphs: [
        "This material is intended for people who work in financial services, technology or related fields, in the course of their work. It is not intended for retail customers or end investors and should not be passed on to them.",
      ],
    },
    institutional: {
      title: "For institutions",
      paragraphs: [
        "This material is intended for institutions acting in a business capacity, such as banks and other financial institutions, investment firms, insurers, financial technology companies and their advisers. It is not intended for individual end customers or end investors, who should not rely on it.",
        "Each institution remains responsible for its own decisions, for how it uses any technology described, and for meeting the legal, regulatory and, where relevant, Shariah requirements that apply to it.",
      ],
    },
  },
  jurisdictions: Object.fromEntries(Object.entries(NAMES).map(([code, n]) => [code, jurisdiction(code, n)])),
};
