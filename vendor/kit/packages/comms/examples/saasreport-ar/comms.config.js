/**
 * Sample comms config: SaasReport (saasreport.ai), English (primary, LTR) and Arabic (RTL,
 * formal Modern Standard Arabic). The copy is sample text to adapt, not product claims. Strings marked
 * "review" are reasonable MSA but need a native editor's check; values starting with TODO must be provided
 * by the project (todos(config) lists them). Colours come from site tokens (colorsFromTokens).
 */
import { colorsFromTokens } from "../../src/index.js";
import { resolveTokens, colorRoles } from "@saasreport/site";

const SITE = "https://saasreport.ai";

// TODO: replace with the project's @saasreport/site tokens (site.config.js tokens.color) once the brand is set.
const tokens = { color: { accent: "#0F766E", accentTint: "#F0FDFA", ink: "#0B0B0B", muted: "#5F6368", rail: "#B8B8B8", line: "#E4E7E6", bg: "#F7F9F8", surface: "#FFFFFF" } };

const FONTS = {
  // The font files must be served from the site (mail clients cannot load them otherwise).
  faces: [
    { family: "Vazirmatn", weight: 400, src: `${SITE}/fonts/Vazirmatn-Regular.ttf` },
    { family: "Vazirmatn", weight: 700, src: `${SITE}/fonts/Vazirmatn-Bold.ttf` },
    { family: "Vazirmatn", weight: 800, src: `${SITE}/fonts/Vazirmatn-ExtraBold.ttf` },
  ],
};

export default {
  project: "saasreport",
  idPrefix: "saasreport",
  site: SITE,
  locales: ["en", "ar"],
  timeZone: "UTC",
  brand: {
    // review: Arabic transliteration of the brand; some audiences keep the Latin name.
    name: { en: "SaasReport", ar: "ساس ريبورت" },
    domain: "saasreport.ai",
    logo: null, // TODO: a PNG lockup (e.g. `${SITE}/brand/logo-email.png`, 198x44); until then the name is the wordmark
    colors: colorsFromTokens({ color: colorRoles(resolveTokens(tokens).color) }),   // the roles @saasreport/site derives (accentText, onAccent, pillBorder), handed in: one derivation
    fonts: {
      en: { stack: "'Vazirmatn','Segoe UI',Arial,sans-serif", ...FONTS },
      ar: { stack: "'Vazirmatn',Tahoma,'Segoe UI',Arial,sans-serif", ...FONTS },
    },
  },
  sender: {
    address: "noreply@saasreport.ai",
    name: { en: "SaasReport", ar: "ساس ريبورت" },
    replyTo: "info@saasreport.ai", // the mailbox must exist and be monitored
  },
  signature: {
    en: { tagline: "AI-narrated reports from your Stripe data" },
    // review
    ar: { tagline: "تقارير مكتوبة بالذكاء الاصطناعي من بيانات Stripe الخاصة بكم" },
  },
  legal: {
    entity: {
      name: { en: "TODO: registered legal entity name", ar: "TODO: الاسم القانوني المسجل للجهة" },
      registration: "TODO: company registration number and registry",
      address: "TODO: registered office address",
    },
    hijri: true, // the Arabic copyright line also shows the lunar Hijri (Umm al-Qura) year
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
  preview: {
    en: { product: "Revenue report", form_label: "Demo request" },
    ar: { product: "تقرير الإيرادات", form_label: "طلب عرض توضيحي" },
  },
  templates: [
    {
      key: "demo-request",
      params: ["product"],
      copy: {
        en: {
          subject: "Your demo request is in | ${reference}",
          preheader: "We will be in touch shortly to schedule your demo.",
          title: "We have received your demo request",
          intro: [
            "Thank you for requesting a demo of ${product}. Our solutions team will review your request and contact you shortly to agree a time.",
            "In the demo we walk through the product in a sandbox with sample data, including the report sections that matter for your use case.",
          ],
          steps: ["We match your request to your use case and sector.", "We agree a time for the session with you.", "We prepare a sandbox with data and scenarios for your demo."],
          cta: { label: "Explore the platform", href: `${SITE}/` },
        },
        ar: {
          subject: "تم استلام طلب العرض التوضيحي | ${reference}",
          preheader: "سنتواصل معكم قريباً لتحديد موعد العرض التوضيحي.",
          title: "تلقّينا طلب العرض التوضيحي",
          intro: [
            "نشكركم على طلب عرض توضيحي لـ«${product}». سيراجع فريق الحلول طلبكم ويتواصل معكم قريباً لتحديد موعد مناسب.",
            // review
            "نستعرض خلال العرض المنتج في بيئة تجريبية ببيانات نموذجية، بما في ذلك أقسام التقرير المتعلقة بحالة الاستخدام لديكم.",
          ],
          steps: ["نطابق طلبكم مع حالة الاستخدام والقطاع.", "نتفق معكم على موعد الجلسة.", "نُعدّ بيئة تجريبية ببيانات وسيناريوهات خاصة بعرضكم."],
          cta: { label: "استكشاف المنصة", href: `${SITE}/ar/` },
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
          intro: ["Thank you for your interest. You are on the early-access list, and we will email your invitation to this address as soon as your sandbox is ready."],
          steps: ["Your place on the early-access list is recorded.", "We prepare the sandbox and starter data.", "Your invitation arrives at this email address."],
        },
        ar: {
          subject: "تمت إضافتكم إلى قائمة الانتظار | ${reference}",
          preheader: "تم حفظ مكانكم في قائمة الوصول المبكر.",
          title: "تم حفظ مكانكم في قائمة الانتظار",
          intro: ["نشكركم على اهتمامكم. أصبحتم ضمن قائمة الوصول المبكر، وسنرسل دعوتكم إلى هذا العنوان فور جاهزية البيئة التجريبية."],
          steps: ["تم تسجيل مكانكم في قائمة الوصول المبكر.", "نُعدّ البيئة التجريبية والبيانات الأولية.", "تصلكم الدعوة على عنوان البريد الإلكتروني هذا."],
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
        ar: {
          subject: "تلقّينا رسالتكم | ${reference}",
          preheader: "تم تسجيل رسالتكم وسنرد عليكم قريباً.",
          title: "تلقّينا رسالتكم",
          intro: ["نشكركم على تواصلكم مع ساس ريبورت. تم تسجيل رسالتكم وسيرد عليكم أحد أعضاء فريقنا قريباً."],
          steps: ["تُحال رسالتكم إلى الفريق المختص.", "نرد عليكم على عنوان البريد الإلكتروني هذا."],
          cta: { label: "العودة إلى الموقع", href: `${SITE}/ar/` },
        },
      },
    },
    {
      key: "newsletter",
      unsubscribe: true,
      copy: {
        en: {
          subject: "You are subscribed to SaasReport updates | ${reference}",
          preheader: "News, guides and event invitations, a few times a month at most.",
          title: "You are subscribed",
          intro: ["Your address is on the SaasReport mailing list. We will write when we publish guides and reports or announce events."],
          steps: ["Your address is on the mailing list.", "New events are announced to you first.", "You can unsubscribe at any time with the link below."],
        },
        ar: {
          subject: "تم اشتراككم في نشرة ساس ريبورت | ${reference}",
          preheader: "أخبار وأدلة ودعوات إلى الفعاليات، بضع مرات في الشهر على الأكثر.",
          title: "تم اشتراككم",
          intro: ["أُضيف عنوانكم إلى القائمة البريدية لـ ساس ريبورت. سنراسلكم عند نشر الأدلة والتقارير أو الإعلان عن الفعاليات."],
          steps: ["أُضيف عنوانكم إلى القائمة البريدية.", "نُعلمكم بالفعاليات الجديدة أولاً.", "يمكنكم إلغاء الاشتراك في أي وقت عبر الرابط أدناه."],
        },
      },
    },
  ],
};
