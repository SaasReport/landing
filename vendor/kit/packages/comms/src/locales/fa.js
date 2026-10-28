/**
 * Persian (fa): RTL, Persian digits, the Solar Hijri year beside the Gregorian one in the copyright line.
 * Formal-but-plain written Persian. `${param}` placeholders are filled by the comms engine at send time;
 * everything else comes from the project's comms config (x: brand, holder, sender, site, contact, …).
 */
import { templates } from "./templates.js";

/** The footer, signature and unsubscribe wording (placeholders in {braces}), assembled by templates.js. */
export const copy = {
  team: "تیم {brand}",
  auto: {
    sent: "این پیام به‌صورت خودکار از نشانی {sender} ارسال شده است؛",
    reply: "پاسخ شما به نشانی {replyTo} می‌رسد.",
    noReply: "لطفاً به آن پاسخ ندهید.",
    contact: "برای ارتباط با ما از فرم تماس در {link} استفاده کنید.",
    contactLink: "وب‌سایت {brand}",
  },
  notice: {
    text: "محتوای این پیام محرمانه و صرفاً برای گیرنده تعیین‌شده است. اگر این پیام به اشتباه به دست شما رسیده، لطفاً آن را حذف کنید؛ هرگونه استفاده، انتشار یا رونوشت‌برداری از آن بدون اجازه ممنوع است. اطلاعاتی که ثبت کرده‌اید فقط برای پاسخ‌گویی به همین درخواست به کار می‌رود و در اختیار شخص ثالث قرار نمی‌گیرد. محتوای این پیام توصیه مالی، حقوقی یا سرمایه‌گذاری به شمار نمی‌رود.",
    privacyLead: " ", privacyLabel: "سیاست حریم خصوصی", privacyTail: "", privacyText: "سیاست حریم خصوصی: {privacy}",
  },
  address: { sep: "، ", registration: false },
  copyright: {
    html: "© ${year_fa} خورشیدی / ${year_en} میلادی — {holder}. تمامی حقوق مادی و معنوی محفوظ است. نام و نشان «{brand}» و محتوای این پیام مشمول قوانین حمایت از حقوق پدیدآورندگان است.",
    text: "© ${year_fa} خورشیدی / ${year_en} میلادی — {holder}. تمامی حقوق مادی و معنوی محفوظ است.",
  },
  unsubscribe: {
    html: "این پیام را به این دلیل دریافت می‌کنید که در {siteLink} عضو شده‌اید. برای لغو عضویت {unsubLink}.",
    label: "اینجا را ببینید",
    text: "این پیام را به این دلیل دریافت می‌کنید که در {domain} عضو شده‌اید. لغو عضویت: {unsubscribe}",
  },
};
const tpl = templates(copy);

export default {
  lang: "fa",
  dir: "rtl",
  digits: "۰۱۲۳۴۵۶۷۸۹",
  lineHeight: { p: "2", h1: "1.6", h2: "1.8", step: "1.9", legal: "1.9" },
  // Copyright years the engine computes at send time (calendar, numerals), in the config's time zone.
  years: {
    year_fa: { calendar: "jalali", numerals: "arabext" },
    year_en: { calendar: "gregory", numerals: "arabext" },
  },
  greeting: { html: '<strong style="font-weight:700">${name}</strong> گرامی، سلام.', text: "${name} گرامی، سلام." },
  reference: "شماره پیگیری",
  submitted: "تاریخ ثبت",
  nextSteps: "گام‌های بعدی",
  summary: "خلاصه اطلاعاتی که ثبت کردید",
  closing: "با احترام،",
  team: tpl.team,
  ops: { title: "درخواست تازه: ${form_label}", subject: "درخواست تازه: ${form_label} | ${reference}" },
  sample: { name: "سارا احمدی", submittedAt: "۸ مهر ۱۴۰۵، ساعت ۱۰:۳۰", fieldName: "نام", fieldEmail: "ایمیل", fieldCompany: "سازمان", fieldMessage: "پیام", company: "شرکت نمونه", message: "این یک پیام نمونه برای پیش‌نمایش است." },
  legal: tpl.legal,
  unsubscribe: tpl.unsubscribe,
};
