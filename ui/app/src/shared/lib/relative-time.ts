const DAY = 86_400_000;

function startOfDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * A short phrase for when a local index was refreshed. Seconds and minutes
 * while they are useful, then the same day words the rest of the app uses.
 * `justNow` is passed by the caller so this module owns no product copy.
 */
export function timeAgo(
  at: number,
  {
    now = Date.now(),
    locale,
    justNow = "",
  }: { now?: number; locale?: string; justNow?: string } = {},
): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return justNow;
  if (seconds < 60) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-seconds, "second");
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-minutes, "minute");
  }
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days > -7) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
}
