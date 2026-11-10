import type { PasskeyPrompt } from "$shared/ipc/bindings";
import * as m from "$shared/i18n/messages";

/** Closed copy for a vault operation's error code. */
export function passkeyErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "auth":
      return m.passkey_error_auth();
    case "pin_policy":
      return m.passkey_error_pin_policy();
    case "locked":
      return m.passkey_error_locked();
    case "rate_limited":
      return m.passkey_error_locked();
    case "unavailable":
    case "not_initialized":
    case "unsupported":
      return m.passkey_error_unavailable();
    default:
      return "";
  }
}

/** Closed copy for a prompt the engine raised. */
export function passkeyPromptMessage(prompt: PasskeyPrompt, origin: string): string {
  switch (prompt.type) {
    case "private-blocked":
      return m.passkey_prompt_private();
    case "pin-invalid":
    case "uv-invalid":
      return m.passkey_prompt_pin_invalid();
    case "pin-auth-blocked":
    case "device-blocked":
    case "uv-blocked":
      return m.passkey_prompt_pin_blocked();
    case "already-registered":
      return m.passkey_prompt_already();
    case "pin-not-set":
    case "select-device":
      return m.passkey_prompt_blocked();
    default:
      return m.passkey_prompt_pin({ origin });
  }
}

/** The Settings row's state line. */
export function passkeyStateLabel(enabled: boolean, exists: boolean, unlocked: boolean): string {
  if (!enabled) return m.passkey_state_off();
  if (!exists) return m.passkey_state_off();
  return unlocked ? m.passkey_unlocked() : m.passkey_locked();
}
