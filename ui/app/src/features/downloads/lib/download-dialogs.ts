/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Bridge } from "@astra/bridge";

// Download-permission prompts over `@astra/bridge` (P4-T08). The single
// place the downloads UI reads when the engine asks the user to allow or
// deny a download: the Host API `Dialogs` module emits `download.started`
// (see `overlay/astra/host/Dialogs.sys.mjs` + `docs/astra/DIALOGS.md`) and
// the UI answers with `decideDownload`. Framework-free so the unit project
// (node env) can drive it through MockHost with no DOM.
//
// BRIDGE GAP (assembly follow-up, see docs/astra/DOWNLOADS.md §Bridge gap):
// `@astra/bridge` currently routes only Tabs/Navigation/Panes/Boot through
// `host-transport.ts`, and the proto surface has no `download.started`
// event or `decideDownload` command. Against a mock bridge this session
// still works end to end (MockHost answers unrouted `invoke` with
// `{ ok: true }` and delivers `emitEvent("download.started", …)` through
// the event pump); against the real host it resolves once the assembly
// wires `Dialogs.requestDownload`/`decideDownload` into the route table.

/** A download the engine is asking the user to allow or deny. */
export interface DownloadPrompt {
  dialogId: string;
  tabId: string;
  url: string;
  filename: string;
  mime: string | null;
}

export type DownloadDecision = "allow" | "deny";

/** Resolution the UI sent back for one prompt. */
export interface DownloadResolution {
  dialogId: string;
  decision: DownloadDecision;
}

type Listener = () => void;

/** Raw `download.started` payload, per `overlay/astra/host/schemas/dialogs.json`. */
interface DownloadStartedPayload {
  dialog_id?: unknown;
  astra_tab_id?: unknown;
  url?: unknown;
  filename?: unknown;
  mime?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asPrompt(payload: unknown): DownloadPrompt | null {
  if (!isRecord(payload)) return null;
  const data = payload as DownloadStartedPayload;
  if (
    typeof data.dialog_id !== "string" ||
    data.dialog_id === "" ||
    typeof data.url !== "string" ||
    data.url === "" ||
    typeof data.filename !== "string" ||
    data.filename === ""
  ) {
    return null;
  }
  return {
    dialogId: data.dialog_id,
    tabId: typeof data.astra_tab_id === "string" ? data.astra_tab_id : "",
    url: data.url,
    filename: data.filename,
    mime: typeof data.mime === "string" ? data.mime : null,
  };
}

/**
 * Pending `download.started` prompts for one surface. `start()` subscribes
 * to the bridge event pump; `decide()` answers one prompt (later calls for
 * the same id reject with `no_such_dialog`, mirroring the host gate).
 */
export class DownloadPromptSession {
  private readonly bridge: Pick<Bridge, "listen" | "invoke">;
  private unlisten: Listener | null = null;
  private readonly listeners = new Set<Listener>();
  private promptsById = new Map<string, DownloadPrompt>();
  private resolutions: DownloadResolution[] = [];

  constructor(bridge: Pick<Bridge, "listen" | "invoke">) {
    this.bridge = bridge;
  }

  /** Prompts still waiting on a decision, oldest first. */
  prompts(): DownloadPrompt[] {
    return [...this.promptsById.values()];
  }

  /** Every decision sent so far, in send order. */
  decided(): DownloadResolution[] {
    return [...this.resolutions];
  }

  subscribe(listener: Listener): Listener {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.unlisten) return;
    this.unlisten = this.bridge.listen("download.started", (event) => {
      const prompt = asPrompt(event.payload);
      if (!prompt || this.promptsById.has(prompt.dialogId)) return;
      this.promptsById.set(prompt.dialogId, prompt);
      this.notify();
    });
  }

  /** Answer one prompt. Resolves like the host `decideDownload` gate. */
  async decide(dialogId: string, decision: DownloadDecision): Promise<void> {
    const prompt = this.promptsById.get(dialogId);
    if (!prompt) throw new Error(`no_such_dialog: ${dialogId}`);
    await this.bridge.invoke("decideDownload", { dialog_id: dialogId, decision });
    this.promptsById.delete(dialogId);
    this.resolutions.push({ dialogId, decision });
    this.notify();
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.listeners.clear();
    this.promptsById = new Map();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
