/** Helper (parallel sub-agent) list model for the Work surface (P6-T05).
 *
 * Mirrors the Rust `helpers.rs` record at the UI boundary: one entry per
 * helper run with its own container, its source pane, budgets, and usage.
 * Pure functions only, so the unit suite runs without a browser.
 */

export type HelperStatus =
  "pending" | "running" | "succeeded" | "cancelled" | "failed" | "budget-exhausted";

export interface HelperBudget {
  maxSteps: number;
  maxTokens: number;
  /** Maximum wall time in milliseconds from spawn. */
  maxWallMs: number;
}

export interface HelperEntry {
  id: string;
  parentRunId: string;
  goal: string;
  /** Own container id minted at spawn; null once torn down. */
  containerId: string | null;
  /** Visible pane showing this helper's live page. Deterministic. */
  paneId: string;
  status: HelperStatus;
  stepsUsed: number;
  tokensUsed: number;
  budget: HelperBudget;
  endReason?: string | null;
}

/** Source pane id for a helper: `helper-pane-<id>`. */
export function helperPaneId(id: string): string {
  return `helper-pane-${id}`;
}

/** True while the entry holds a live container. */
export function isLiveHelper(status: HelperStatus): boolean {
  return status === "pending" || status === "running";
}

/** True once the entry reached a terminal state. */
export function isTerminalHelper(status: HelperStatus): boolean {
  return !isLiveHelper(status);
}

/** Entries still holding live containers, in list order. */
export function liveHelpers(helpers: readonly HelperEntry[]): HelperEntry[] {
  return helpers.filter((helper) => isLiveHelper(helper.status));
}

/** One-line budget readout, e.g. "50 steps · 32k tokens · 5m". */
export function budgetLabel(budget: HelperBudget): string {
  const tokens =
    budget.maxTokens >= 1000 ? `${Math.round(budget.maxTokens / 1000)}k` : `${budget.maxTokens}`;
  const wall =
    budget.maxWallMs >= 60000
      ? `${Math.round(budget.maxWallMs / 60000)}m`
      : `${Math.round(budget.maxWallMs / 1000)}s`;
  return `${budget.maxSteps} steps · ${tokens} tokens · ${wall}`;
}

/** One-line usage readout against the budget, e.g. "3/50 steps · 1.2k/32k tokens". */
export function usageLabel(helper: HelperEntry): string {
  const tokens = (n: number) => (n >= 1000 ? `${parseFloat((n / 1000).toFixed(1))}k` : `${n}`);
  return `${helper.stepsUsed}/${helper.budget.maxSteps} steps · ${tokens(helper.tokensUsed)}/${tokens(helper.budget.maxTokens)} tokens`;
}

/** Human status line for the list row. */
export function statusLabel(helper: HelperEntry): string {
  switch (helper.status) {
    case "pending":
      return "Starting…";
    case "running":
      return "Working…";
    case "succeeded":
      return "Done";
    case "cancelled":
      return helper.endReason ? `Cancelled — ${helper.endReason}` : "Cancelled";
    case "failed":
      return helper.endReason ? `Failed — ${helper.endReason}` : "Failed";
    case "budget-exhausted":
      return helper.endReason ? `Stopped — ${helper.endReason}` : "Stopped — budget exhausted";
  }
}

/** A new entry for a spawned helper, before its first step. */
export function newHelperEntry(
  id: string,
  parentRunId: string,
  goal: string,
  budget: HelperBudget,
): HelperEntry {
  return {
    id,
    parentRunId,
    goal,
    containerId: null,
    paneId: helperPaneId(id),
    status: "pending",
    stepsUsed: 0,
    tokensUsed: 0,
    budget,
  };
}
