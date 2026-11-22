import { listenAll } from "$shared/lib/lifecycle";
import { flushSync } from "svelte";
import { flags } from "$shared/flags";
import { commands } from "$shared/ipc/bindings";
import { settle } from "$domain/operations";
import { events } from "$shared/ipc/native-events";
import { isBrowserPage, type BrowserPage } from "./surfaces";

export type { BrowserPage } from "./surfaces";
/** The pages that stand in the tab list as their own tab. */
export type PageTab = "settings" | "extensions";
let page = $state<BrowserPage | null>(null);
// A page is also a tab: switching to a web tab parks it (it stays in the list)
// instead of forcing the person to walk back out. `selected` is whether that
// tab is the one in front.
let selected = $state(false);
// The page a browser page was opened over, so closing it returns there: Settings
// opened from Work gives the window back to Work, not to Browse.
let underneath: BrowserPage | null = null;
let error = $state(false);
let generation = 0;
let navigationEpoch = 0;
let activeTab: string | null = null;
let stop: (() => void) | null = null;
let observationLifetime = new AbortController();
let initialized = false;
let initializing: Promise<void> | null = null;
export const currentPage = () => (selected ? page : null);
/** The page that owns a tab in the list, or null when there is none. */
export const pageTab = (): PageTab | null =>
  page === "settings" || page === "extensions" ? page : null;
/** Whether the page tab is the row in front (not merely still open). */
export const pageTabSelected = () => selected && pageTab() !== null;
/** Whether any page is open, including one parked behind a web tab. */
export const hasPage = () => page !== null;
/** The page selected in front, whichever kind it is. */
export const pageSelected = () => selected && page !== null;
export const navigationFailed = () => error;
async function initialize(epoch: number) {
  const listeners = await listenAll([
    events.browserReturn.listen(() => {
      if (epoch !== generation) return;
      underneath = null;
      flushSync(() => {
        page = null;
        selected = false;
      });
    }),
    events.itemsChanged.listen(({ payload }) => {
      if (epoch !== generation) return;
      const next = typeof payload?.active === "string" ? payload.active : null;
      // Choosing any tab leaves the page, but the page keeps its own row: the
      // person can come back to it the way they come back to any tab. Work is
      // a mode, not a page, so it stays where it is.
      if (activeTab !== null && next !== activeTab && page !== null && page !== "work") {
        selected = false;
      }
      activeTab = next;
    }),
    events.uiCommand.listen(({ payload }) => {
      if (epoch !== generation) return;
      if (payload === "browser.return-failed") {
        navigationEpoch++;
        error = true;
        return;
      }
      const destination = payload.startsWith("browser.") ? payload.slice(8) : "";
      // Work leaves with its build flag: a host event cannot open a surface
      // this build does not ship.
      if (destination === "work" && !flags.work) return;
      const confirmed: BrowserPage | null | undefined =
        destination === "return" ? null : isBrowserPage(destination) ? destination : undefined;
      if (confirmed !== undefined) {
        navigationEpoch++;
        if (confirmed === null || confirmed === "work") underneath = null;
        else if (page === "work") underneath = "work";
        flushSync(() => {
          error = false;
          page = confirmed;
          selected = confirmed !== null;
        });
      }
    }),
  ]);
  if (epoch !== generation) {
    for (const unsubscribe of listeners) unsubscribe();
  } else {
    initialized = true;
    stop = () => {
      for (const unsubscribe of listeners) unsubscribe();
    };
  }
}
export function init(): Promise<void> {
  if (initializing) return initializing;
  if (initialized) return Promise.resolve();
  if (observationLifetime.signal.aborted) observationLifetime = new AbortController();
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
  observationLifetime.abort();
  initialized = false;
  initializing = null;
  navigationEpoch++;
  stop?.();
  stop = null;
  page = null;
  selected = false;
  activeTab = null;
  underneath = null;
  error = false;
}
export async function open(next: BrowserPage | null) {
  if (next === "work" && !flags.work) return;
  const request = ++navigationEpoch;
  const fail = () => {
    if (request === navigationEpoch) error = true;
  };
  error = false;
  try {
    const result = await settle(
      commands.runCommand(`browser.${next ?? "return"}`),
      5000,
      observationLifetime.signal,
    );
    if (result.outcome === "failed" || result.outcome === "rejected") fail();
  } catch {
    fail();
  }
}

/** Puts the page behind the tab the person chose, keeping its row. */
export function park() {
  if (page !== null && page !== "work") selected = false;
}

/** Brings the parked page tab back in front. */
export function selectPage() {
  if (page !== null) selected = true;
}

/**
 * Closes the current page, returning to the one it was opened over.
 * This is the in-page Back control, so Settings opened from Work returns there.
 */
export function close() {
  return open(page === "work" ? null : underneath);
}

/** Closes a page from its own tab row, without entering the page behind it. */
export function dismiss() {
  underneath = null;
  return open(null);
}
