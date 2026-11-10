/**
 * The Home field's value: a web address the stage can actually load.
 *
 * A bare host is what people type ("example.com"), so it becomes https. Words
 * are not a home page (the Home control must not silently search) and neither
 * are schemes the stage cannot show; both are invalid instead of being saved.
 */
export function normalizeHomeUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (/^https?:\/\/\S+$/iu.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+([/?#]\S*)?$/u.test(trimmed)) return `https://${trimmed}`;
  return null;
}
