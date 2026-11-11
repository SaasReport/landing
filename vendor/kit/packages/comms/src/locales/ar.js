/**
 * Arabic (ar): RTL, Arabic-Indic digits, formal Modern Standard Arabic. The copyright line shows the Gregorian
 * year and, unless the config sets legal.hijri: false, the lunar Hijri (Umm al-Qura) year.
 * Strings marked "review" are reasonable MSA but worth a native legal/editorial check for the audience.
 */
import { templates } from "./templates.js";

/** The footer, signature and unsubscribe wording (placeholders in {braces}), assembled by templates.js. */
export const copy = {
  team: "فريق {brand}",
  auto: {
    // review: "يُرجى عدم الرد عليها" (please do not reply) is standard; some organisations prefer "هذا عنوان لا يستقبل الردود".
    sent: "أُرسلت هذه الرسالة تلقائياً من العنوان {sender}؛",
    reply: "تصل ردودكم إلى العنوان {replyTo}.",
    noReply: "يُرجى عدم الرد عليها.",
    contact: "للتواصل معنا، يُرجى استخدام نموذج الاتصال على {link}.",
    contactLink: "موقع {brand}",
  },
  notice: {
    // review: confidentiality and no-advice wording; a local counsel may want jurisdiction-specific phrasing.
    text: "هذه الرسالة وأي مرفقات بها سرية ومخصصة للمستلم المعني وحده. إذا وصلتكم هذه الرسالة عن طريق الخطأ، فيُرجى حذفها وإبلاغنا بذلك؛ ويُحظر استخدامها أو الإفصاح عن محتواها أو نسخها دون إذن. تُستخدم البيانات التي قدمتموها للرد على هذا الطلب فقط، ولا تُشارك مع أي طرف ثالث. ولا يُعدّ محتوى هذه الرسالة نصيحة مالية أو قانونية أو استثمارية.",
    privacyLead: " للاطلاع على ", privacyLabel: "إشعار الخصوصية", privacyTail: ".", privacyText: "إشعار الخصوصية: {privacy}",
  },
  address: { sep: "، ", registration: true },
  copyright: {
    // review: "علامتان تجاريتان مملوكتان لـ" (two trademarks owned by); the legal entity name may be Latin script.
    years: { with: "${year_ar} م / ${year_hijri} هـ", without: "${year_ar} م" },
    html: "© {years} {holder}. جميع الحقوق محفوظة. اسم {brand} وشعاره علامتان تجاريتان مملوكتان لـ{holder}.",
    text: "© {years} {holder}. جميع الحقوق محفوظة. اسم {brand} وشعاره علامتان تجاريتان مملوكتان لـ{holder}.",
  },
  unsubscribe: {
    // review: subscription notice and opt-out wording.
    html: "تصلكم هذه الرسالة لأنكم اشتركتم عبر {siteLink}. يمكنكم {unsubLink} في أي وقت.",
    label: "إلغاء الاشتراك",
    text: "تصلكم هذه الرسالة لأنكم اشتركتم عبر {domain}. لإلغاء الاشتراك: {unsubscribe}",
  },
};
const tpl = templates(copy);

export default {
  lang: "ar",
  dir: "rtl",
  digits: "٠١٢٣٤٥٦٧٨٩",
  lineHeight: { p: "1.9", h1: "1.6", h2: "1.8", step: "1.9", legal: "1.9" },
  years: {
    year_ar: { calendar: "gregory", numerals: "arab" },
    year_hijri: { calendar: "islamic-umalqura", numerals: "arab" },
  },
  // review: "تحية طيبة وبعد" is the classic formal opener and stays gender-neutral after the name.
  greeting: { html: '<strong style="font-weight:700">${name}</strong>، تحية طيبة وبعد،', text: "${name}، تحية طيبة وبعد،" },
  reference: "الرقم المرجعي",
  submitted: "تاريخ الإرسال",
  nextSteps: "الخطوات التالية",
  summary: "ملخص البيانات التي أرسلتموها",
  closing: "مع خالص التحية،",
  team: tpl.team,
  ops: { title: "طلب جديد: ${form_label}", subject: "طلب جديد: ${form_label} | ${reference}" },
  sample: { name: "سارة أحمد", submittedAt: "٣٠ سبتمبر ٢٠٢٦، الساعة ١٠:٣٠", fieldName: "الاسم", fieldEmail: "البريد الإلكتروني", fieldCompany: "الجهة", fieldMessage: "الرسالة", company: "شركة نموذجية", message: "هذه رسالة نموذجية للمعاينة." },
  legal: tpl.legal,
  unsubscribe: tpl.unsubscribe,
};
