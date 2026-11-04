import { commands } from "$shared/ipc/bindings";
import { settle } from "$domain/operations";
import { tabs } from "$domain/tabs";
let id = $state<string | null>(null);
let over = $state(false);
let failed = $state(false);
let pending = false;
export const draggedId = () => id;
export const overEssentials = () => over;
export const moveFailed = () => failed;
export function begin(value: string) {
  id = value;
  failed = false;
}
/** Only a web page can be kept: a tab with nothing open yet, or one the
 *  browser itself owns, has no site to keep. */
export function keepable(value: string) {
  const tab = tabs.tabs().find((candidate) => candidate.id === value);
  return !!tab?.url && (tab.content ?? "web") === "web";
}
export function hover(x: number, y: number) {
  over =
    id !== null &&
    keepable(id) &&
    !!document.elementFromPoint(x, y)?.closest("[data-essentials-drop]");
}
export function end() {
  const active = id !== null;
  id = null;
  over = false;
  // Releasing the native hover hint is not a placement: its refusal (the hint
  // is not wired yet, or the window is already gone) must never be reported as
  // "could not move this tab". Only `move`/`leaveSplit` settle a placement.
  if (active) void commands.tabDragOver(null, null).catch(() => {});
}
/** Takes a tab out of the split it is in, then places it as `move` would. */
export async function leaveSplit(
  value: string,
  place: { essential: boolean; before: string | null } | null,
) {
  if (pending) return;
  pending = true;
  failed = false;
  try {
    const result = await settle(commands.tabsLeaveSplit(value), 5000);
    if (result.outcome === "failed" || result.outcome === "rejected") throw new Error("settlement");
  } catch {
    failed = true;
    return;
  } finally {
    pending = false;
  }
  if (place) await move(value, place.essential, place.before);
}

export async function move(value: string, essential: boolean, before: string | null = null) {
  if (pending) return;
  pending = true;
  failed = false;
  try {
    const result = await settle(commands.tabsSetEssential(value, essential, before), 5000);
    if (result.outcome === "failed" || result.outcome === "rejected") throw new Error("settlement");
  } catch {
    failed = true;
  } finally {
    pending = false;
  }
}
