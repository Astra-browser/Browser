/**
 * Default search engines, configured locally.
 *
 * A static table compiled into the UI: nothing is downloaded, nothing is
 * requested over the network, and no remotely-hosted configuration is
 * consulted. Engine choice is a plain preference (`search.engine`); a custom
 * template (`search.custom-url`) may add one more. What Firefox ships for
 * its own search feature is never consulted.
 *
 * No `folder_context/` base snapshot exists in this tree, so this table is
 * defined here to match the engines the settings UI offers (Google,
 * DuckDuckGo, Bing, Brave Search). Adding an engine means adding a row, not
 * a network dependency.
 */

export const SEARCH_TEMPLATE_TOKEN = "{searchTerms}";

export type BuiltinEngineId = "duckduckgo" | "google" | "bing" | "brave";
export type SearchEngineId = BuiltinEngineId | "custom";

export interface SearchEngine {
  id: BuiltinEngineId;
  /** Shown in the omnibox row and the settings UI. */
  name: string;
  /** Must contain exactly one `{searchTerms}` token. */
  searchUrl: string;
  /** Suggestion endpoint in the engine's own list format, if it offers one. */
  suggestUrl?: string;
}

export const SEARCH_ENGINES: readonly SearchEngine[] = [
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    searchUrl: "https://duckduckgo.com/?q={searchTerms}",
    suggestUrl: "https://duckduckgo.com/ac/?q={searchTerms}&type=list",
  },
  {
    id: "google",
    name: "Google",
    searchUrl: "https://www.google.com/search?q={searchTerms}",
    suggestUrl: "https://suggestqueries.google.com/complete/search?client=chrome&q={searchTerms}",
  },
  {
    id: "bing",
    name: "Bing",
    searchUrl: "https://www.bing.com/search?q={searchTerms}",
    suggestUrl: "https://www.bing.com/osjson.aspx?query={searchTerms}",
  },
  {
    id: "brave",
    name: "Brave Search",
    searchUrl: "https://search.brave.com/search?q={searchTerms}",
    suggestUrl: "https://search.brave.com/api/suggest?q={searchTerms}",
  },
];

/** Ships as the default, mirroring the `search.engine` preference default. */
export const DEFAULT_ENGINE_ID: BuiltinEngineId = "duckduckgo";

export function getEngine(id: string): SearchEngine | null {
  return SEARCH_ENGINES.find((engine) => engine.id === id) ?? null;
}

/** Feedback only, mirroring `astra_core::search::valid_template` and the
 *  settings UI's inline check. The store remains the authority. */
export function isValidSearchTemplate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  if (trimmed.split(SEARCH_TEMPLATE_TOKEN).length !== 2) return false;
  try {
    const url = new URL(trimmed.replace(SEARCH_TEMPLATE_TOKEN, "astra-query"));
    return (
      url.protocol === "https:" &&
      url.search.includes("astra-query") &&
      !url.hostname.includes("astra-query")
    );
  } catch {
    return false;
  }
}

/** Fill a validated template with the encoded query. Returns `null` when the
 *  template is invalid, so callers never navigate to a half-built URL. */
export function fillSearchTemplate(template: string, query: string): string | null {
  if (!isValidSearchTemplate(template)) return null;
  return template.replace(SEARCH_TEMPLATE_TOKEN, encodeURIComponent(query));
}

/** The address the omnibox navigates to for `query` on `engine`. A custom
 *  engine resolves through `customUrl`; anything unresolvable is `null`. */
export function buildSearchUrl(
  engine: SearchEngine | null,
  customUrl: string,
  query: string,
): string | null {
  if (!query.trim()) return null;
  if (engine) return fillSearchTemplate(engine.searchUrl, query.trim());
  return fillSearchTemplate(customUrl, query.trim());
}

/** The suggestion endpoint for `query`, or `null` when the engine offers
 *  none. Fetching stays with the native provider; the UI only builds URLs. */
export function buildSuggestUrl(engine: SearchEngine | null, query: string): string | null {
  if (!engine?.suggestUrl || !query.trim()) return null;
  return engine.suggestUrl.replace(SEARCH_TEMPLATE_TOKEN, encodeURIComponent(query.trim()));
}
