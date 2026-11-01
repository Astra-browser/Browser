/**
 * Omnibox model: suggestions from open tabs, history and notes, plus the
 * search-engine action for what was typed.
 *
 * Pure functions over plain data so the address bar ranks synchronously
 * (typing budget: suggestions render <100ms on the fixture set). Live
 * fetching — remote suggestions, native history reads — stays behind the
 * bridge; this module only shapes rows the UI already holds.
 *
 * Section order is fixed: tabs, then history, then notes, then the search
 * action. A source never promotes above an earlier one, so a late answer
 * cannot reorder rows the user is already reading.
 */

import { rank } from "./ranking";
import { getEngine, buildSearchUrl, type SearchEngine } from "./engines";

export type OmniboxSource = "tabs" | "history" | "notes";

export interface OmniboxSourceItem {
  id: string;
  title: string;
  /** Full address; notes carry their `note://` id here. */
  url: string;
  /** One line explaining the match (host for visits, snippet for notes). */
  detail?: string;
}

export interface OmniboxSuggestion {
  id: string;
  source: OmniboxSource | "search";
  title: string;
  detail: string;
  url: string;
  score: number;
  engine: SearchEngine | null;
}

export interface OmniboxSources {
  tabs: readonly OmniboxSourceItem[];
  history: readonly OmniboxSourceItem[];
  notes: readonly OmniboxSourceItem[];
}

export interface OmniboxLimits {
  tabs: number;
  history: number;
  notes: number;
}

export const DEFAULT_LIMITS: OmniboxLimits = { tabs: 4, history: 4, notes: 3 };

const SECTION_ORDER: readonly OmniboxSource[] = ["tabs", "history", "notes"];

/** Bare host for row detail; never echoes a full address into chrome. */
export function hostOf(value: string): string {
  try {
    return new URL(value).host.replace(/^www\./u, "");
  } catch {
    return value.replace(/^www\./u, "");
  }
}

function takeSection(
  query: string,
  source: OmniboxSource,
  items: readonly OmniboxSourceItem[],
  limit: number,
  seen: Set<string>,
): OmniboxSuggestion[] {
  return rank(query, items, (item) => `${item.title} ${hostOf(item.url)}`)
    .filter(({ value }) => {
      // One address appears once; the earlier section (tabs first) wins.
      const key = value.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ value, score }) => ({
      id: `${source}:${value.id}`,
      source,
      title: value.title,
      detail: value.detail ?? hostOf(value.url),
      url: value.url,
      score,
      engine: null,
    }));
}

/** Rows for `query` in section order, ending with the engine search action. */
export function collectOmniboxSuggestions(
  query: string,
  sources: OmniboxSources,
  options: {
    engineId: string;
    customUrl?: string;
    limits?: Partial<OmniboxLimits>;
  },
): OmniboxSuggestion[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const seen = new Set<string>();
  const rows = SECTION_ORDER.flatMap((source) =>
    takeSection(trimmed, source, sources[source], limits[source], seen),
  );
  const engine = getEngine(options.engineId);
  const url = buildSearchUrl(engine, options.customUrl ?? "", trimmed);
  if (url) {
    rows.push({
      id: `search:${engine?.id ?? "custom"}:${trimmed}`,
      source: "search",
      title: trimmed,
      detail: engine ? engine.name : "Custom search",
      url,
      score: Number.MIN_SAFE_INTEGER,
      engine,
    });
  }
  return rows;
}

/** Inline completion the field may apply: the offered host, accepted only
 *  when it strictly extends exactly what is typed. */
export function completionSuffix(typed: string, completion: string | null): string | null {
  if (!completion || !typed.trim()) return null;
  if (!completion.toLowerCase().startsWith(typed.toLowerCase())) return null;
  if (completion.length <= typed.length) return null;
  return completion.slice(typed.length);
}

export type OmniboxSelection = number;
/** `-1` is the typed row (the search action / current text); rows follow. */

/** Move selection with the surface's no-wrap semantics: past the top returns
 *  to the typed row, past the bottom stays put so holding a key never cycles. */
export function moveSelection(
  count: number,
  current: OmniboxSelection,
  key: "down" | "up" | "home" | "end",
): OmniboxSelection {
  if (count <= 0) return -1;
  switch (key) {
    case "down":
      return current + 1 >= count ? count - 1 : current + 1;
    case "up":
      return Math.max(-1, current - 1);
    case "home":
      return -1;
    case "end":
      return count - 1;
  }
}

/** Id of the active row: the typed row or the suggestion at the index. */
export function selectedId(
  suggestions: readonly OmniboxSuggestion[],
  selection: OmniboxSelection,
): string {
  if (selection < 0 || selection >= suggestions.length) return "typed";
  return suggestions[selection]!.id;
}
