import { setPanelExtent } from "./sidebar-mode.svelte";
import { events } from "$shared/ipc/native-events";
import { isBrowserPage, isToolKind, type ToolKind } from "$domain/surface";
import { createSlice } from "$shared/lib/lifecycle";

export type { ToolKind } from "$domain/surface";

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
      if (payload.startsWith("tool.") && isToolKind(kind)) open(kind);
      // A page that is also a tool takes the room back from the panel; Settings
      // is the one page that is not a tool and still closes it. Pages with no
      // tool of the same id (Work, Gallery, Source, Extensions) leave the panel
      // where it is.
      if (payload.startsWith("browser.")) {
        const page = payload.slice(8);
        if (isBrowserPage(page) && (page === "settings" || isToolKind(page))) {
          tool = null;
          setPanelExtent(0);
        }
      }
    });
  },
  reset() {
    tool = null;
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();
