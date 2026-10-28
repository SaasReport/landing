/**
 * UI strings with en, fa and ar defaults. A project overrides any key through `config.strings`
 * (flat keys, e.g. { "blog.title": "Notes" }) or per language ({ fa: {...}, en: {...} }).
 * `{name}` placeholders are filled by t(key, vars); numbers in vars are shown with the locale's digits.
 * (Minimal internal copy until @saasreport/core ships i18n strings; same keys are meant to move there.)
 */
import { digitsFor } from "./util.js";

export const STRINGS = {
  en: {
    "nav.home": "Home", "nav.blog": "Blog", "nav.podcasts": "Podcast", "nav.glossary": "Glossary", "nav.events": "Events", "nav.calendar": "Calendar",
    "nav.label": "Sections", "nav.languages": "Languages", "skip": "Skip to content", "rss": "RSS feed", "footer.rights": "All rights reserved.", "crumbs": "Breadcrumb",
    "notFound.title": "Page not found", "notFound.body": "The address may have changed.",
    "blog.title": "Blog", "blog.lead": "Articles, guides and reports.", "blog.all": "All", "blog.empty": "Nothing has been published here yet.",
    "blog.prev": "Previous page", "blog.next": "Next page", "blog.pageOf": "Page {page} of {pages}", "blog.readMin": "{n} min read",
    "blog.related": "Related posts", "blog.toc": "In this post", "blog.kinds": "Post type", "blog.auto": "Generated automatically",
    "kind.article": "Article", "kind.howto": "Guide", "kind.analysis": "Analysis", "kind.report": "Report", "kind.snapshot": "Snapshot", "kind.topic": "Topic", "kind.term": "Term",
    "events.title": "Events", "events.lead": "Webinars, workshops and meetups.", "events.upcoming": "Upcoming events", "events.past": "Past events",
    "events.empty": "No upcoming events have been announced yet.", "events.cancelled": "Cancelled",
    "format.online": "Online", "format.in_person": "In person", "format.hybrid": "In person and online",
    "events.addToCal": "Add to calendar:", "events.google": "Google Calendar", "events.apple": "Apple (iPhone, Mac)", "events.outlook": "Outlook",
    "events.office": "Outlook (Microsoft 365)", "events.addTitle": "Add to calendar", "events.addLead": "{when}. Choose the calendar you use:",
    "events.addNote": "Android and Google Calendar: “Google Calendar”. iPhone, iPad and Mac: “Apple”.", "events.page": "Event page",
    "events.until": "until {time}", "events.rsvp": "Register", "events.rsvpClosed": "Registration for this event is closed.",
    "events.rsvpDone": "You are registered.", "events.online": "Online", "events.tbd": "To be announced",
    "form.name": "Full name", "form.email": "Email", "form.company": "Organization", "form.role": "Role", "form.consent": "I agree to the privacy policy.",
    "podcasts.title": "Podcast", "podcasts.lead": "Short audio episodes with full transcripts.", "podcasts.empty": "The first episode is coming soon.",
    "podcasts.feed": "Feed (RSS)", "podcasts.copyFeed": "Copy feed address", "podcasts.transcript": "Transcript", "podcasts.episode": "Episode {n}",
    "podcasts.about": "About this episode", "podcasts.aiVoices": "Voices are synthesized with AI. The full transcript is on this page; click a line to play from there.",
    "podcasts.play": "Play", "podcasts.pause": "Pause", "podcasts.seek": "Seek", "podcasts.back": "Back 15 seconds", "podcasts.fwd": "Forward 15 seconds",
    "podcasts.rate": "Playback speed", "podcasts.download": "Download audio", "podcasts.minutes": "{n} min", "podcasts.playFailed": "Playback failed",
    "podcasts.fullText": "Full transcript of this episode", "podcasts.term": "This episode explains {term}; the full definition is in the glossary.",
    "podcasts.post": "The written version is on the blog: {title}.",
    "tags.title": "Topics", "tags.lead": "Browse the podcasts and posts by topic.", "tags.description": "Every topic of the podcasts and posts, with its episodes and articles.",
    "tags.search": "Search", "tags.searchLabel": "Search titles, summaries and topics", "tags.placeholder": "Search…", "tags.topics": "Topics", "tags.shows": "Show",
    "tags.kinds": "Post type", "tags.clear": "Clear filters", "tags.none": "Nothing matches these filters.", "tags.all": "All topics", "tags.aria": "Topics",
    "tags.podcasts": "Podcast episodes", "tags.posts": "Posts", "tags.countSep": ", ", "tags.count": "{podcasts}{sep}{posts}", "tags.empty": "Nothing has been published under this topic yet.",
    "tags.nPodcasts.one": "{n} podcast", "tags.nPodcasts.other": "{n} podcasts", "tags.nPosts.one": "{n} post", "tags.nPosts.other": "{n} posts",
    "glossary.title": "Glossary", "glossary.lead": "{terms} terms in {cats} categories, each with a plain definition.", "glossary.today": "Term of the day",
    "glossary.search": "Search the glossary", "glossary.searchPlaceholder": "Search a term", "glossary.none": "No matching term.",
    "glossary.related": "Related terms", "glossary.listen": "Listen", "glossary.all": "All {n} terms", "glossary.whatIs": "What is {term}?",
    "glossary.count": "{n} terms", "glossary.soon": "The audio episode for this term is coming soon.", "glossary.categories": "Categories",
    "rx.label": "Reactions and sharing", "rx.like": "Like", "rx.rate": "Rate this episode", "rx.rateN": "{n} of 5", "rx.noRatings": "No ratings yet",
    "rx.ratings": "{n} ratings, average {avg} of 5", "rx.share": "Share", "rx.native": "Share…", "rx.copy": "Copy link", "rx.copied": "Link copied",
    "rx.copyFailed": "Could not copy", "rx.error": "Not saved; please try again.", "rx.rateLimited": "Please try again in a few minutes.", "rx.rated": "Your rating was saved",
    "share.telegram": "Telegram", "share.whatsapp": "WhatsApp", "share.x": "X", "share.linkedin": "LinkedIn", "share.facebook": "Facebook", "share.bale": "Bale", "share.email": "Email",
    "calbit.q": "And this week's business calendar?", "calbit.a": "This week has {n} business days{holidays}.", "calbit.holidays": "; holidays: {list}",
    "calbit.summary": "Plus this week's business calendar: {n} business days.", "calbit.sep": ", ",
    "blog.cardMeta": "{date} · {read}", "blog.keywordSep": ", ", "meta.sep": " · ", "page.title": "{title} | {site}", "page.item": "{title} | {site}",
    "podcasts.cardMeta": "{date} · {duration}", "podcasts.speakerSep": " · ", "glossary.onDate": "on {date}",
    "subscribe.done": "You're subscribed.", "form.reference": "Reference: {ref}", "form.failed": "Not sent; please try again.", "form.failedTitle": "Not sent",
    "form.error.consent_required": "Please accept the privacy policy.", "form.error.missing_field": "Please fill in the required fields.",
    "form.error.invalid_email": "The email address is not valid.", "form.error.rate_limited": "Too many requests; try again in a few minutes.",
    "form.error.event_unavailable": "Registration for this event is closed.",
    "subscribe.title": "Stay in the loop", "subscribe.note": "", "subscribe.button": "Subscribe", "subscribe.consentLink": "I agree to the {link}.", "subscribe.privacy": "privacy policy",
  },
  ar: {
    "nav.home": "الرئيسية", "nav.blog": "المدونة", "nav.podcasts": "البودكاست", "nav.glossary": "المسرد", "nav.events": "الفعاليات", "nav.calendar": "التقويم",
    "nav.label": "الأقسام", "nav.languages": "اللغات", "skip": "انتقل إلى المحتوى", "rss": "موجز RSS", "footer.rights": "جميع الحقوق محفوظة.", "crumbs": "مسار التنقل",
    "notFound.title": "الصفحة غير موجودة", "notFound.body": "ربما تغيّر العنوان.",
    "blog.title": "المدونة", "blog.lead": "مقالات وأدلة وتقارير.", "blog.all": "الكل", "blog.empty": "لم يُنشر شيء هنا بعد.",
    "blog.prev": "الصفحة السابقة", "blog.next": "الصفحة التالية", "blog.pageOf": "الصفحة {page} من {pages}", "blog.readMin": "{n} دقائق قراءة",
    "blog.related": "منشورات ذات صلة", "blog.toc": "في هذا المنشور", "blog.kinds": "نوع المنشور", "blog.auto": "مولّد تلقائيًا",
    "kind.article": "مقال", "kind.howto": "دليل", "kind.analysis": "تحليل", "kind.report": "تقرير", "kind.snapshot": "لمحة تلقائية", "kind.topic": "موضوع", "kind.term": "مصطلح",
    "events.title": "الفعاليات", "events.lead": "ندوات عبر الإنترنت وورش عمل ولقاءات.", "events.upcoming": "الفعاليات القادمة", "events.past": "الفعاليات السابقة",
    "events.empty": "لم يُعلن عن فعاليات قادمة بعد.", "events.cancelled": "أُلغيت",
    "format.online": "عبر الإنترنت", "format.in_person": "حضوري", "format.hybrid": "حضوري وعبر الإنترنت",
    "events.addToCal": "أضف إلى التقويم:", "events.google": "تقويم Google", "events.apple": "Apple (آيفون، ماك)", "events.outlook": "Outlook",
    "events.office": "Outlook (Microsoft 365)", "events.addTitle": "أضف إلى التقويم", "events.addLead": "{when}. اختر التقويم الذي تستخدمه:",
    "events.addNote": "أندرويد وتقويم Google: «تقويم Google». آيفون وآيباد وماك: «Apple».", "events.page": "صفحة الفعالية",
    "events.until": "حتى {time}", "events.rsvp": "سجّل", "events.rsvpClosed": "التسجيل في هذه الفعالية مغلق.",
    "events.rsvpDone": "تم تسجيلك.", "events.online": "عبر الإنترنت", "events.tbd": "يُعلن لاحقًا",
    "form.name": "الاسم الكامل", "form.email": "البريد الإلكتروني", "form.company": "الجهة", "form.role": "المنصب", "form.consent": "أوافق على سياسة الخصوصية.",
    "podcasts.title": "البودكاست", "podcasts.lead": "حلقات صوتية قصيرة مع نصوصها الكاملة.", "podcasts.empty": "الحلقة الأولى قريبًا.",
    "podcasts.feed": "الموجز (RSS)", "podcasts.copyFeed": "انسخ عنوان الموجز", "podcasts.transcript": "النص الكامل", "podcasts.episode": "الحلقة {n}",
    "podcasts.about": "عن هذه الحلقة", "podcasts.aiVoices": "الأصوات مولّدة بالذكاء الاصطناعي. النص الكامل في هذه الصفحة؛ اضغط على أي سطر لتبدأ التشغيل منه.",
    "podcasts.play": "تشغيل", "podcasts.pause": "إيقاف مؤقت", "podcasts.seek": "انتقال داخل الحلقة", "podcasts.back": "رجوع ١٥ ثانية", "podcasts.fwd": "تقديم ١٥ ثانية",
    "podcasts.rate": "سرعة التشغيل", "podcasts.download": "تنزيل الملف الصوتي", "podcasts.minutes": "{n} دقائق", "podcasts.playFailed": "تعذّر التشغيل",
    "podcasts.fullText": "النص الكامل لهذه الحلقة", "podcasts.term": "تشرح هذه الحلقة مصطلح {term}؛ التعريف الكامل في المسرد.",
    "podcasts.post": "النسخة المكتوبة في المدونة: {title}.",
    "tags.title": "المواضيع", "tags.lead": "تصفح البودكاست والمنشورات حسب الموضوع.", "tags.description": "كل مواضيع البودكاست والمنشورات مع حلقاتها ومقالاتها.",
    "tags.search": "بحث", "tags.searchLabel": "ابحث في العناوين والملخصات والمواضيع", "tags.placeholder": "بحث…", "tags.topics": "المواضيع", "tags.shows": "البرنامج",
    "tags.kinds": "نوع المنشور", "tags.clear": "مسح التصفية", "tags.none": "لا شيء يطابق هذه التصفية.", "tags.all": "كل المواضيع", "tags.aria": "المواضيع",
    "tags.podcasts": "حلقات البودكاست", "tags.posts": "المنشورات", "tags.countSep": "، ", "tags.count": "{podcasts}{sep}{posts}", "tags.empty": "لم يُنشر شيء تحت هذا الموضوع بعد.",
    "tags.nPodcasts.zero": "{n} حلقة", "tags.nPodcasts.one": "حلقة واحدة", "tags.nPodcasts.two": "حلقتان", "tags.nPodcasts.few": "{n} حلقات", "tags.nPodcasts.many": "{n} حلقة", "tags.nPodcasts.other": "{n} حلقة",
    "tags.nPosts.zero": "{n} منشور", "tags.nPosts.one": "منشور واحد", "tags.nPosts.two": "منشوران", "tags.nPosts.few": "{n} منشورات", "tags.nPosts.many": "{n} منشورًا", "tags.nPosts.other": "{n} منشور",
    "glossary.title": "المسرد", "glossary.lead": "{terms} مصطلحًا في {cats} فئات، لكل منها تعريف بسيط.", "glossary.today": "مصطلح اليوم",
    "glossary.search": "ابحث في المسرد", "glossary.searchPlaceholder": "ابحث عن مصطلح", "glossary.none": "لا يوجد مصطلح مطابق.",
    "glossary.related": "مصطلحات ذات صلة", "glossary.listen": "استمع", "glossary.all": "كل المصطلحات ({n})", "glossary.whatIs": "ما هو {term}؟",
    "glossary.count": "{n} مصطلحات", "glossary.soon": "الحلقة الصوتية لهذا المصطلح قريبًا.", "glossary.categories": "الفئات",
    "rx.label": "التفاعل والمشاركة", "rx.like": "إعجاب", "rx.rate": "قيّم هذه الحلقة", "rx.rateN": "{n} من ٥", "rx.noRatings": "لا تقييمات بعد",
    "rx.ratings": "{n} تقييمات، المتوسط {avg} من ٥", "rx.share": "مشاركة", "rx.native": "مشاركة…", "rx.copy": "نسخ الرابط", "rx.copied": "نُسخ الرابط",
    "rx.copyFailed": "تعذّر النسخ", "rx.error": "لم يُحفظ؛ حاول مرة أخرى.", "rx.rateLimited": "حاول مرة أخرى بعد دقائق.", "rx.rated": "حُفظ تقييمك",
    "share.telegram": "تيليغرام", "share.whatsapp": "واتساب", "share.x": "إكس", "share.linkedin": "لينكدإن", "share.facebook": "فيسبوك", "share.bale": "بله", "share.email": "البريد الإلكتروني",
    "calbit.q": "وماذا عن تقويم العمل هذا الأسبوع؟", "calbit.a": "في هذا الأسبوع {n} أيام عمل{holidays}.", "calbit.holidays": "؛ العطلات: {list}",
    "calbit.summary": "ومعه تقويم العمل لهذا الأسبوع: {n} أيام عمل.", "calbit.sep": "، ",
    "blog.cardMeta": "{date} · {read}", "blog.keywordSep": "، ", "meta.sep": " · ", "page.title": "{title} | {site}", "page.item": "{title} | {site}",
    "podcasts.cardMeta": "{date} · {duration}", "podcasts.speakerSep": " · ", "glossary.onDate": "في {date}",
    "subscribe.done": "تم اشتراكك.", "form.reference": "الرقم المرجعي: {ref}", "form.failed": "لم يُرسل؛ حاول مرة أخرى.", "form.failedTitle": "لم يُرسل",
    "form.error.consent_required": "يرجى الموافقة على سياسة الخصوصية.", "form.error.missing_field": "يرجى تعبئة الحقول المطلوبة.",
    "form.error.invalid_email": "عنوان البريد الإلكتروني غير صالح.", "form.error.rate_limited": "طلبات كثيرة؛ حاول بعد دقائق.",
    "form.error.event_unavailable": "التسجيل في هذه الفعالية مغلق.",
    "subscribe.title": "ابقَ على اطلاع", "subscribe.note": "", "subscribe.button": "اشترك", "subscribe.consentLink": "أوافق على {link}.", "subscribe.privacy": "سياسة الخصوصية",
  },
  fa: {
    "nav.home": "خانه", "nav.blog": "بلاگ", "nav.podcasts": "پادکست", "nav.glossary": "واژه‌نامه", "nav.events": "رویدادها", "nav.calendar": "تقویم",
    "nav.label": "بخش‌ها", "nav.languages": "زبان‌ها", "skip": "رفتن به محتوای اصلی", "rss": "خوراک RSS", "footer.rights": "تمامی حقوق محفوظ است.", "crumbs": "مسیر",
    "notFound.title": "این صفحه پیدا نشد", "notFound.body": "ممکن است نشانی تغییر کرده باشد.",
    "blog.title": "بلاگ", "blog.lead": "مقاله، راهنما و گزارش.", "blog.all": "همه", "blog.empty": "هنوز نوشته‌ای در این بخش منتشر نشده است.",
    "blog.prev": "صفحه قبل", "blog.next": "صفحه بعد", "blog.pageOf": "صفحه {page} از {pages}", "blog.readMin": "{n} دقیقه مطالعه",
    "blog.related": "نوشته‌های مرتبط", "blog.toc": "در این نوشته", "blog.kinds": "نوع نوشته", "blog.auto": "تولید خودکار",
    "kind.article": "مقاله", "kind.howto": "راهنما", "kind.analysis": "تحلیل", "kind.report": "گزارش", "kind.snapshot": "نمای خودکار", "kind.topic": "موضوع", "kind.term": "واژه",
    "events.title": "رویدادها", "events.lead": "وبینارها، کارگاه‌ها و نشست‌ها.", "events.upcoming": "رویدادهای پیش‌رو", "events.past": "رویدادهای گذشته",
    "events.empty": "رویداد پیش‌رویی اعلام نشده است.", "events.cancelled": "لغو شد",
    "format.online": "برخط", "format.in_person": "حضوری", "format.hybrid": "حضوری و برخط",
    "events.addToCal": "افزودن به تقویم:", "events.google": "تقویم گوگل", "events.apple": "آیفون و مک", "events.outlook": "اوت‌لوک",
    "events.office": "اوت‌لوک سازمانی (Microsoft 365)", "events.addTitle": "افزودن به تقویم", "events.addLead": "{when}. تقویمی را که استفاده می‌کنید انتخاب کنید:",
    "events.addNote": "اندروید و تقویم گوگل: «تقویم گوگل». آیفون، آیپد و مک: «آیفون و مک».", "events.page": "صفحه رویداد",
    "events.until": "تا {time}", "events.rsvp": "ثبت‌نام", "events.rsvpClosed": "ثبت‌نام این رویداد بسته است.",
    "events.rsvpDone": "ثبت‌نام شما انجام شد.", "events.online": "برخط", "events.tbd": "اعلام می‌شود",
    "form.name": "نام و نام خانوادگی", "form.email": "ایمیل", "form.company": "سازمان یا شرکت", "form.role": "سمت", "form.consent": "با سیاست حریم خصوصی موافقم.",
    "podcasts.title": "پادکست", "podcasts.lead": "قسمت‌های صوتی کوتاه با متن کامل.", "podcasts.empty": "نخستین قسمت به‌زودی منتشر می‌شود.",
    "podcasts.feed": "خوراک (RSS)", "podcasts.copyFeed": "رونوشت نشانی خوراک", "podcasts.transcript": "متن کامل", "podcasts.episode": "قسمت {n}",
    "podcasts.about": "درباره این قسمت", "podcasts.aiVoices": "صدای گویندگان با هوش مصنوعی ساخته شده است. متن کامل در همین صفحه است؛ روی هر جمله بزنید تا پخش از همان‌جا ادامه یابد.",
    "podcasts.play": "پخش", "podcasts.pause": "توقف", "podcasts.seek": "جابه‌جایی در قسمت", "podcasts.back": "۱۵ ثانیه عقب", "podcasts.fwd": "۱۵ ثانیه جلو",
    "podcasts.rate": "سرعت پخش", "podcasts.download": "دریافت فایل صوتی", "podcasts.minutes": "{n} دقیقه", "podcasts.playFailed": "پخش ممکن نشد",
    "podcasts.fullText": "متن کامل این قسمت", "podcasts.term": "این قسمت واژه {term} را توضیح می‌دهد؛ تعریف کامل در واژه‌نامه آمده است.",
    "podcasts.post": "نسخه نوشتاری در بلاگ: {title}.",
    "tags.title": "موضوع‌ها", "tags.lead": "پادکست‌ها و نوشته‌ها را بر پایهٔ موضوع پیدا کنید.", "tags.description": "همهٔ موضوع‌های پادکست‌ها و نوشته‌ها، با قسمت‌ها و مقاله‌های هر موضوع.",
    "tags.search": "جستجو", "tags.searchLabel": "جستجو در عنوان، خلاصه و موضوع", "tags.placeholder": "جستجو…", "tags.topics": "موضوع‌ها", "tags.shows": "برنامه",
    "tags.kinds": "نوع نوشته", "tags.clear": "پاک کردن فیلترها", "tags.none": "چیزی با این فیلترها پیدا نشد.", "tags.all": "همهٔ موضوع‌ها", "tags.aria": "موضوع‌ها",
    "tags.podcasts": "قسمت‌های پادکست", "tags.posts": "نوشته‌ها", "tags.countSep": "، ", "tags.count": "{podcasts}{sep}{posts}", "tags.empty": "هنوز چیزی با این موضوع منتشر نشده است.",
    "tags.nPodcasts.one": "{n} پادکست", "tags.nPodcasts.other": "{n} پادکست", "tags.nPosts.one": "{n} نوشته", "tags.nPosts.other": "{n} نوشته",
    "glossary.title": "واژه‌نامه", "glossary.lead": "{terms} واژه در {cats} دسته، هر کدام با تعریفی ساده.", "glossary.today": "واژه امروز",
    "glossary.search": "جست‌وجو در واژه‌ها", "glossary.searchPlaceholder": "جست‌وجوی واژه", "glossary.none": "واژه‌ای پیدا نشد.",
    "glossary.related": "واژه‌های مرتبط", "glossary.listen": "بشنوید", "glossary.all": "همه {n} واژه", "glossary.whatIs": "{term} چیست؟",
    "glossary.count": "{n} واژه", "glossary.soon": "قسمت صوتی این واژه به‌زودی منتشر می‌شود.", "glossary.categories": "دسته‌ها",
    "rx.label": "واکنش و اشتراک‌گذاری", "rx.like": "پسندیدم", "rx.rate": "امتیاز به این قسمت", "rx.rateN": "امتیاز {n} از ۵", "rx.noRatings": "هنوز امتیازی ثبت نشده",
    "rx.ratings": "{n} رأی، میانگین {avg} از ۵", "rx.share": "اشتراک‌گذاری", "rx.native": "اشتراک", "rx.copy": "رونوشت پیوند", "rx.copied": "پیوند رونوشت شد",
    "rx.copyFailed": "رونوشت ممکن نشد", "rx.error": "ثبت نشد؛ دوباره امتحان کنید.", "rx.rateLimited": "کمی بعد دوباره امتحان کنید.", "rx.rated": "امتیاز شما ثبت شد",
    "share.telegram": "تلگرام", "share.whatsapp": "واتساپ", "share.x": "ایکس", "share.linkedin": "لینکدین", "share.facebook": "فیسبوک", "share.bale": "بله", "share.email": "ایمیل",
    "calbit.q": "و تقویم کاری این هفته؟", "calbit.a": "این هفته {n} روز کاری داریم{holidays}.", "calbit.holidays": "؛ تعطیلات: {list}",
    "calbit.summary": "به‌علاوه تقویم کاری هفته: {n} روز کاری.", "calbit.sep": "، ",
    "blog.cardMeta": "{date}، {read}", "blog.keywordSep": "، ", "meta.sep": "، ", "page.title": "{title} | {site}", "page.item": "{title} | {site}",
    "podcasts.cardMeta": "{date}، {duration}", "podcasts.speakerSep": " · ", "glossary.onDate": "در {date}",
    "subscribe.done": "عضویت شما ثبت شد.", "form.reference": "رسید با شماره پیگیری {ref} به ایمیل شما ارسال شد.", "form.failed": "ارسال انجام نشد؛ دوباره تلاش کنید.", "form.failedTitle": "ارسال ناموفق",
    "form.error.consent_required": "لطفاً موافقت با سیاست حریم خصوصی را تأیید کنید.", "form.error.missing_field": "لطفاً فیلدهای الزامی را کامل کنید.",
    "form.error.invalid_email": "نشانی ایمیل معتبر نیست.", "form.error.rate_limited": "تعداد درخواست‌ها زیاد است؛ چند دقیقه دیگر دوباره تلاش کنید.",
    "form.error.event_unavailable": "ثبت‌نام این رویداد بسته است.",
    "subscribe.title": "از تازه‌ها باخبر شوید", "subscribe.note": "", "subscribe.button": "عضویت", "subscribe.consentLink": "با {link} موافقم.", "subscribe.privacy": "سیاست حریم خصوصی",
  },
};

/**
 * Regional variants: a site whose locale is a region of a language (site.locale "en-GB") gets that language's strings
 * with these on top. British English spells the kit's own words the British way (owner, 2026-10-06).
 */
export const REGIONAL = {
  "en-GB": { "form.company": "Organisation" },
};

/** Build a translator for a normalized config. */
export function translator(config) {
  const lang = config.site.lang;
  const base = { ...(STRINGS[lang] || STRINGS.en), ...(REGIONAL[config.site.localeBase] || {}) };   // normalizeConfig's canonical locale, extensions stripped
  const custom = config.strings || {};
  const flat = Object.fromEntries(Object.entries(custom).filter(([, v]) => typeof v === "string"));
  const perLang = custom[lang] && typeof custom[lang] === "object" ? custom[lang] : {};
  const table = { ...STRINGS.en, ...base, ...flat, ...perLang };
  const d = digitsFor(lang);
  const t = (key, vars) => {
    let s = table[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : typeof vars[k] === "number" ? d(vars[k]) : String(vars[k])));
    return s;
  };
  t.has = (key) => key in table;
  /** Optional string: "" when the key is not defined (or empty). */
  t.opt = (key, vars) => (table[key] ? t(key, vars) : "");
  t.table = table;
  return t;
}
