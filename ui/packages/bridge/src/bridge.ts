/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bridge (P2-T08): Tauri-shaped `invoke`/`listen` over Host API + stdio
// frames. UI code keeps its `@tauri-apps/api` call shapes; the bridge swaps
// the transport underneath — Host dispatch in Firefox chrome, MockHost in
// standalone (goldens/dev). Request/response correlation runs on Appendix C
// envelopes (`makeRequest`/`parseEnvelope`); events flow through `EventBus`
// with `event_seq` gap detection so the UI resyncs instead of going stale.

import { makeRequest, parseEnvelope } from "./proto.js";
import { EventBus } from "./event-bus.js";
import { MockHost } from "./mock-host.js";
import type {
  BridgeEvent,
  BridgeMode,
  BridgeOptions,
  DispatchFn,
  EventHandler,
  SequenceGap,
  UnlistenFn,
} from "./types.js";

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export class Bridge {
  readonly mode: BridgeMode;
  private dispatch: DispatchFn;
  private bus: EventBus;
  private newId: () => string;
  private mock: MockHost | null;
  private mockUnsub: (() => void) | null = null;

  constructor(options: BridgeOptions = {}) {
    const newId = options.newId ?? (() => defaultNewId());
    this.newId = newId;
    this.bus = new EventBus(options.onGap);
    if (options.dispatch) {
      this.mode = options.mode ?? "host";
      this.dispatch = options.dispatch;
      this.mock = null;
    } else if (options.mode === "host") {
      throw new BridgeError("no_dispatch", "host mode requires a dispatch function");
    } else {
      this.mode = "mock";
      this.mock = new MockHost();
      this.dispatch = (req) => this.mock!.handle(req);
      this.attachMockFrames();
    }
  }

  /** The MOCK host (null in host mode). Tests/fixtures drive UI via this. */
  mockHost(): MockHost | null {
    return this.mock;
  }

  onGap(fn: (gap: SequenceGap) => void): void {
    this.bus.setOnGap(fn);
  }

  getLastSeq(): number {
    return this.bus.getLastSeq();
  }

  getGapCount(): number {
    return this.bus.getGapCount();
  }

  /** Tauri `invoke` shape: `invoke(cmd, args?)`. Unknown commands reject. */
  async invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const req = makeRequest(cmd as never, args, this.newId());
    const raw = await this.dispatch(req);
    const res = parseEnvelope(raw);
    if (res.id !== req.id) {
      throw new BridgeError("id_mismatch", `response id ${res.id} != request ${req.id}`);
    }
    if (res.error) throw new BridgeError(res.error.code, res.error.message);
    return res.payload as T;
  }

  /** Tauri `listen` shape: returns an unlisten function. */
  listen<T = unknown>(channel: string, handler: EventHandler<T>): UnlistenFn {
    return this.bus.listen(channel, handler);
  }

  /** Tauri `once` shape. */
  once<T = unknown>(channel: string, handler: EventHandler<T>): UnlistenFn {
    const unlisten = this.bus.listen<T>(channel, (event) => {
      unlisten();
      handler(event);
    });
    return unlisten;
  }

  /** Inject a host event (host-mode pump, tests, MockHost wiring). */
  ingestEvent<T = unknown>(channel: string, payload: T, id?: string, seq?: number): boolean {
    return this.bus.ingest(channel, id ?? `evt-${this.getLastSeq() + 1}`, seq, payload);
  }

  /** Feed a raw Appendix C `evt` frame through version-gate + pump. */
  ingestFrame(raw: unknown): boolean {
    const env = parseEnvelope(raw);
    if (env.kind !== "evt") throw new BridgeError("bad_frame", "ingestFrame wants kind=evt");
    return this.bus.ingest(env.name, env.id, env.seq, env.payload);
  }

  /** Drop sequence/listener state (fresh handshake, test isolation). */
  reset(): void {
    this.bus.reset();
  }

  /** Emit a UI-originated event into the local pump (dev/standalone). */
  async emitLocal<T = unknown>(channel: string, payload: T): Promise<void> {
    this.bus.ingest(channel, `local-${this.newId()}`, undefined, payload);
  }

  private attachMockFrames(): void {
    if (!this.mock) return;
    this.mockUnsub = this.mock.onFrame((frame) => {
      if (frame.kind === "evt") {
        this.bus.ingest(frame.name, frame.id, frame.seq, frame.payload);
      }
    });
  }

  detach(): void {
    this.mockUnsub?.();
    this.mockUnsub = null;
  }
}

function defaultNewId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

// ---- Singleton (app wiring configures once per surface) ----

let current: Bridge | null = null;

/** Configure the process-wide bridge (call once per UI surface). */
export function configureBridge(options: BridgeOptions = {}): Bridge {
  current?.detach();
  current = new Bridge(options);
  return current;
}

/** The process-wide bridge (auto-creates a MOCK bridge on first use). */
export function getBridge(): Bridge {
  if (!current) current = new Bridge({ mode: "mock" });
  return current;
}

/** Drop the singleton (tests). */
export function resetBridge(): void {
  current?.detach();
  current = null;
}

export type { BridgeEvent, BridgeMode, BridgeOptions, DispatchFn, EventHandler, SequenceGap, UnlistenFn };
