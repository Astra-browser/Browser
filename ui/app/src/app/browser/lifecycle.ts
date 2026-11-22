/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updates } from "$domain/updates";
import { webext } from "$domain/webext";
import { browserImport, nativeImportAdapter } from "$domain/browser-import";
import { surface as browserPage } from "$domain/surface";
import { findInPage } from "$features/address";
import { peek } from "$features/peek";
import { updateNotices } from "$features/updates";
import { IS_MAC } from "$shared/platform";
import type { Slice } from "$shared/lib/lifecycle";
import * as motion from "$session/motion.svelte";
import * as sidebar from "$session/sidebar-mode.svelte";
import { browserSlices } from "./slices";

export type BrowserLifecycleEntry = {
  id: string;
  /** Present when this entry is one of the shared-contract UI slices. */
  slice?: Slice;
  start?(): unknown;
  stop?(started: unknown): unknown;
  /** Include this start in the gate awaited before the native reveal. */
  awaitStartup?: boolean;
  /** Evaluated once per mount; an inactive entry is absent from both lists. */
  when?: () => boolean;
  /** Teardown rank: lower runs first. */
  teardown: number;
};

export type BrowserLifecycleContext = {
  handleKeydown(event: KeyboardEvent): void;
};

const slices = new Map(browserSlices.map((entry) => [entry.id, entry.slice]));

function sliceEntry(
  id: string,
  teardown: number,
  awaitStartup = false,
  when?: () => boolean,
): BrowserLifecycleEntry {
  const slice = slices.get(id);
  if (slice === undefined) throw new Error(`unknown browser slice: ${id}`);
  return {
    id,
    slice,
    start: () => slice.init(),
    stop: () => slice.dispose(),
    awaitStartup,
    when,
    teardown,
  };
}

function listenerEntry(
  id: string,
  teardown: number,
  listen: () => Promise<() => void>,
): BrowserLifecycleEntry {
  return {
    id,
    start: listen,
    stop: (started) =>
      void (started as Promise<() => void>).then(
        (stop) => stop(),
        () => {},
      ),
    teardown,
  };
}

/**
 * One ordered table for the browser window's startup and teardown. Array order
 * is the startup order; `teardown` is the exact order the lists used to spell
 * out twice. A condition is evaluated once, for both lists.
 */
export function createBrowserLifecycle(
  context: BrowserLifecycleContext,
): readonly BrowserLifecycleEntry[] {
  return [
    sliceEntry("theme", 10, true),
    sliceEntry("tools", 30, true),
    sliceEntry("surface", 20, true),
    sliceEntry("preferences", 50, true),
    sliceEntry("runtime", 80, true),
    sliceEntry("media-player", 90),
    { id: "peek", start: () => peek.init(), stop: () => peek.dispose(), teardown: 100 },
    sliceEntry("focus", 130),
    { id: "updates", start: () => updates.init(), stop: () => updates.dispose(), teardown: 110 },
    {
      id: "update-notices",
      start: () => updateNotices.init(),
      stop: () => updateNotices.dispose(),
      teardown: 120,
    },
    sliceEntry("extensions", 140, true),
    { id: "webext-refresh", start: () => webext.refresh(), teardown: 150 },
    { id: "webext", stop: () => webext.dispose(), teardown: 150 },
    listenerEntry("webext-access", 180, () => webext.listenForAccess()),
    listenerEntry("webext-prompt", 190, () => webext.listenForPrompt()),
    listenerEntry("webext-store-clicks", 200, () => webext.listenForStoreClicks()),
    listenerEntry("webext-drops", 210, () =>
      webext.listenForDrops(() => browserPage.currentPage() !== "work"),
    ),
    sliceEntry("page-permissions", 160, true),
    sliceEntry("page-dialogs", 170, true),
    sliceEntry("favicons", 220, true),
    sliceEntry("tabs", 230, true),
    { id: "sidebar", start: () => sidebar.init(), awaitStartup: true, teardown: 0 },
    sliceEntry("ui-commands", 240, true),
    sliceEntry("keymap", 250),
    {
      id: "browser-import",
      start: () => browserImport.provide(nativeImportAdapter()),
      stop: () => browserImport.provide(null),
      when: () => !browserImport.available(),
      teardown: 270,
    },
    sliceEntry("operations", 60),
    sliceEntry("blocker", 70),
    sliceEntry("layout", 280, false, () => !IS_MAC),
    {
      id: "keydown",
      start: () => document.addEventListener("keydown", context.handleKeydown),
      stop: () => document.removeEventListener("keydown", context.handleKeydown),
      teardown: 290,
    },
    { id: "motion", stop: () => motion.dispose(), teardown: 40 },
    { id: "find-in-page", stop: () => findInPage.dispose(), teardown: 260 },
  ];
}
