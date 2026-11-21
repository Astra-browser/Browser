/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// In-memory MOCK host (P2-T08). Answers every command of the 281-command
// surface without Firefox so the UI runs standalone (goldens/dev). Known
// commands return shaped fixtures (mirroring
// `crates/astra-proto/fixtures/`); everything else returns `{ ok: true }`
// unless an override is registered. Events are emitted with a monotonic
// `event_seq` starting at 1, like `overlay/astra/host/Events.sys.mjs`.

import { COMMANDS, EVENT_RENAMES, EVENTS, PROTOCOL_VERSION } from "./proto.js";
import type { Envelope } from "./proto.js";
import type { CommandName } from "./proto.js";

export type MockResponder = (
  args: Record<string, unknown>,
  host: MockHost,
) => unknown | Promise<unknown>;

/** Envelope sink observing MOCK traffic (devtools/golden logging). */
export type MockFrameSink = (frame: Envelope) => void;

interface MockTab {
  astra_tab_id: string;
  url: string;
  title: string;
  selected: boolean;
}

export class MockHost {
  private tabs = new Map<string, MockTab>();
  private nextTab = 1;
  private selectedId = "";
  private seq = 0;
  private overrides = new Map<string, MockResponder>();
  private sinks = new Set<MockFrameSink>();

  /** Last assigned `event_seq` (0 = no events emitted yet). */
  getSeq(): number {
    return this.seq;
  }

  onFrame(sink: MockFrameSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  /** Override (or add) the responder for one command. */
  respond(cmd: string, fn: MockResponder): void {
    this.overrides.set(cmd, fn);
  }

  /** Emit a host event frame; returns the assigned `event_seq`. */
  emitEvent(channel: string, payload: unknown = {}): number {
    const seq = ++this.seq;
    const frame: Envelope = {
      v: PROTOCOL_VERSION,
      id: `evt-${String(seq).padStart(4, "0")}`,
      kind: "evt",
      name: channel,
      seq,
      payload,
    };
    for (const sink of [...this.sinks]) {
      try {
        sink(frame);
      } catch {
        // Sinks are observers; never break the pump.
      }
    }
    return seq;
  }

  /** Handle one `req` envelope; always resolves a matching `res` envelope. */
  async handle(req: Envelope): Promise<Envelope> {
    const args = (req.payload ?? {}) as Record<string, unknown>;
    const override = this.overrides.get(req.name);
    try {
      const data = override
        ? await override(args, this)
        : await this.defaultResponse(req.name as CommandName, args);
      return { v: PROTOCOL_VERSION, id: req.id, kind: "res", name: req.name, payload: data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        v: PROTOCOL_VERSION,
        id: req.id,
        kind: "res",
        name: req.name,
        payload: {},
        error: { code: "mock_error", message },
      };
    }
  }

  /** Reset tabs, seq and overrides (test isolation). */
  reset(): void {
    this.tabs.clear();
    this.nextTab = 1;
    this.selectedId = "";
    this.seq = 0;
    this.overrides.clear();
  }

  private ensureSelected(): MockTab | null {
    if (this.selectedId && this.tabs.has(this.selectedId)) {
      return this.tabs.get(this.selectedId)!;
    }
    return null;
  }

  private select(id: string): void {
    for (const tab of this.tabs.values()) tab.selected = tab.astra_tab_id === id;
    this.selectedId = id;
  }

  private snapshot(tab: MockTab) {
    return { ...tab, canGoBack: false, canGoForward: false };
  }

  // Shaped fixtures for the commands the chrome exercises first. The
  // remaining surface answers `{ ok: true }` so goldens/dev never hang on
  // an unimplemented command; extend here (not in UI code) as coverage grows.
  private async defaultResponse(
    cmd: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (cmd) {
      case "ui_info":
        return { version: "0.1.0-mock", os: "mock", arch: "mock" };
      case "ui_ready":
      case "onboarding_finish":
        return true;
      case "tabs_bootstrap":
        return undefined;
      case "tabs_open": {
        const id = `tab-${this.nextTab++}`;
        const tab: MockTab = { astra_tab_id: id, url: "about:blank", title: "", selected: false };
        this.tabs.set(id, tab);
        if (!this.selectedId) this.select(id);
        this.emitEvent("tab-changed", { ...this.snapshot(tab), reason: "opened" });
        return { admitted: true };
      }
      case "tabs_close": {
        const id = args["id"] as string;
        const existed = this.tabs.delete(id);
        if (this.selectedId === id) {
          const next = this.tabs.keys().next();
          this.selectedId = next.done ? "" : next.value;
          if (this.selectedId) this.select(this.selectedId);
        }
        if (existed) this.emitEvent("tab-changed", { astra_tab_id: id, reason: "closed" });
        return { admitted: existed };
      }
      case "tabs_activate": {
        const id = args["id"] as string;
        if (!this.tabs.has(id)) return { admitted: false };
        this.select(id);
        this.emitEvent("tab-changed", { ...this.snapshot(this.tabs.get(id)!), reason: "activated" });
        return { admitted: true };
      }
      case "tabs_navigate": {
        const id = (args["id"] as string) || this.selectedId;
        const tab = this.tabs.get(id) ?? this.ensureSelected();
        if (!tab) return { admitted: false };
        tab.url = args["input"] as string;
        this.emitEvent("tab-changed", { ...this.snapshot(tab), reason: "navigated" });
        return { admitted: true };
      }
      case "tabs_back":
      case "tabs_forward":
      case "tabs_reload":
      case "tabs_set_essential":
      case "tabs_split":
      case "tabs_unsplit":
      case "tabs_leave_split":
      case "tabs_continue_past_certificate":
      case "tabs_answer_page_request":
      case "tabs_answer_sign_in":
      case "tab_set_muted":
      case "tab_drag_over":
      case "tab_drop":
        return { admitted: true };
      case "setting_get":
        return null;
      case "setting_set":
        return { admitted: true };
      case "work_running":
        return false;
      case "voice_status":
        return { phase: "idle" };
      case "default_browser_status":
        return null;
      case "login_item_status":
        return { enabled: false };
      case "system_clock_24h":
        return null;
      default:
        return { ok: true };
    }
  }
}

/** Every command the bridge accepts (281 wire names from `proto.ts`). */
export function mockCommandNames(): readonly CommandName[] {
  return COMMANDS;
}

/** Every event channel the bridge delivers (35 post-rename names). */
export function mockEventChannels(): readonly string[] {
  return EVENTS;
}

/** Map a `prev:` wire channel to its `astra:` rename (undefined = current). */
export function renameChannel(channel: string): string {
  return EVENT_RENAMES[channel] ?? channel;
}
