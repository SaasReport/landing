// Report periods. A scheduled run reports on the previous COMPLETE period before `at`, in UTC.
// Integer calendar arithmetic only (days from civil), no Date object, so it is deterministic everywhere.

const DAY = 86400;
const floorDiv = (a, b) => Math.floor(a / b);

/** Days since 1970-01-01 of a proleptic Gregorian date (month 1-12). */
export function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = floorDiv(y, 400);
  const yoe = y - era * 400;
  const doy = floorDiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

/** [year, month, day] of a day count since 1970-01-01. */
export function civilFromDays(z) {
  z += 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
  const mp = floorDiv(5 * doy + 2, 153);
  const d = doy - floorDiv(153 * mp + 2, 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
const addMonths = (y, m, n) => { const t = y * 12 + (m - 1) + n; return [floorDiv(t, 12), (t % 12 + 12) % 12 + 1]; };

/**
 * @param {string} cadence day | week | month | quarter | year
 * @param {number} at epoch seconds (the moment the run fires)
 * @returns {{cadence: string, from: number, to: number, label: string}} the period [from, to) in epoch seconds
 */
export function periodWindow(cadence, at) {
  if (!Number.isSafeInteger(at)) throw new RangeError("at must be integer epoch seconds");
  const today = floorDiv(at, DAY);
  const [y, m] = civilFromDays(today);
  let startDay, endDay, label;
  if (cadence === "day") {
    startDay = today - 1; endDay = today;
    const [yy, mm, dd] = civilFromDays(startDay);
    label = `${yy}-${pad(mm)}-${pad(dd)}`;
  } else if (cadence === "week") {
    const monday = today - ((today + 3) % 7 + 7) % 7; // 1970-01-01 was a Thursday
    startDay = monday - 7; endDay = monday;
    const thursday = startDay + 3;
    const [iy] = civilFromDays(thursday);
    label = `${iy}-W${pad(floorDiv(thursday - daysFromCivil(iy, 1, 1), 7) + 1)}`;
  } else if (cadence === "month") {
    const [py, pm] = addMonths(y, m, -1);
    startDay = daysFromCivil(py, pm, 1); endDay = daysFromCivil(y, m, 1);
    label = `${py}-${pad(pm)}`;
  } else if (cadence === "quarter") {
    const qStartMonth = floorDiv(m - 1, 3) * 3 + 1;
    const [py, pm] = addMonths(y, qStartMonth, -3);
    startDay = daysFromCivil(py, pm, 1); endDay = daysFromCivil(y, qStartMonth, 1);
    label = `${py}-Q${floorDiv(pm - 1, 3) + 1}`;
  } else if (cadence === "year") {
    startDay = daysFromCivil(y - 1, 1, 1); endDay = daysFromCivil(y, 1, 1);
    label = `${y - 1}`;
  } else throw new RangeError(`unknown cadence ${cadence}`);
  return { cadence, from: startDay * DAY, to: endDay * DAY, label };
}
