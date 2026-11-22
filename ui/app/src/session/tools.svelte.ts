import { setPanelExtent } from "./sidebar-mode.svelte";
import { events } from "$shared/ipc/native-events";
import { createSlice } from "$shared/lib/lifecycle";
export type ToolKind = "notes" | "tasks" | "ai" | "time" | "history" | "downloads" | "bookmarks";
let tool = $state<ToolKind | null>(null);
/** The assistant's conversation breathes wider than a list. */
const extentOf = (kind: ToolKind) => (kind === "ai" ? 372 : 336);
export const activeTool = () => tool;
export function open(kind: ToolKind) {
  // A tool is a panel beside whatever page is in front. Closing that page
  // first unmounted the whole stage and remounted it twice, which read as the
  // black flash the owner reported; the panel can simply take its room.
  tool = kind;
  setPanelExtent(extentOf(kind));
}
export function close() {
  tool = null;
  setPanelExtent(0);
}

export const slice = createSlice({
  register({ isCurrent }) {
    return events.uiCommand.listen(({ payload }) => {
      if (!isCurrent()) return;
      const kind = payload.slice(5);
      if (
        payload.startsWith("tool.") &&
        ["notes", "tasks", "ai", "time", "history", "downloads", "bookmarks"].includes(kind)
      )
        open(kind as ToolKind);
      if (
        [
          "browser.settings",
          "browser.history",
          "browser.downloads",
          "browser.tasks",
          "browser.notes",
          "browser.time",
        ].includes(payload)
      ) {
        tool = null;
        setPanelExtent(0);
      }
    });
  },
  reset() {
    tool = null;
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();
