/**
 * Default spoken strings for episodes, per language. Override any part with config.strings.podcast
 * (deep-merged). Line arrays are [speakerKey, text] where the key is "host"/"expert" or a config.hosts key.
 * Placeholders: {show} {site} {number} {term} {title} {summary} {short} {category} {host} {expert} {calendar}.
 */
export const PODCAST_STRINGS = {
  fa: {
    topic: {
      intro: [["host", "سلام! اینجا {show}ه، از {site}. من {host}م، با {expert}."], ["expert", "سلام به همه!"]],
      outro: [["host", "نسخه نوشتاری و جزئیات این هفته تو بلاگ {site}ه."], ["expert", "صدای ما رو هم هوش مصنوعی ساخته. تا هفته بعد، خداحافظ!"]],
      title: "{title}",
      summary: "{summary}",
      summaryWithCalendar: "{summary} {calendar}",
    },
    term: {
      intro: [["host", "سلام! {show}، قسمت {number}. واژه امروز: {term}."]],
      outro: [["host", "تعریف کامل و واژه‌های مرتبط تو واژه‌نامه سایت {site}ه. صدای ما رو هوش مصنوعی ساخته؛ تا فردا!"]],
      title: "{show}، قسمت {number}: {term}",
      summary: "{short} ({category})",
      summaryNoCategory: "{short}",
    },
    article: {
      intro: [["host", "سلام! اینجا {show}ه، از {site}. من {host}م، با {expert}."], ["expert", "سلام به همه! امروز درباره نوشته «{title}» از بلاگ حرف می‌زنیم."]],
      outro: [["host", "نسخه نوشتاری و جزئیات این هفته تو بلاگ {site}ه."], ["expert", "صدای ما رو هم هوش مصنوعی ساخته. تا هفته بعد، خداحافظ!"]],
      source: "عنوان: {title}\nخلاصه: {summary}\n\n{body}",
      user: "متن منبع:\n\n{source}",
      code: "[نمونه کد]",
      repair: "این گفت‌وگو چند ایراد نگارشی فارسی دارد. همان گفت‌وگو را با همان قالب JSON دوباره بنویس و فقط این ایرادها را برطرف کن:\n{findings}",
      system: `تو نویسنده یک پادکست گفت‌وگویی فارسی به اسم «{show}» هستی. دو نفر با هم حرف می‌زنن: «{host}» ({hostKey}، {hostRole}، کنجکاو، سؤال می‌پرسه) و «{expert}» ({expertKey}، {expertRole}، ساده توضیح می‌ده).
سبک:
- فارسی محاوره‌ای و خودمونی، مثل دو تا همکار که دارن با هم گپ می‌زنن؛ نه مجری تلویزیون، نه متن رسمی و کتابی. مثلاً «می‌خوایم»، «اینجوری»، «ببین»، «آها»، «راستی»، «یعنی چی؟».
- جمله‌های کوتاه، نوبت‌های کوتاه، واکنش طبیعی (تعجب، تأیید، سؤال پیگیری). هر خط حداکثر دو جمله.
قواعد محتوا:
- فقط بر پایه متن منبع. هیچ عدد، تاریخ، نام، نهاد یا ادعایی که در منبع نیست اضافه نکن.
- عددها و تاریخ‌ها را دقیقاً با رقم، همان‌طور که در منبع آمده بنویس.
- بدون کد، نشانی اینترنتی، ایموجی یا مارک‌داون. اسم فیلدها و دستورها را نخوان؛ مفهومشان را بگو.
- سلام اول و خداحافظی آخر را ننویس؛ جداگانه اضافه می‌شوند.
خروجی فقط یک شیء JSON: {"lines": [{"speaker": "{hostKey}" | "{expertKey}", "text": "..."}]} با {minLines} تا {maxLines} خط و روی هم حداکثر {maxChars} نویسه.`,
    },
  },
  ar: {
    topic: {
      intro: [["host", "مرحبًا! معكم {show} من {site}. أنا {host}، ومعي {expert}."], ["expert", "أهلًا بالجميع!"]],
      outro: [["host", "النسخة المكتوبة والتفاصيل في مدونة {site}."], ["expert", "أصواتنا مولّدة بالذكاء الاصطناعي. نلقاكم الأسبوع المقبل، مع السلامة!"]],
      title: "{title}",
      summary: "{summary}",
      summaryWithCalendar: "{summary} {calendar}",
    },
    term: {
      intro: [["host", "مرحبًا! {show}، الحلقة {number}. مصطلح اليوم: {term}."]],
      outro: [["host", "التعريف الكامل والمصطلحات ذات الصلة في مسرد {site}. أصواتنا مولّدة بالذكاء الاصطناعي؛ نلقاكم غدًا!"]],
      title: "{show}، الحلقة {number}: {term}",
      summary: "{short} ({category})",
      summaryNoCategory: "{short}",
    },
    article: {
      intro: [["host", "مرحبًا! معكم {show} من {site}. أنا {host}، ومعي {expert}."], ["expert", "أهلًا بالجميع! نتحدث اليوم عن مقال «{title}» من المدونة."]],
      outro: [["host", "النسخة المكتوبة والتفاصيل في مدونة {site}."], ["expert", "أصواتنا مولّدة بالذكاء الاصطناعي. نلقاكم الأسبوع المقبل، مع السلامة!"]],
      source: "العنوان: {title}\nالملخص: {summary}\n\n{body}",
      user: "النص المصدر:\n\n{source}",
      code: "[مثال برمجي]",
      repair: "في هذا الحوار أخطاء في الكتابة. أعد كتابة الحوار نفسه بصيغة JSON نفسها وصحّح هذه الأخطاء فقط:\n{findings}",
      system: `أنت تكتب بودكاست حواريًا بالعربية اسمه «{show}». يتحدث شخصان: «{host}» ({hostKey}، {hostRole}، فضولي ويطرح الأسئلة) و«{expert}» ({expertKey}، {expertRole}، يشرح ببساطة).
الأسلوب:
- عربية فصحى مبسطة قريبة من الحديث اليومي، كزميلين يتحاوران؛ لا كمذيع أخبار ولا كنص رسمي مكتوب.
- جمل قصيرة وأدوار قصيرة وتفاعل طبيعي (دهشة، موافقة، سؤال متابعة). جملتان على الأكثر في كل سطر.
قواعد المحتوى:
- اعتمد على النص المصدر وحده. لا تضف رقمًا أو تاريخًا أو اسمًا أو جهة أو ادعاءً غير موجود فيه.
- اكتب الأرقام والتواريخ بالأرقام كما وردت في المصدر تمامًا.
- لا شيفرة ولا روابط ولا رموز تعبيرية ولا ماركداون. لا تقرأ أسماء الحقول أو الأوامر؛ قل معناها.
- لا تكتب التحية الأولى ولا الوداع الأخير؛ يضافان لاحقًا.
أخرج كائن JSON فقط: {"lines": [{"speaker": "{hostKey}" | "{expertKey}", "text": "..."}]} بين {minLines} و{maxLines} سطرًا وبما لا يتجاوز {maxChars} حرفًا إجمالًا.`,
    },
  },
  en: {
    topic: {
      intro: [["host", "Hi! This is {show}, from {site}. I'm {host}, here with {expert}."], ["expert", "Hello everyone!"]],
      outro: [["host", "The written version and the details are on the {site} blog."], ["expert", "Our voices were made with AI. See you next week, bye!"]],
      title: "{title}",
      summary: "{summary}",
      summaryWithCalendar: "{summary} {calendar}",
    },
    term: {
      intro: [["host", "Hi! {show}, episode {number}. Today's term: {term}."]],
      outro: [["host", "The full definition and related terms are in the {site} glossary. Our voices were made with AI; see you tomorrow!"]],
      title: "{show}, episode {number}: {term}",
      summary: "{short} ({category})",
      summaryNoCategory: "{short}",
    },
    article: {
      intro: [["host", "Hi! This is {show}, from {site}. I'm {host}, here with {expert}."], ["expert", "Hello everyone! Today we're talking about the post “{title}” from the blog."]],
      outro: [["host", "The written version and the details are on the {site} blog."], ["expert", "Our voices were made with AI. See you next week, bye!"]],
      source: "Title: {title}\nSummary: {summary}\n\n{body}",
      user: "Source text:\n\n{source}",
      code: "[code sample]",
      repair: "This conversation has writing problems. Rewrite the same conversation in the same JSON format, fixing only these:\n{findings}",
      system: `You write a conversational podcast called “{show}”. Two people talk: “{host}” ({hostKey}, {hostRole}, curious, asks questions) and “{expert}” ({expertKey}, {expertRole}, explains simply).
Style:
- Casual spoken language, like two colleagues chatting; not a news presenter, not formal written prose.
- Short sentences, short turns, natural reactions (surprise, agreement, follow-up questions). At most two sentences per line.
Content rules:
- Based only on the source text. Add no number, date, name, organisation or claim that is not in the source.
- Write numbers and dates with digits, exactly as in the source.
- No code, URLs, emoji or Markdown. Do not read field or command names; say what they mean.
- Do not write the opening greeting or the closing goodbye; they are added separately.
Output only a JSON object: {"lines": [{"speaker": "{hostKey}" | "{expertKey}", "text": "..."}]} with {minLines} to {maxLines} lines and at most {maxChars} characters in total.`,
    },
  },
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

/**
 * Podcast strings for the config's language: defaults (fa, en or ar) deep-merged with config.strings.podcast, and, for one
 * series, with its `podcast.strings` (a concept series speaks its own intro, outro and title; docs/CONCEPTS.md).
 */
export function podcastStrings(config, series = null) {
  const l = String(config?.site?.locale || "en").toLowerCase().split(/[-_]/)[0];
  const base = PODCAST_STRINGS[l] || PODCAST_STRINGS.en;
  const over = config?.strings?.podcast ?? config?.strings?.[l]?.podcast;
  const merged = merge(base, over);
  const own = series && typeof series === "object" ? series.podcast?.strings : null;
  return own ? merge(merged, own) : merged;
}
