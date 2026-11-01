/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Drop-in shims matching the `@tauri-apps/api` shapes the UI imports
// (`core.invoke`, `event.listen`/`once`/`emit`, `window.getCurrentWindow`).
// UI modules swap the import source; call sites stay unchanged.

import { getBridge, resetBridge, configureBridge } from "./bridge.js";
import type { Bridge, BridgeOptions } from "./bridge.js";
import type { BridgeEvent, EventHandler } from "./types.js";

export { configureBridge, getBridge, resetBridge };
export type { Bridge, BridgeOptions };

/** `invoke<T>(cmd, args?)` — mirrors `@tauri-apps/api/core`. */
export async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return getBridge().invoke<T>(cmd, args);
}

export interface TauriLikeEvent<T> {
  event: string;
  id: number;
  payload: T;
}

export type TauriHandler<T> = (event: TauriLikeEvent<T>) => void;

function toTauri<T>(channel: string, handler: TauriHandler<T>): EventHandler<T> {
  let n = 0;
  return (event: BridgeEvent<T>) => handler({ event: channel, id: (n += 1), payload: event.payload });
}

/**
 * `listen(event, handler)` — mirrors `@tauri-apps/api/event`. Resolves with
 * the unlisten function, like Tauri.
 */
export async function listen<T = unknown>(
  event: string,
  handler: TauriHandler<T>,
): Promise<() => void> {
  return getBridge().listen(event, toTauri(event, handler));
}

/** `once(event, handler)` — mirrors `@tauri-apps/api/event`. */
export async function once<T = unknown>(
  event: string,
  handler: TauriHandler<T>,
): Promise<() => void> {
  return getBridge().once(event, toTauri(event, handler));
}

/** `emit(event, payload?)` — fans out into the local pump (standalone). */
export async function emit<T = unknown>(event: string, payload?: T): Promise<void> {
  await getBridge().emitLocal(event, payload);
}

export interface BridgeWindow {
  label: string;
  listen: typeof listen;
  once: typeof once;
  emit: typeof emit;
  isFullscreen: () => Promise<boolean>;
  isMinimized: () => Promise<boolean>;
}

let windowLabel = "main";

/** Override the standalone window label (per-surface wiring sets this). */
export function setWindowLabel(label: string): void {
  windowLabel = label;
}

/** `getCurrentWindow()` — mirrors `@tauri-apps/api/window` (subset used). */
export function getCurrentWindow(): BridgeWindow {
  return {
    get label() {
      return windowLabel;
    },
    listen,
    once,
    emit,
    isFullscreen: async () => false,
    isMinimized: async () => false,
  };
}
