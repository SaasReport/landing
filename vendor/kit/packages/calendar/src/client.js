/* @saasreport/calendar — HTTP client for services that prefer a hosted calendar API over the embedded engine.
   const cal = new KitCalendarClient({ baseUrl: "https://example.org" });  await cal.settlement("1404/12/28", { t: 1 }); */
export class KitCalendarClient {
  constructor({ baseUrl, fetch: f = globalThis.fetch, profile } = {}) {
    if (!baseUrl) throw new Error("KitCalendarClient: baseUrl is required (the site that serves /api/calendar/*)");
    this.base = baseUrl.replace(/\/$/, ""); this.fetch = f; this.profile = profile;
  }
  async #get(path, params = {}) {
    const q = new URLSearchParams(Object.entries({ profile: this.profile, ...params }).filter(([, v]) => v != null && v !== ""));
    const r = await this.fetch(`${this.base}/api/calendar/${path}${q.size ? "?" + q : ""}`, { headers: { accept: "application/json" } });
    const body = await r.json();
    if (!body.ok) { const e = new Error(body.error?.message || `HTTP ${r.status}`); e.code = body.error?.code; e.status = r.status; throw e; }
    return body.data;
  }
  today() { return this.#get("today"); }
  day(date) { return this.#get("day", { date }); }
  month(year, month) { return this.#get("month", { year, month }); }
  holidays(year) { return this.#get("holidays", { year }); }
  businessDays(from, to) { return this.#get("business-days", { from, to }); }
  add(date, days, type = "business") { return this.#get("add", { date, days, type }); }
  adjust(date, convention = "following") { return this.#get("adjust", { date, convention }); }
  settlement(date, { t = 1 } = {}) { return this.#get("settlement", { date, t }); }
  schedule({ start, count, amount, convention, day, interval }) { return this.#get("schedule", { start, count, amount, convention, day, interval }); }
}
