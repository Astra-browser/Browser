/**
 * Build-time product flags.
 *
 * A flag is off unless its Vite environment variable is exactly `"true"`.
 * Flipping one is a release decision, not a preference the person can change
 * in Settings: an off flag removes the surface from the product instead of
 * leaving a disabled control behind.
 */

/** The one reading of a flag's environment value. Anything but `"true"` is off. */
export const isOn = (value: string | undefined) => value === "true";

export const flags = {
  /**
   * Work: the agent environment beside Browse, its rail switch, its canvas
   * and its Settings pages. Off for Beta 1. Build with
   * `VITE_ASTRA_WORK=true` to develop the surface.
   */
  work: isOn(import.meta.env.VITE_ASTRA_WORK),
  /**
   * AI: the Ask Astra panel, its shelf tool, models, dictation, skills, memory,
   * site styles and the MCP connections. **Off**: no AI surface is built into
   * the product at all — not a hidden switch, an absent one. Build with
   * `VITE_ASTRA_AI=true` to develop it.
   */
  ai: isOn(import.meta.env.VITE_ASTRA_AI),
  /**
   * Account: Sign in to Astra, the account foot, plan and credits. **Off**:
   * no sign-in, no identity group in Settings. Build with
   * `VITE_ASTRA_ACCOUNT=true` to develop it.
   */
  account: isOn(import.meta.env.VITE_ASTRA_ACCOUNT),
} as const;
