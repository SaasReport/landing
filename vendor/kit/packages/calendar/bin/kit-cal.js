#!/usr/bin/env node
/* kit-cal — @saasreport/calendar on the command line. Runs the embedded engine; no network.
   kit-cal today | day <date> | month [y m] | holidays [y] | business-days <from> <to>
          settle <date> [--t 1] | add <date> <days> [--calendar] | adjust <date> [--convention c]
          schedule <start> --count 12 --amount 1200000000 [--convention c]
   Common: --profile bank|government|market   --json */
import * as C from "../src/index.js";
import { COPY, fill } from "../src/copy.js";
const L = COPY.cli;

const argv = process.argv.slice(2), flags = {}, args = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const k = a.slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; } else args.push(a); }
const o = flags.profile ? { profile: flags.profile } : {};
const line = (n) => { const d = C.describe(n, o); return `${d.jalali.long}  (${d.iso})  ${d.business ? L.business : d.holiday ? L.holiday : L.weekend}${d.uncertain ? ` · ${L.predicted}` : ""}${d.events.length ? "  — " + d.events.map((e) => e.title).join("، ") : ""}`; };
const out = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);
const [cmd = "today", ...rest] = args;
try {
  switch (cmd) {
    case "today": { const n = C.today(); out(C.describe(n, o), line(n)); break; }
    case "day": { const n = C.parseDate(rest[0]); out(C.describe(n, o), line(n)); break; }
    case "month": { const t = C.toJalali(C.today()); const m = C.month(+(rest[0] || t.jy), +(rest[1] || t.jm), o); const days = m.cells.filter((c) => c.inMonth); out(days, [m.title, ...days.map((c) => line(c.date))].join("\n")); break; }
    case "holidays": { const y = +(rest[0] || C.toJalali(C.today()).jy); const h = C.holidays(y); out(h, h.map((x) => `${C.describe(x.date).jalali.text}  ${x.title}${x.status === "predicted" ? `  ${L.predictedParen}` : ""}`).join("\n")); break; }
    case "business-days": { const r = C.businessDaysBetween(C.parseDate(rest[0]), C.parseDate(rest[1]), o); out(r, `${fill(L.businessDays, { business: r.business, calendar: r.calendar })}${r.uncertain ? ` ${L.predictedParen}` : ""}`); break; }
    case "settle": { const r = C.settlement(C.parseDate(rest[0]), +(flags.t ?? 1), o); out(r, `T+${flags.t ?? 1}: ${line(r.date)}`); break; }
    case "add": { const r = C.deadline(C.parseDate(rest[0]), +rest[1], flags.calendar ? "calendar" : "business", o); out(r, line(r.date)); break; }
    case "adjust": { const r = C.adjust(C.parseDate(rest[0]), flags.convention || "following", o); out(r, line(r.date)); break; }
    case "schedule": { const rows = C.schedule({ start: rest[0], count: +(flags.count || 12), amount: +(flags.amount || 0), convention: flags.convention || "following", ...o }); out(rows, rows.map((r) => `${String(r.n).padStart(3)}  ${C.describe(r.scheduled).jalali.text} → ${line(r.due)}  ${r.amount.toLocaleString("en")} IRR`).join("\n")); break; }
    default: console.error(`${L.invalid} kit-cal today | day | month | holidays | business-days | settle | add | adjust | schedule`); process.exit(2);
  }
} catch (e) { console.error(e.message); process.exit(1); }
