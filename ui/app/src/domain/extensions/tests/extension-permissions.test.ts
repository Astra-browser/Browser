/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import {
  answerPrompt,
  currentPrompt,
  queuePrompt,
  removeExtensionPrompts,
  type PermissionPrompt,
} from "../extension-permissions";

const prompt = (dialogId: string, extensionId = "darkreader"): PermissionPrompt => ({
  dialogId,
  extensionId,
  extensionName: "Dark Reader",
  permission: "tabs",
  url: "https://example.com",
});

describe("permission prompt queue", () => {
  it("queues Dialogs events oldest-first and ignores duplicates", () => {
    let queue = queuePrompt([], prompt("dlg-1"));
    queue = queuePrompt(queue, prompt("dlg-2"));
    queue = queuePrompt(queue, prompt("dlg-1"));
    expect(queue.map((queued) => queued.dialogId)).toEqual(["dlg-1", "dlg-2"]);
    expect(currentPrompt(queue)?.dialogId).toBe("dlg-1");
  });

  it("answering returns the decision payload and keeps the rest", () => {
    const queue = queuePrompt(queuePrompt([], prompt("dlg-1")), prompt("dlg-2"));
    const { queue: rest, answered } = answerPrompt(queue, "dlg-1");
    expect(answered?.dialogId).toBe("dlg-1");
    expect(rest.map((queued) => queued.dialogId)).toEqual(["dlg-2"]);
    expect(currentPrompt(rest)?.dialogId).toBe("dlg-2");
  });

  it("answering unknown dialogs changes nothing", () => {
    const queue = [prompt("dlg-1")];
    const { queue: same, answered } = answerPrompt(queue, "dlg-9");
    expect(answered).toBeNull();
    expect(same).toEqual(queue);
    expect(currentPrompt([])).toBeNull();
  });

  it("uninstalling drops that extension's prompts", () => {
    const queue = queuePrompt(queuePrompt([], prompt("dlg-1", "a")), prompt("dlg-2", "b"));
    expect(removeExtensionPrompts(queue, "a").map((queued) => queued.dialogId)).toEqual(["dlg-2"]);
  });
});
