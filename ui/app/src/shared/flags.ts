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
} as const;
