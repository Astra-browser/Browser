import { describe, expect, it } from "vitest";
import { passkeyErrorMessage, passkeyPromptMessage, passkeyStateLabel } from "../passkey-model";

describe("passkey copy", () => {
  it("maps every Settings error code to a non-empty sentence", () => {
    for (const code of [
      "auth",
      "pin_policy",
      "locked",
      "rate_limited",
      "unavailable",
      "not_initialized",
      "unsupported",
    ]) {
      expect(passkeyErrorMessage(code).length).toBeGreaterThan(0);
    }
    expect(passkeyErrorMessage(null)).toBe("");
  });

  it("names the state the person is in", () => {
    expect(passkeyStateLabel(false, true, true)).toBe("Passkeys are off");
    expect(passkeyStateLabel(true, false, false)).toBe("Passkeys are off");
    expect(passkeyStateLabel(true, true, false)).toBe("Locked");
    expect(passkeyStateLabel(true, true, true)).toBe("Unlocked");
  });

  it("keeps private-window and PIN prompts distinct", () => {
    expect(passkeyPromptMessage({ type: "private-blocked" }, "example.com")).toMatch(/private/i);
    expect(passkeyPromptMessage({ type: "pin-required" }, "example.com")).toMatch(/example\.com/);
    expect(passkeyPromptMessage({ type: "pin-invalid", retries: 3 }, "example.com")).toMatch(
      /incorrect/i,
    );
  });
});
