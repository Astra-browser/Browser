import type { TabView } from "$shared/ipc/bindings";

/** The rail's five utility entries; the profile stands apart at its foot. */
export type RailItemId = "media" | "downloads" | "notes" | "spaces" | "sleeping";

/** The entries that open a tool panel through `$session/tools`. */
export type RailToolId = Extract<RailItemId, "downloads" | "notes">;

export const isRailTool = (id: RailItemId): id is RailToolId =>
  id === "downloads" || id === "notes";

/**
 * Tabs with something to listen to or watch. The rail reads only the window's
 * own projection, and a private window keeps no rail history: its media list
 * is empty rather than reading private tab state.
 */
export function mediaTabs(tabs: readonly TabView[], privateWindow: boolean): TabView[] {
  if (privateWindow) return [];
  return tabs.filter((tab) => tab.audio != null || tab.capture != null);
}

/** Tabs native has put to sleep. Private windows keep no rail list either. */
export function sleepingTabs(tabs: readonly TabView[], privateWindow: boolean): TabView[] {
  if (privateWindow) return [];
  return tabs.filter((tab) => tab.availability?.state === "sleeping");
}

/** Whether a tool entry is the panel currently open beside the rail. */
export function railToolActive(id: RailItemId, activeTool: string | null): boolean {
  return isRailTool(id) && activeTool === id;
}
