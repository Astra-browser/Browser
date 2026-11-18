import { setPanelExtent } from "./sidebar-mode.svelte";
import { events } from "$shared/ipc/native-events";
export type ToolKind = "notes" | "tasks" | "ai" | "time" | "history" | "downloads" | "bookmarks";
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
