/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Permission-prompt queue (P4-T04), UI side of the Host API Dialogs
// `permission.requested` events (P3-T09, read-only usage).
//
// The host owns the dialogs; this module only models what the UI shows:
// queue prompts as their events arrive, surface the oldest unanswered one,
// and produce the grant/deny answer the caller forwards through
// `Dialogs.decidePermission`. It never resolves anything itself.

export type PermissionPrompt = {
  /** Dialogs `dialog_id` (e.g. "dlg-3"). */
  dialogId: string;
  /** Gallery key of the requesting extension. */
  extensionId: string;
  extensionName: string;
  permission: string;
  url: string;
};

export type PromptQueue = readonly PermissionPrompt[];

export const queuePrompt = (queue: PromptQueue, prompt: PermissionPrompt): PromptQueue => {
  if (queue.some((queued) => queued.dialogId === prompt.dialogId)) return queue;
  return [...queue, prompt];
};

export const answerPrompt = (
  queue: PromptQueue,
  dialogId: string,
): { queue: PromptQueue; answered: PermissionPrompt | null } => {
  const answered = queue.find((queued) => queued.dialogId === dialogId) ?? null;
  if (!answered) return { queue, answered: null };
  return { queue: queue.filter((queued) => queued.dialogId !== dialogId), answered };
};

/** Oldest unanswered prompt, or null when nothing needs the user. */
export const currentPrompt = (queue: PromptQueue): PermissionPrompt | null => queue[0] ?? null;

export const removeExtensionPrompts = (queue: PromptQueue, extensionId: string): PromptQueue =>
  queue.filter((queued) => queued.extensionId !== extensionId);
