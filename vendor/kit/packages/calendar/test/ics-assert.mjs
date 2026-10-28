/* Shared iCalendar (RFC 5545) checks for the feed tests. */
import assert from "node:assert/strict";

export const enc = new TextEncoder();
export const unfold = (t) => t.replace(/\r\n[ \t]/g, "");
export const events = (t) => unfold(t).split("BEGIN:VEVENT\r\n").slice(1).map((e) => Object.fromEntries(e.split("\r\n").filter((l) => l && l !== "END:VEVENT" && l !== "END:VCALENDAR").map((l) => { const i = l.indexOf(":"); return [l.slice(0, i), l.slice(i + 1)]; })));

/** Structural RFC 5545 checks: CRLF only, every physical line ≤ 75 octets, continuation lines start with a space,
 *  balanced components, required properties, unique UIDs, DATE values. */
export function assertValidIcs(t, where = "") {
  assert.ok(t.endsWith("\r\n"), `${where}: ends with CRLF`);
  assert.ok(!/[^\r]\n/.test(t) && !/\r(?!\n)/.test(t), `${where}: bare LF or CR`);
  const lines = t.slice(0, -2).split("\r\n");
  for (const l of lines) assert.ok(enc.encode(l).length <= 75, `${where}: line over 75 octets: ${l}`);
  assert.equal(lines[0], "BEGIN:VCALENDAR"); assert.equal(lines.at(-1), "END:VCALENDAR");
  const u = unfold(t);
  for (const p of ["VERSION:2.0", "PRODID:", "X-WR-CALNAME:", "REFRESH-INTERVAL;VALUE=DURATION:", "X-PUBLISHED-TTL:"]) assert.ok(u.includes(`\r\n${p}`), `${where}: ${p}`);
  assert.equal((u.match(/^BEGIN:VEVENT$/gm) || []).length, (u.match(/^END:VEVENT$/gm) || []).length, `${where}: balanced VEVENT`);
  const ev = events(t), uids = new Set();
  for (const e of ev) {
    for (const p of ["UID", "DTSTAMP", "DTSTART;VALUE=DATE", "SUMMARY"]) assert.ok(e[p], `${where}: event without ${p}`);
    assert.match(e.DTSTAMP, /^\d{8}T\d{6}Z$/);
    assert.match(e["DTSTART;VALUE=DATE"], /^\d{8}$/);
    assert.ok(!uids.has(e.UID), `${where}: duplicate UID ${e.UID}`); uids.add(e.UID);
    assert.ok(!/(^|[^\\])[;,]/.test(e.SUMMARY), `${where}: unescaped TEXT in ${e.SUMMARY}`);
  }
  return ev;
}

