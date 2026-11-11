/**
 * The calendar's reader-facing copy, as data (kit.canon.json validates COPY against the copy-pack schema; the hardcoding scan
 * reads the same text anywhere else in the package as a finding). Persian is the calendar's own language; {placeholders} are
 * filled by `fill`. The official holiday titles are the Iranian government's published ones.
 */
export const COPY = {
  errors: {
    invalid_date: "تاریخ {jy}/{jm}/{jd} وجود ندارد.",
    out_of_range: "سال باید بین {min} و {max} باشد.",
    date_format: "قالب تاریخ باید ۱۴۰۵/۰۷/۰۷ یا 2026-09-29 باشد.",
    gregorian_invalid: "تاریخ میلادی معتبر نیست.",
    invalid_convention: "قاعده تعدیل معتبر نیست.",
    invalid_days: "تعداد روز باید عدد صحیح بین ‎-۳۶۵۰ و ۳۶۵۰ باشد.",
    invalid_count: "تعداد اقساط باید بین ۱ و ۳۶۰ باشد.",
    invalid_interval: "فاصله اقساط باید بین ۱ و ۱۲ ماه باشد.",
  },
  today: "امروز",
  holidays: {
    solar: [
      [1, 1, "جشن نوروز"], [1, 2, "جشن نوروز"], [1, 3, "جشن نوروز"], [1, 4, "جشن نوروز"],
      [1, 12, "روز جمهوری اسلامی"], [1, 13, "روز طبیعت"],
      [3, 14, "رحلت امام خمینی"], [3, 15, "قیام ۱۵ خرداد"],
      [11, 22, "پیروزی انقلاب اسلامی"], [12, 29, "روز ملی شدن صنعت نفت"],
    ],
    lunar: [
      [1, 9, "تاسوعای حسینی"], [1, 10, "عاشورای حسینی"], [2, 20, "اربعین حسینی"],
      [2, 28, "رحلت پیامبر اکرم و شهادت امام حسن مجتبی"], [2, 0, "شهادت امام رضا"],
      [3, 8, "شهادت امام حسن عسکری"], [3, 17, "میلاد پیامبر اکرم و امام جعفر صادق"],
      [6, 3, "شهادت حضرت فاطمه زهرا"], [7, 13, "ولادت امام علی"], [7, 27, "مبعث پیامبر اکرم"],
      [8, 15, "ولادت حضرت قائم"], [9, 21, "شهادت امام علی"], [10, 1, "عید سعید فطر"],
      [10, 2, "تعطیلی به مناسبت عید سعید فطر"], [10, 25, "شهادت امام جعفر صادق"],
      [12, 10, "عید سعید قربان"], [12, 18, "عید سعید غدیر خم"],
    ],
    markers: [
      [1, 1, "آغاز سال مالی", "finance"], [3, -1, "پایان فصل اول (بهار)", "finance"], [6, -1, "پایان فصل دوم (تابستان)", "finance"],
      [9, -1, "پایان فصل سوم (پاییز)", "finance"], [12, -1, "پایان سال مالی", "finance"],
      [9, 30, "شب یلدا", "culture"],
    ],
    official: "تعطیل رسمی",
    predictedOfficial: "تعطیل رسمی — تاریخ پیش‌بینی‌شده؛ بسته به رؤیت هلال ممکن است یک روز جابه‌جا شود.",
    makeUpAr: "يوم عمل تعويضي",
  },
  ics: {
    name: "تقویم مالی",
    predicted: "تاریخ پیش‌بینی‌شده؛ بسته به رؤیت هلال یا اعلام رسمی ممکن است یک روز جابه‌جا شود.",
    words: {
      en: { expected: "expected", half: "half day", observed: "substitute day", official: "Official holiday.", announced: "Official holiday; date announced by the authority.",
        observedOf: "Substitute day for the holiday of {d}.", weekend: "Weekend", weekendNote: "Weekly rest days of the market.", holidays: "holidays",
        workdayNote: "Make-up working day: a weekend day that is a working day, set by the official holiday arrangements." },
      ar: { expected: "متوقع", half: "نصف يوم", observed: "يوم بديل", official: "عطلة رسمية.", announced: "عطلة رسمية؛ أعلنت الجهة المختصة تاريخها.",
        observedOf: "يوم بديل عن عطلة {d}.", weekend: "عطلة نهاية الأسبوع", weekendNote: "أيام الراحة الأسبوعية في السوق.", holidays: "العطل",
        workdayNote: "يوم عمل تعويضي: يوم من عطلة نهاية الأسبوع يصبح يوم عمل وفق الترتيبات الرسمية للعطل." },
      fa: { expected: "پیش‌بینی", half: "نیم‌روز", observed: "روز جایگزین", official: "تعطیل رسمی.", announced: "تعطیل رسمی؛ تاریخ را مرجع رسمی اعلام کرده است.",
        observedOf: "روز جایگزین تعطیلی {d}.", weekend: "تعطیل آخر هفته", weekendNote: "روزهای تعطیل هفتگی بازار.", holidays: "تعطیلات",
        workdayNote: "روز کاری جبرانی: روزی از تعطیل آخر هفته که طبق برنامهٔ رسمی تعطیلات کاری است." },
    },
  },
  picker: {
    predicted: "پیش‌بینی؛ ممکن است یک روز جابه‌جا شود",
    weekdayShort: ["ش", "ی", "د", "س", "چ", "پ", "ج"],
    dialog: "انتخاب تاریخ", open: "باز کردن تقویم", pick: "انتخاب از تقویم",
    prevYear: "سال قبل", prevMonth: "ماه قبل", nextMonth: "ماه بعد", nextYear: "سال بعد", today: "امروز", close: "بستن",
    holiday: "تعطیل: {titles}", weekend: "آخر هفته", disabled: "غیرقابل انتخاب", comma: "، ",
    chipPredicted: "تعطیل (پیش‌بینی)", chipOfficial: "تعطیل رسمی", chipWeekend: "آخر هفته", chipWork: "روز کاری",
    settle: "تسویه T+{t}: ",
    range: "از <bdi>{from}</bdi> تا <bdi>{to}</bdi>؛ {days} روز، {business} روز کاری",
    rangeEnd: "روز پایان را انتخاب کنید.",
  },
  cli: {
    business: "روز کاری", holiday: "تعطیل", weekend: "آخر هفته", predicted: "پیش‌بینی", predictedParen: "(پیش‌بینی)",
    businessDays: "{business} روز کاری از {calendar} روز تقویمی", invalid: "فرمان نامعتبر.",
  },
};

/** A template with {placeholders} filled from `vars` (a missing one is left visible, never dropped). */
export const fill = (template, vars = {}) => template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
