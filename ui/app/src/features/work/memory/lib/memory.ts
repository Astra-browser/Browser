/** Memory panel data + ranking (P6-T08 user controls: view / edit / delete). */

export type MemoryScopeName = "global" | "site" | "ephemeral" | (string & {});

export interface MemoryEntry {
  id: string;
  scope: MemoryScopeName;
  content: string;
  updatedAt: number;
  site?: string;
}

export interface RankedMemoryEntry {
  entry: MemoryEntry;
  rank: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const hay = haystack.toLowerCase();
  const ndl = needle.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const pos = hay.indexOf(ndl, from);
    if (pos < 0) return count;
    count += 1;
    from = pos + ndl.length;
  }
}

/**
 * Ranked memory search mirroring the store formula (`memory_search`):
 * `rank = 10 * content hits + 2 * scope hits + recency tiebreak`.
 * Blank queries return everything newest-first.
 */
export function searchMemories(
  entries: readonly MemoryEntry[],
  query: string,
): RankedMemoryEntry[] {
  const needle = query.trim().toLowerCase();
  const scored = entries
    .map((entry) => {
      const textScore = needle
        ? 10 * countOccurrences(entry.content, needle) + 2 * countOccurrences(entry.scope, needle)
        : 0;
      return {
        entry,
        rank: textScore + entry.updatedAt / 1e15,
      };
    })
    .filter(({ entry, rank }) => !needle || rank > entry.updatedAt / 1e15);
  scored.sort((a, b) => b.rank - a.rank || b.entry.updatedAt - a.entry.updatedAt);
  return scored;
}

/** Human label for a scope badge. Unknown scopes read back verbatim. */
export function scopeLabel(scope: MemoryScopeName): string {
  switch (scope) {
    case "global":
      return "Everywhere";
    case "site":
      return "This site";
    case "ephemeral":
      return "Scratch";
    default:
      return scope;
  }
}
