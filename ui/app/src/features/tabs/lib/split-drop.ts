/**
 * A tab dragged onto the middle of another tab means "show these two beside
 * each other". The top and bottom quarters stay placement zones, so grabbing a
 * row to reorder it never starts a split by accident.
 */
export function splitDropTarget({
  dragged,
  over,
  x,
  y,
  enabled,
  canJoin,
}: {
  dragged: string;
  over: Element | null;
  x: number;
  y: number;
  enabled: boolean;
  canJoin: (target: string) => boolean;
}): string | null {
  if (!enabled || !dragged) return null;
  const row = over?.closest<HTMLElement>("[data-astra-tab-id]");
  const target = row?.dataset.astraTabId ?? "";
  if (!row || !target || target === dragged) return null;
  const rect = row.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const inset = Math.min(24, rect.width * 0.15);
  const inside =
    x >= rect.left + inset &&
    x <= rect.right - inset &&
    y >= rect.top + rect.height * 0.25 &&
    y <= rect.bottom - rect.height * 0.25;
  return inside && canJoin(target) ? target : null;
}
