/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `event_seq` tracking + listener fan-out (P2-T08, Appendix C / §5.4).
// Every host event carries a monotonic `event_seq`; a gap means the UI
// missed state and must resync instead of rendering a stale world.

import type { EventHandler, SequenceGap, UnlistenFn } from "./types.js";

export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();
  private lastSeq = 0;
  private gaps = 0;
  private onGap: (gap: SequenceGap) => void;

  constructor(onGap: (gap: SequenceGap) => void = () => {}) {
    this.onGap = onGap;
  }

  /** Last accepted `event_seq` (0 = nothing seen yet). */
  getLastSeq(): number {
    return this.lastSeq;
  }

  /** Gaps observed since creation (test/health signal). */
  getGapCount(): number {
    return this.gaps;
  }

  setOnGap(fn: (gap: SequenceGap) => void): void {
    this.onGap = fn;
  }

  listen<T = unknown>(channel: string, handler: EventHandler<T>): UnlistenFn {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    const wrapped = handler as EventHandler;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  /**
   * Ingest one host event. Returns `true` when the sequence advanced
   * cleanly, `false` when a gap was detected (listeners still run — the
   * payload is the newest truth — but `onGap` fires so callers resync).
   */
  ingest<T = unknown>(channel: string, id: string, seq: number | undefined, payload: T): boolean {
    let clean = true;
    if (typeof seq === "number") {
      if (this.lastSeq !== 0 && seq !== this.lastSeq + 1) {
        clean = false;
        this.gaps += 1;
        this.onGap({ expected: this.lastSeq + 1, got: seq, channel });
      }
      if (seq > this.lastSeq) this.lastSeq = seq;
    }
    const set = this.listeners.get(channel);
    if (set) {
      const event = { channel, id, seq, payload };
      for (const fn of [...set]) {
        try {
          fn(event);
        } catch {
          // A throwing UI listener must not break the pump (cf. Events.sys.mjs).
        }
      }
    }
    return clean;
  }

  /** Forget sequence state (tests, fresh handshakes). */
  reset(): void {
    this.lastSeq = 0;
    this.gaps = 0;
  }
}
