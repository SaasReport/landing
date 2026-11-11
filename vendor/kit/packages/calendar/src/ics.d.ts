/** @saasreport/calendar/ics — RFC 5545 holiday feeds for every market profile (markets.js). */
import type { MarketId } from "./markets.js";
export interface MarketIcsOptions {
  /** Gregorian years or ISO dates (YYYY-MM-DD), inclusive. Default: this Gregorian year and the next, at `now` in the market's zone. At most 10 years. */
  from?: number | string; to?: number | string;
  /** UID prefix: the site's own (e.g. "example-"). Letters, digits, ".", "_", "-". Default "cal-". */ uidPrefix?: string;
  /** Right-hand side of every UID (the site's host). Default "calendar.invalid". */ domain?: string;
  /** NAME / X-WR-CALNAME. Default "<market name> holidays". */ name?: string;
  /** DESCRIPTION / X-WR-CALDESC. */ description?: string;
  /** "en" (default), "ar" or "fa": holiday titles, the "(expected)" label and notes. */ locale?: string;
  /** Also emit weekly all-day weekend events (one RRULE per weekend definition in the range; make-up working days are EXDATEs). Default false. */ weekends?: boolean;
  /** Emit make-up working days (weekend days that are working days) as "Working day (make-up for …)" events, CATEGORIES WORKDAY. Default true. */ workdays?: boolean;
  /** The feed's own URL (URL and SOURCE properties). */ url?: string;
  /** ISO 8601 duration for REFRESH-INTERVAL and X-PUBLISHED-TTL. Default "P1D". */ refresh?: string;
  /** DTSTAMP override. Default: the profile's data version date, so the body only changes when the data does. */ stamp?: Date | string | number;
  prodid?: string; now?: Date | number;
}
/** One market's holidays as iCalendar text (CRLF, folded at 75 octets). Predicted (Islamic or Chinese-calendar) holidays are STATUS:TENTATIVE
 *  with "(expected)" in the summary and CATEGORIES EXPECTED; announced and fixed ones are CONFIRMED. All-day dates are
 *  floating (VALUE=DATE). UIDs: "<uidPrefix><market>-h<hijriYear>-<rule>-<k>@<domain>" for Hijri holidays (stable when
 *  the date moves), "<uidPrefix><market>-<yyyymmdd>-<rule>@<domain>" otherwise. Throws MarketError ("unknown_market",
 *  "invalid_range", "invalid_option"). */
export declare function marketIcs(id: MarketId, options?: MarketIcsOptions): string;
/** Is `id` a known market profile (servable as a feed)? */
export declare function hasMarketFeed(id: string): boolean;
/** RFC 5545 TEXT escaping. */
export declare function escapeText(s: unknown): string;
/** Fold one content line at 75 octets (never inside a UTF-8 character). */
export declare function foldLine(line: string): string;
/** Content lines → folded, CRLF-terminated iCalendar text. */
export declare function icsText(lines: string[]): string;
