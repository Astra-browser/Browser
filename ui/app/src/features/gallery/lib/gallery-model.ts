import * as m from "$shared/i18n/messages";
import { timeAgo } from "$shared/lib/relative-time";

const DAY = 86_400_000;

/** Midnight of the day a timestamp falls on, in the reader's own time zone. */
function startOfDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * "today", "yesterday", "3 days ago", then a short date. The viewer's date is
 * a description of the file, not a clock: a picture saved last month should
 * not claim a minute ago because it was copied.
 */
export function relativeDay(at: number, now = Date.now(), locale?: string): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days === 0) return m.gallery_today();
  if (days === -1) return m.gallery_yesterday();
  if (days > -7) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
}

/** A short "updated" phrase for the status line under the grid. */
export function relativeUpdate(at: number | null, now = Date.now(), locale?: string): string {
  if (!at) return "";
  return timeAgo(at, { now, locale, justNow: m.gallery_just_now() });
}

/** "Open in Photos" when the OS names a handler, else just "Open". */
export function openLabel(opener: string): string {
  const name = String(opener ?? "").trim();
  return name ? m.gallery_open_in({ app: name }) : m.gallery_open();
}

/** The count line, singular or plural. */
export function countLabel(count: number): string {
  return count === 1 ? m.gallery_count_one() : m.gallery_count({ count });
}

/** A folder label for the filter: the default name, then the folder's own. */
export function folderLabel(path: string, known: { path: string; label: string }[]): string {
  return known.find((row) => row.path === path)?.label ?? path.split(/[\\/]/u).pop() ?? path;
}
