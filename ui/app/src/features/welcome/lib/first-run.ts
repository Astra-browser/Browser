import { commands } from "$shared/ipc/bindings";

/** Bridge setting recording that the onboarding flow was finished. The key
 *  and its `"true"`/`"false"` values are the ones `astra_core::settings`
 *  validates. */
export const COMPLETED_KEY = "onboarding.completed";
/** Bridge setting holding the chosen appearance. One spelling, the one
 *  `astra_core::settings` validates (`appearance.theme`); the appearance
 *  picker reads and writes the same key. */
export const THEME_KEY = "appearance.theme";
/** The spelling builds before 0.1.755 wrote. Read once to adopt it, never
 *  written. */
export const LEGACY_THEME_KEY = "appearance";

export const THEMES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEMES)[number];

/** The welcome flow's outcome: the profile name lives in the run, the theme
 *  and completion persist through the bridge. */
export type WelcomeResult = { profileName: string; theme: ThemeChoice };

export function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The first-run rule, in one place for the page and its host counterpart
 * (`Boot.onboardingDecision`): a private window never opens onboarding, and
 * only the stored `"true"` means it is done. Unreadable state is `null`, which
 * fails open.
 */
export function shouldOpenOnboarding(completed: string | null, isPrivate = false): boolean {
  return isPrivate !== true && completed !== "true";
}

/** True when the onboarding flow still has to run. Unreadable state fails
 *  open: a missing bridge means first run. */
export async function isFirstRun(): Promise<boolean> {
  try {
    return shouldOpenOnboarding(await commands.settingGet(COMPLETED_KEY));
  } catch {
    return true;
  }
}

/** The stored appearance, migrating the pre-0.1.755 spelling to the key the
 *  core validates. Falls back to the system choice. */
export async function readTheme(): Promise<ThemeChoice> {
  try {
    const stored = await commands.settingGet(THEME_KEY);
    if (isThemeChoice(stored)) return stored;
    const legacy = await commands.settingGet(LEGACY_THEME_KEY);
    if (isThemeChoice(legacy)) {
      // Adopt it now so the picker and the core read one key from here on.
      await commands.settingSet(THEME_KEY, legacy).catch(() => null);
      return legacy;
    }
    return "system";
  } catch {
    return "system";
  }
}

/** Persists the welcome flow's outcome: the theme, then the first-run flag.
 *  Throws when the bridge refuses a write. */
export async function persistWelcome(theme: ThemeChoice): Promise<void> {
  const themed = await commands.settingSet(THEME_KEY, theme);
  if (!themed.accepted) throw new Error(`bridge refused ${THEME_KEY}`);
  const done = await commands.settingSet(COMPLETED_KEY, "true");
  if (!done.accepted) throw new Error(`bridge refused ${COMPLETED_KEY}`);
}
