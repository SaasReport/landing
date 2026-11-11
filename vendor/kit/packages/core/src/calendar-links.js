/**
 * "Add to calendar" links that work everywhere: Google Calendar and Outlook take a URL (no file),
 * Apple Calendar opens an .ics file (eventIcs). A bare .ics download only works on Apple devices.
 */
const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]|\.\d+/g, "");
const day8 = (iso) => iso.slice(0, 10).replace(/-/g, "");
const nextDay = (iso) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

/** { title, start, end?, allDay?, details?, location?, timezone? } with ISO dates → { google, outlook, office } URLs. */
export function calendarLinks({ title, start, end, allDay = false, details = "", location = "", timezone } = {}) {
  const g = new URLSearchParams({ action: "TEMPLATE", text: title, details, location, ...(timezone ? { ctz: timezone } : {}),
    dates: allDay ? `${day8(start)}/${day8(end || nextDay(start))}` : `${stamp(start)}/${stamp(end || start)}` });
  const o = new URLSearchParams({ path: "/calendar/action/compose", rru: "addevent", subject: title, body: details, location,
    startdt: allDay ? start.slice(0, 10) : new Date(start).toISOString(), enddt: allDay ? (end ? end.slice(0, 10) : nextDay(start)) : new Date(end || start).toISOString(), ...(allDay ? { allday: "true" } : {}) });
  return {
    google: `https://calendar.google.com/calendar/render?${g}`,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?${o}`,
    office: `https://outlook.office.com/calendar/0/deeplink/compose?${o}`,
  };
}
/** calendarLinks with the site's time zone. */
export const calendarLinksFor = (config, event) => calendarLinks({ timezone: config.site.timezone, ...event });

const icsEsc = (s) => String(s ?? "").replace(/[\;,]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n");
const fold = (l) => { const enc = new TextEncoder(), out = []; let cur = ""; for (const ch of l) { if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ""; } cur += ch; } out.push(cur); return out.join("\r\n "); };
/** One event as an iCalendar file (PRODID names site.org.alternateName, else site.name). event: { slug, title, start, end?, allDay?, details?, location?, url?, status? } */
export function eventIcs(config, e, now = new Date()) {
  const host = new URL(config.site.url).host;
  const when = e.allDay
    ? [`DTSTART;VALUE=DATE:${day8(e.start)}`, `DTEND;VALUE=DATE:${day8(e.end || nextDay(e.start))}`]
    : [`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end || e.start)}`];
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${icsEsc(config.site.org?.alternateName || config.site.name)}//Events//${String(config.site.locale).split("-")[0].toUpperCase()}`, "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${e.slug || stamp(e.start)}@${host}`, `DTSTAMP:${stamp(now.toISOString())}`, ...when, `SUMMARY:${icsEsc(e.title)}`,
    ...(e.details ? [`DESCRIPTION:${icsEsc(e.details)}`] : []), ...(e.location ? [`LOCATION:${icsEsc(e.location)}`] : []),
    ...(e.url || e.slug ? [`URL:${e.url || `${config.site.url}${config.paths?.events || "/events/"}${e.slug}`}`] : []),
    `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT", "END:VCALENDAR"];
  return lines.map(fold).join("\r\n") + "\r\n";
}
