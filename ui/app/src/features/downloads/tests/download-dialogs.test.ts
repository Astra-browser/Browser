/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, test, vi } from "vitest";
import { configureBridge, resetBridge, type Bridge } from "@astra/bridge";
import { DownloadPromptSession } from "../lib/download-dialogs";

function setup(): { bridge: Bridge; session: DownloadPromptSession } {
  const bridge = configureBridge({ mode: "mock" });
  const session = new DownloadPromptSession(bridge);
  session.start();
  return { bridge, session };
}

afterEach(() => {
  resetBridge();
});

const started = {
  dialog_id: "dlg-1",
  astra_tab_id: "tab-1",
  url: "https://example.com/report.pdf",
  filename: "report.pdf",
  mime: "application/pdf",
};

describe("download.started prompts", () => {
  test("a started download becomes a pending prompt", () => {
    const { bridge, session } = setup();
    const seen: number[] = [];
    session.subscribe(() => seen.push(session.prompts().length));

    bridge.mockHost()!.emitEvent("download.started", started);

    expect(session.prompts()).toEqual([
      {
        dialogId: "dlg-1",
        tabId: "tab-1",
        url: "https://example.com/report.pdf",
        filename: "report.pdf",
        mime: "application/pdf",
      },
    ]);
    expect(seen).toEqual([1]);
    session.stop();
  });

  test("malformed and duplicate prompts are dropped", () => {
    const { bridge, session } = setup();
    const mock = bridge.mockHost()!;

    mock.emitEvent("download.started", { ...started, filename: "" });
    mock.emitEvent("download.started", { dialog_id: "dlg-x" });
    mock.emitEvent("download.started", "not-an-object");
    expect(session.prompts()).toEqual([]);

    mock.emitEvent("download.started", started);
    mock.emitEvent("download.started", started);
    expect(session.prompts()).toHaveLength(1);
    session.stop();
  });

  test("allow resolves the prompt and records the decision", async () => {
    const { bridge, session } = setup();
    bridge.mockHost()!.emitEvent("download.started", started);

    await session.decide("dlg-1", "allow");

    expect(session.prompts()).toEqual([]);
    expect(session.decided()).toEqual([{ dialogId: "dlg-1", decision: "allow" }]);
    session.stop();
  });

  test("deny resolves the prompt the same way", async () => {
    const { bridge, session } = setup();
    bridge.mockHost()!.emitEvent("download.started", started);

    await session.decide("dlg-1", "deny");

    expect(session.decided()).toEqual([{ dialogId: "dlg-1", decision: "deny" }]);
    session.stop();
  });

  test("unknown and already-resolved ids reject like the host gate", async () => {
    const { session } = setup();

    await expect(session.decide("dlg-missing", "allow")).rejects.toThrow("no_such_dialog");

    session.stop();
  });

  test("a resolved prompt cannot be decided twice", async () => {
    const { bridge, session } = setup();
    bridge.mockHost()!.emitEvent("download.started", started);

    await session.decide("dlg-1", "allow");
    await expect(session.decide("dlg-1", "allow")).rejects.toThrow("no_such_dialog");
    session.stop();
  });

  test("the mock bridge answers decideDownload (stub for the missing host route)", async () => {
    const { bridge, session } = setup();
    const invoke = vi.spyOn(bridge, "invoke");
    bridge.mockHost()!.emitEvent("download.started", started);

    await session.decide("dlg-1", "allow");

    // No `decideDownload` command exists in the proto surface yet (assembly
    // follow-up); the mock host answers `{ ok: true }` so the UI flow is
    // drivable before the host route lands.
    expect(invoke).toHaveBeenCalledWith("decideDownload", {
      dialog_id: "dlg-1",
      decision: "allow",
    });
    session.stop();
  });
});
