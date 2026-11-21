import { tabs } from "$domain/tabs";
import { preferences } from "$domain/preferences";

/**
 * The tab a person asked to open in a split view. The picker lists the tabs
 * that can join it (or a new blank pane); the choice is then sent with both
 * tab ids, so the right-clicked or dragged tab is the pane in front rather
 * than whichever tab happened to be selected.
 */
let opened = $state<string | null>(null);

export const sourceId = () => opened;
export const isOpen = () => opened !== null;

export function open(source: string): boolean {
  if (!source || !tabs.tabs().some((tab) => tab.id === source)) return false;
  opened = source;
  return true;
}

export function close() {
  opened = null;
}

export function maxPanes(): number {
  const value = Number(preferences.value("split.max-panes"));
  if (!Number.isSafeInteger(value) || value < 2) return 3;
  return Math.min(3, value);
}

export function sourceTab() {
  const id = opened;
  return id === null ? undefined : tabs.tabs().find((tab) => tab.id === id);
}

/** The split the source tab is already part of, if any. */
function sourceGroup() {
  const id = opened;
  return id === null ? null : tabs.splitGroupFor(id);
}

/** Whether this split has room for one more pane. */
export function hasRoom(): boolean {
  const group = sourceGroup();
  return group === null || group.members.length < maxPanes();
}

/**
 * Tabs that may join the source's split. A tab already in another split cannot
 * be in two native splits at once, and a tab that is already a pane of this
 * one has nothing new to show.
 */
export function candidates() {
  const source = opened;
  if (source === null || !hasRoom()) return [];
  const group = sourceGroup();
  const members = group?.members ?? [];
  return tabs
    .tabs()
    .filter((tab) => tab.id !== source && !members.includes(tab.id))
    .filter((tab) => !tabs.inSplit(tab.id));
}
