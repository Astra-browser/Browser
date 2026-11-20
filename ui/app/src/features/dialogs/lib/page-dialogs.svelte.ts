import type { PageDialogPromptChanged } from "$shared/ipc/bindings";
import { commands } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";

// One dialog is shown at a time; the engine may raise several from one page
// (an alert storm queues them) and each waits for its own token. A closed
// notice (timeout, window teardown) clears the card without an answer.

let queue = $state.raw<PageDialogPromptChanged[]>([]);
let answering = $state(false);
let unlisten: (() => void) | null = null;
let lifecycle = 0;
let initialized = false;
let initializing: Promise<void> | null = null;

export const prompt = () => queue[0] ?? null;
export const busy = () => answering;

function matches(entry: PageDialogPromptChanged, request: string): boolean {
  return entry.request === request;
}

function remove(request: string) {
  queue = queue.filter((entry) => !matches(entry, request));
}

function apply(entry: PageDialogPromptChanged) {
  if (!entry || typeof entry.request !== "string" || entry.request === "") return;
  if (entry.closed === true) {
    remove(entry.request);
    return;
  }
  if (queue.some((shown) => matches(shown, entry.request))) return;
  queue = [...queue, entry];
}

async function initialize(generation: number) {
  const stop = await events.pageDialogPromptChanged.listen((event) => {
    if (generation !== lifecycle) return;
    apply(event.payload);
  });
  if (generation !== lifecycle) {
    stop();
    return;
  }
  unlisten = stop;
  initialized = true;
}

export function init(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (initializing !== null) return initializing;
  const generation = ++lifecycle;
  const task = initialize(generation);
  initializing = task;
  void task.then(
    () => {
      if (initializing === task) initializing = null;
    },
    () => {
      if (initializing === task) initializing = null;
    },
  );
  return task;
}

export function dispose() {
  lifecycle += 1;
  initialized = false;
  initializing = null;
  unlisten?.();
  unlisten = null;
  queue = [];
  answering = false;
}

/**
 * Answers the dialog on screen. The request token is the capability; the
 * host refuses a token that is not pending in this window. The card clears
 * even when the command fails, so a stale token never traps the person.
 */
export async function answer(choice: {
  confirmed: boolean;
  value?: string;
  checked?: boolean;
}): Promise<void> {
  const current = queue[0];
  if (current === undefined || answering) return;
  answering = true;
  try {
    await commands.pageDialogAnswer(
      current.request,
      choice.confirmed,
      choice.value ?? "",
      choice.checked === true,
    );
  } catch {
    // The host already settled it; clearing below is the only safe state.
  } finally {
    remove(current.request);
    answering = false;
  }
}
