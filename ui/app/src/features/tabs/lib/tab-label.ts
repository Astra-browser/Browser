/** What a row calls a tab before its site has supplied a title: the host it is
 *  loading. A row with neither still has to read as a row, so it says so
 *  rather than rendering a blank line. */
export function tabLabel(tab: { title: string; url?: string | null }, untitled: string): string {
  if (tab.title) return tab.title;
  return hostOf(tab.url) || untitled;
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.host.replace(/^www\./u, "");
  } catch {
    return "";
  }
}
