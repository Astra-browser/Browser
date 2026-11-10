import type {
  PasskeyCall,
  PasskeyCredentialView,
  PasskeyPromptChanged,
  PasskeyResponse,
  PasskeyStatusView,
} from "$shared/ipc/bindings";
import { commands } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";

let status = $state.raw<PasskeyStatusView | null>(null);
let credentials = $state.raw<PasskeyCredentialView[]>([]);
let busy = $state(false);
let failure = $state<string | null>(null);
let pending = $state.raw<PasskeyPromptChanged | null>(null);
let answering = $state(false);
let stop: (() => void) | null = null;

export const current = () => status;
export const list = () => credentials;
export const isBusy = () => busy;
export const error = () => failure;
export const prompt = () => pending;
export const isAnswering = () => answering;

function apply(response: PasskeyResponse): PasskeyResponse {
  status = response.status;
  credentials = response.credentials;
  failure = response.error;
  return response;
}

export async function call(request: PasskeyCall): Promise<PasskeyResponse | null> {
  if (busy) return null;
  busy = true;
  try {
    // The vault KDF runs on the main thread in the settings service; let the
    // pending state paint before the call takes it.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return apply(await commands.passkeyCall(request));
  } catch {
    failure = "unavailable";
    return null;
  } finally {
    busy = false;
  }
}

export async function refresh(): Promise<void> {
  await call({ kind: "status" });
}

/** Attach the prompt listener once per app lifetime. */
export async function start(): Promise<void> {
  if (stop !== null) return;
  stop = await events.passkeyPromptChanged.listen((event) => {
    const payload = event.payload;
    // A sheet is open only while the engine has a prompt for it.
    pending = payload.prompt === null ? null : payload;
    answering = false;
  });
}

/** Close the sheet without answering a wanted prompt. */
export function dismiss(): void {
  pending = null;
}

export async function answer(
  action: "pin" | "select" | "cancel",
  value?: string,
): Promise<boolean> {
  const currentPrompt = pending;
  // Informational prompts (private-blocked) have no browser transaction to
  // answer; closing the sheet is the whole response.
  if (currentPrompt?.tid === undefined) {
    pending = null;
    return false;
  }
  if (answering) return false;
  answering = true;
  try {
    return await commands.passkeyAnswerPrompt(currentPrompt.tid, action, value ?? null);
  } catch {
    return false;
  } finally {
    answering = false;
    pending = null;
  }
}
