// The content pack, keyed per locale: { en: { seriesId: items }, ar: { … } } (kit.config.js site.locales).
// A locale without its own pack publishes nothing; items with localized fields ({ en, ar }) work too.
import weekly from "./weekly.js";
import monthly from "./monthly.js";
import glossary from "./glossary.js";
import weeklyAr from "./ar/weekly.js";
import monthlyAr from "./ar/monthly.js";
import glossaryAr from "./ar/glossary.js";

export default {
  en: { weekly, monthly, daily: glossary },
  ar: { weekly: weeklyAr, monthly: monthlyAr, daily: glossaryAr },
};
