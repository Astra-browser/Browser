// P0-T07 golden mocks for `@tauri-apps/api/core`.
// The generated bindings call `invoke(command, args)` for every native call.
// This router answers with deterministic fixtures; anything unlisted is logged
// and answered with null so a missing fixture is visible in the capture log
// instead of crashing the page mid-screenshot.
import { answer } from "./router";

export async function invoke<T>(command: string, args?: unknown): Promise<T> {
  return answer<T>(command, args);
}

// Re-exports the transport pieces bindings.ts reaches through
// `__TAURI_EVENT` (imported from `@tauri-apps/api/event`, not core), plus the
// channel helpers some domains import directly. Kept here so the golden vite
// aliases need only one core module.
export type { Event, EventCallback } from "./tauri-event";
export { listen, once, emit } from "./tauri-event";
