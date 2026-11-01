/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shared bridge types (P2-T08). Transport-agnostic: Firefox chrome and the
// standalone MOCK host both speak Appendix C envelopes (see ./proto.ts).

import type { Envelope } from "./proto.js";

/** Where requests are dispatched. `mock` answers in-memory (goldens/dev). */
export type BridgeMode = "host" | "mock";

/** Sends one `req` envelope, resolves with the matching `res` envelope. */
export type DispatchFn = (req: Envelope) => Promise<Envelope>;

/** A decoded host event delivered to UI listeners. */
export interface BridgeEvent<T = unknown> {
  /** Post-rename channel (e.g. `tab-changed`, `astra:voice-changed`). */
  channel: string;
  /** Event id (`evt-…`). */
  id: string;
  /** Monotonic host `event_seq` (Appendix C, §5.4). Absent = untracked. */
  seq?: number;
  payload: T;
}

export type EventHandler<T = unknown> = (event: BridgeEvent<T>) => void;
export type UnlistenFn = () => void;

/** Fired when an `evt` envelope arrives out of order (gap in `event_seq`). */
export interface SequenceGap {
  expected: number;
  got: number;
  channel: string;
}

export interface BridgeOptions {
  mode?: BridgeMode;
  /** Required in `host` mode; defaulted to an in-memory MockHost in `mock`. */
  dispatch?: DispatchFn;
  /** Called on `event_seq` gaps so the UI can resync (default: no-op). */
  onGap?: (gap: SequenceGap) => void;
  /** Builds request ids; defaults to `crypto.randomUUID` with a fallback. */
  newId?: () => string;
}

export function defaultNewId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}
