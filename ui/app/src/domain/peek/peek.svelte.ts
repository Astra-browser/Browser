/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { preferences } from "$domain/preferences";
import { tabs } from "$domain/tabs";
import { commands } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";
import {
  peekCapture,
  peekClose,
  peekCloseAll,
  peekConfigure,
  peekList,
  peekOpen,
  peekOpenSplit,
  peekOpenTab,
  peekRestore,
  type PeekConfig,
  type PeekState,
  type PeekView,
} from "$shared/ipc/surfaces";

const DEFAULTS: PeekConfig = {
  enabled: true,
  trigger: "hover-shift",
  delay: 420,
  size: "medium",
  position: "auto",
  scale: 1,
  restore: true,
  closeOnLeave: true,
  showUrl: true,
  showTitle: true,
};

let peeks = $state.raw<PeekView[]>([]);
let config = $state.raw<PeekConfig>(DEFAULTS);
let ready = $state(false);
let privateContext = $state(false);
let stopEvent: (() => void) | null = null;
let generation = 0;

function apply(state: PeekState): void {
  peeks = state.peeks;
  config = { ...DEFAULTS, ...state.config } as PeekConfig;
  privateContext = state.private === true;
}

export const peek = {
  state: () => peeks,
  /** Live settings: the preference store is the source; a stale host snapshot
   *  must not pin a hover delay or size after the person changes it. */
  settings: (): PeekConfig => ({
    ...config,
    enabled: preferences.value("peek.enabled") !== "false",
    trigger: preferences.value("peek.trigger"),
    delay: Number(preferences.value("peek.delay")) || config.delay,
    size: preferences.value("peek.size"),
    position: preferences.value("peek.position"),
    scale: Number(preferences.value("peek.scale")) || config.scale,
    restore: preferences.value("peek.restore") !== "false",
    closeOnLeave: preferences.value("peek.close-leave") !== "false",
    showUrl: preferences.value("peek.show-url") !== "false",
    showTitle: preferences.value("peek.show-title") !== "false",
  }),
  isReady: () => ready,
  isPrivate: () => privateContext,
  has: (id: string) => peeks.some((entry) => entry.id === id),

  async init(): Promise<void> {
    if (ready) return;
    const own = ++generation;
    stopEvent = await events.peekChanged.listen(() => {
      if (own !== generation) return;
      // The event is only a change notice; re-read so captures never travel
      // through the event ring buffer.
      void peekList().then((state) => {
        if (own === generation) apply(state);
      });
    });
    try {
      await peekRestore();
      if (own !== generation) return;
      apply(await peekList());
      ready = true;
    } catch {
      // A preview surface that cannot reach native shows nothing rather than
      // inventing cards.
      ready = false;
    }
  },

  dispose(): void {
    generation += 1;
    stopEvent?.();
    stopEvent = null;
    ready = false;
    peeks = [];
  },

  async open(target: { tab_id?: string; url?: string; title?: string; source?: string }) {
    if (!config.enabled) return null;
    try {
      const reply = await peekOpen(target);
      return reply?.id ?? null;
    } catch {
      return null;
    }
  },

  close: (id: string) => void peekClose(id).catch(() => {}),
  closeAll: () => void peekCloseAll().catch(() => {}),
  capture: (id: string) => void peekCapture(id).catch(() => {}),
  openTab: (id: string) => void peekOpenTab(id).catch(() => {}),
  openSplit: (id: string) => void peekOpenSplit(id).catch(() => {}),

  /** Bookmark the previewed page in the active space's tree. */
  async bookmark(id: string): Promise<boolean> {
    const entry = peeks.find((row) => row.id === id);
    if (!entry?.url) return false;
    try {
      const reply = await commands.bookmarkCall(tabs.profile()?.id ?? "default", {
        kind: "add_link",
        parent: null,
        title: entry.title || entry.url,
        url: entry.url,
      });
      return reply?.kind === "saved";
    } catch {
      return false;
    }
  },

  /** Drop the card immediately; the host then frees its capture. */
  discard(id: string): void {
    peeks = peeks.filter((row) => row.id !== id);
    void peekClose(id).catch(() => {});
  },

  async configure(next: Partial<PeekConfig>) {
    config = { ...config, ...next };
    try {
      const reply = await peekConfigure(next);
      config = { ...DEFAULTS, ...reply.config } as PeekConfig;
    } catch {
      // The optimistic value is dropped on the next projection.
    }
  },
};
