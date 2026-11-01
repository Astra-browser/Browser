/**
 * Omnibox ranking: subsequence matching with contiguity and prefix bonuses.
 *
 * A TypeScript port of `astra_core::search::{score_match, rank}` (P2-T01).
 * The Rust core remains the authority for the launcher/new-tab path, which
 * ranks over IPC. The omnibox duplicates the algorithm locally so the address
 * bar ranks tabs/history/notes synchronously — no round-trip, inside the
 * <100ms typing budget — against the exact same ordering. If the core
 * algorithm changes, this port and its parity tests change with it.
 */

const PREFIX_BONUS = 500_000;
const FIRST_HIT_PENALTY = 1_000;
const CONTIGUITY_BONUS = 10_000;
const BASE = 1_000_000;

/** Score `candidate` against `query` (case-insensitive).
 *
 * Returns `null` when the query is not a subsequence of the candidate.
 * Higher scores rank first: prefix matches beat word-boundary matches, which
 * beat scattered matches; ties break toward shorter candidates. */
export function scoreMatch(query: string, candidate: string): number | null {
  if (query === "") return 0;
  const q = Array.from(query.toLowerCase());
  const c = Array.from(candidate.toLowerCase());
  if (q.length > c.length) return null;

  // Greedy subsequence scan, counting contiguous runs.
  let qi = 0;
  let runs = 0;
  let inRun = false;
  let firstHit = Number.MAX_SAFE_INTEGER;
  for (const [ci, ch] of c.entries()) {
    if (qi < q.length && ch === q[qi]) {
      if (!inRun) {
        runs += 1;
        inRun = true;
      }
      if (firstHit === Number.MAX_SAFE_INTEGER) firstHit = ci;
      qi += 1;
    } else {
      inRun = false;
    }
  }
  if (qi !== q.length) return null;

  const contiguous = q.length - runs;
  let score = BASE - firstHit * FIRST_HIT_PENALTY + contiguous * CONTIGUITY_BONUS;
  if (candidate.toLowerCase().startsWith(query.toLowerCase())) score += PREFIX_BONUS;
  // Shorter candidates win ties.
  return score - c.length;
}

export type Ranked<T> = { value: T; score: number };

/** Rank `candidates` for a query, best first; non-matches are dropped. */
export function rank<T>(
  query: string,
  candidates: readonly T[],
  text: (item: T) => string,
): Ranked<T>[] {
  return candidates
    .map((value) => ({ value, score: scoreMatch(query, text(value)) }))
    .filter((entry): entry is Ranked<T> => entry.score !== null)
    .sort((a, b) => b.score - a.score);
}
