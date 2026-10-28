/* @saasreport/calendar/chinese — the Chinese lunisolar calendar (农历) and the Qingming solar term, for the holidays of
   markets that follow them (China, Singapore, and anyone who registers a profile with them).

   The data is derived from the Hong Kong Observatory's Gregorian–lunar calendar conversion tables
   (https://www.hko.gov.hk/en/gts/time/conversion.htm, one table per year, 1901–2100, read 2026-10-01), which give
   every lunar month start and every solar term in UTC+8, the time zone of the Chinese calendar. For each lunar year
   from 1901 to 2099 it keeps one 5-digit hex number: the leap month (0 = none) times 2^13, plus a bit per month
   (in order, the leap month after the month it repeats) that is set when the month has 30 days. Lunar New Year 1901
   was 1901-02-19; every later one follows from the month lengths. QINGMING keeps the April day of the Qingming
   (清明, "Bright and Clear") solar term for 1901–2100.

   These are astronomical dates. The holidays built on them are still `predicted` in markets.js until the authority
   publishes the year's list, because it decides the break around them. */
const DAY = 86400000;
export const LUNAR_RANGE = Object.freeze({ from: 1901, to: 2099 });
const FIRST = Math.floor(Date.UTC(1901, 2 - 1, 19) / DAY); // 1901-02-19, lunar New Year 1901
const DATA =
  "0075200ea50b64a0064b00a9b095560056a00b5905752007520db2500b2500a4b0b4ab002ad0056b04b6900da90fd9200e92" +
  "00d250ba4d00a56002b6095b5006d400ea905e9200e920cd260052b00a570b2b600b5a006d406ec9007490f69300a930052b" +
  "0ca5b00aad0056a09b5500ba400b4905a9300a950f52d0053600aad0b5aa005b200da507d4a00d4a10a9500a97005560cab5" +
  "00ad5006d208ea500ea50064a06c9700a9b0f55a0056a00b690b75200b5200b250964b00a4b114ab002ad0056d0cb6900da9" +
  "00d9209d2500d2515a4d00a56002b60c5b5006d500ea90be9200e9200d2606a5600a57114d60035a006d50b6c90074900693" +
  "0952b0052b00a5b0555a0056a0fb5500ba400b490ba9300a950052d08aad00ab5135aa005d200da50dd4a00d4a00c950952e" +
  "0055600ab5055b2006d20cea5007250064b0ac9700cab0055a06ad600b691775200b5200b250da4b00a4b004ab0a55b005ad" +
  "00b6a05b5200d920fd2500d2500a550b4ad004b6005b506daa00ec911e9200e9200d260ca5600a5700556086d50075500749" +
  "06e93006930f52b0052b00a5b0b55a0056a00b650974a00b4a11a9500a950052d0caad00ab5005aa08ba500da500d4a07c95" +
  "00c960f94e0055600ab50b5b2006d200ea508e4a0068b10c97004ab0055b0cad600b6a007520972500b4500a8b0549b";
const QINGMING =
  "5665566556655565556555655565556555655565556555555555555555555555555555555554555455545554555455545554" +
  "5554555445544554455445544554455445544554445444544454445444544454445444544444444444444444444444444445"; // 1901–2100

const info = (ly) => parseInt(DATA.slice((ly - LUNAR_RANGE.from) * 5, (ly - LUNAR_RANGE.from) * 5 + 5), 16);
/** Leap month of lunar year ly (0 when it has none). */
export const leapMonth = (ly) => (ly >= LUNAR_RANGE.from && ly <= LUNAR_RANGE.to ? info(ly) >> 13 : 0);
/** The months of lunar year ly in order: [{ month, leap, length }] (12 or 13 entries). */
export function lunarMonths(ly) {
  if (!Number.isInteger(ly) || ly < LUNAR_RANGE.from || ly > LUNAR_RANGE.to) return null;
  const v = info(ly), leap = v >> 13, out = [];
  for (let m = 1, i = 0; m <= 12; m++) {
    out.push({ month: m, leap: false, length: v & (1 << i++) ? 30 : 29 });
    if (m === leap) out.push({ month: m, leap: true, length: v & (1 << i++) ? 30 : 29 });
  }
  return out;
}
const STARTS = [FIRST];
/** Day number (days since 1970-01-01) of lunar New Year (正月初一) of lunar year ly, or null outside the table. */
export function lunarNewYear(ly) {
  if (!Number.isInteger(ly) || ly < LUNAR_RANGE.from || ly > LUNAR_RANGE.to + 1) return null;
  for (let y = LUNAR_RANGE.from + STARTS.length - 1; STARTS.length <= ly - LUNAR_RANGE.from; y++) STARTS.push(STARTS.at(-1) + lunarMonths(y).reduce((s, m) => s + m.length, 0));
  return STARTS[ly - LUNAR_RANGE.from];
}
/** Day number of lunar date (ly, lm, ld): ld is 1–30 or "last"; leap: true for the leap month. Null when the date
 *  does not exist (a 30th in a 29-day month, a leap month the year does not have) or is outside the table. */
export function fromLunar(ly, lm, ld, { leap = false } = {}) {
  const ms = lunarMonths(ly);
  if (!ms) return null;
  let n = lunarNewYear(ly);
  for (const m of ms) {
    if (m.month === lm && m.leap === !!leap) {
      const d = ld === "last" ? m.length : ld;
      return Number.isInteger(d) && d >= 1 && d <= m.length ? n + d - 1 : null;
    }
    n += m.length;
  }
  return null;
}
/** Lunar date of day n: { ly, lm, ld, leap }, or null outside the table. */
export function toLunar(n) {
  let ly = new Date(n * DAY).getUTCFullYear();
  if (lunarNewYear(ly) == null || n < lunarNewYear(ly)) ly--;
  if (ly < LUNAR_RANGE.from || ly > LUNAR_RANGE.to) return null;
  let d = n - lunarNewYear(ly);
  for (const m of lunarMonths(ly)) { if (d < m.length) return { ly, lm: m.month, ld: d + 1, leap: m.leap }; d -= m.length; }
  return null;
}
/** Day number of the Qingming solar term (清明) in Gregorian year gy (1901–2100), or null. */
export function qingming(gy) {
  if (!Number.isInteger(gy) || gy < 1901 || gy > 2100) return null;
  return Math.floor(Date.UTC(gy, 3, +QINGMING[gy - 1901]) / DAY);
}
