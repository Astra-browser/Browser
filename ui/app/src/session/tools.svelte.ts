import { setPanelExtent } from "./sidebar-mode.svelte";
import { events } from "$shared/ipc/native-events";
import { isBrowserPage, isToolKind, type ToolKind } from "$domain/surface";

export type { ToolKind } from "$domain/surface";

let tool = $state<ToolKind | null>(null);
/** The assistant's conversation breathes wider than a list. */
const extentOf = (kind: ToolKind) => (kind === "ai" ? 372 : 336);
let stop: (() => void) | null = null;
let generation = 0;
let initialized = false;
let initializing: Promise<void> | null = null;
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
async function initialize(owner: number) {
  const unsubscribe = await events.uiCommand.listen(({ payload }) => {
    if (owner !== generation) return;
    const kind = payload.slice(5);
    if (payload.startsWith("tool.") && isToolKind(kind)) open(kind);
    // A page that is also a tool takes the room back from the panel; Settings
    // is the one page that is not a tool and still closes it. Pages with no
    // tool of the same id (Work, Gallery, Source, Extensions) leave the panel
    // where it is, exactly as the literal command list did.
    if (payload.startsWith("browser.")) {
      const page = payload.slice(8);
      if (isBrowserPage(page) && (page === "settings" || isToolKind(page))) {
        tool = null;
        setPanelExtent(0);
      }
    }
  });
  if (owner !== generation) unsubscribe();
  else {
    stop = unsubscribe;
    initialized = true;
  }
}

export function init(): Promise<void> {
  if (initializing) return initializing;
  if (initialized) return Promise.resolve();
  const task = initialize(++generation);
  initializing = task;
  void task.then(
    () => {
      if (initializing === task) initializing = null;
    },
    () => {
      if (initializing === task) initializing = null;
    },
  );
  return task;
}
export function dispose() {
  generation++;
  initialized = false;
  initializing = null;
  stop?.();
  stop = null;
  tool = null;
}
