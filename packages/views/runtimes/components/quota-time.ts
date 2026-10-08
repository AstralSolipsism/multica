import { useCallback } from "react";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import { useT } from "../../i18n";

const DAY_KEY_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};

// Quota times (resets, last collection) read as wall-clock times in the
// viewer's timezone: time only on the viewer's current day, month and day
// otherwise. The wording (24-hour dial, month names) follows the UI locale.
export function formatQuotaTime(
  epochSec: number,
  nowMs: number,
  timeZone: string,
  locale: string,
): string {
  const at = new Date(epochSec * 1000);
  const sameDay = dayKey(at, timeZone) === dayKey(new Date(nowMs), timeZone);
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(at);
  } catch {
    // A zone this runtime's ICU data lacks degrades to local time.
    return new Intl.DateTimeFormat(locale, options).format(at);
  }
}

function dayKey(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { ...DAY_KEY_OPTIONS, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", DAY_KEY_OPTIONS).format(date);
  }
}

/** Formats quota times in the viewer's timezone (the stored preference, else
 *  the browser's) and the active UI language. */
export function useQuotaTimeFormatter(): (epochSec: number, nowMs: number) => string {
  const { i18n } = useT("quota");
  const timeZone = useViewingTimezone();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return useCallback(
    (epochSec: number, nowMs: number) => formatQuotaTime(epochSec, nowMs, timeZone, locale),
    [timeZone, locale],
  );
}
