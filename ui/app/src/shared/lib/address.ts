/**
 * Whether a line typed into a search or address box names an address rather
 * than words. Mirrors the host's `resolve` in `overlay/astra/host/Search.sys.mjs`
 * so the field can open it at once, without waiting for the host's row list.
 *
 * A leading `!` is a search shortcut (`!g …`), never an address. A colon that
 * is not a host:port (`10:30`, `note: buy milk`) is words.
 */
export function looksLikeAddress(input: string): boolean {
  const text = input.trim();
  if (text === "" || text.startsWith("!")) return false;
  // The schemes the address bar runs, plus the one inert internal page.
  if (/^https?:\/\//iu.test(text)) return true;
  if (/^about:blank(?:[?#].*)?$/iu.test(text)) return true;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#][^\s]*)?$/iu.test(text)) return true;
  if (/^[^\s/:]+\.[^\s/:]+:\d{1,5}(?:[/?#][^\s]*)?$/iu.test(text)) return true;
  return /^[^\s/]+\.[^\s/]+/u.test(text) && !text.includes(" ");
}

/** Whether the line opens with a scheme (`http:`, `mailto:`, `javascript:`).
 *  A field suppresses suggestions for these: the host decides which schemes
 *  may run, and the rest are still searched rather than offered. */
export function hasScheme(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(input.trim());
}
