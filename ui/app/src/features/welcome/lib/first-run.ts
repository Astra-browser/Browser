import { commands } from "$shared/ipc/bindings";

/** Bridge setting recording that the welcome flow was finished. */
export const COMPLETED_KEY = "onboarding.completed";
/** Bridge setting holding the chosen appearance. */
export const THEME_KEY = "appearance.theme";

export const THEMES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEMES)[number];

/** The welcome flow's outcome: the profile name lives in the run, the theme
 *  and completion persist through the bridge. */
export type WelcomeResult = { profileName: string; theme: ThemeChoice };

export function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** True when the welcome flow still has to run. Unreadable state fails
 *  open: a missing bridge means first run. */
export async function isFirstRun(): Promise<boolean> {
  try {
    return (await commands.settingGet(COMPLETED_KEY)) !== "true";
  } catch {
    return true;
  }
}

/** The stored appearance, falling back to the system choice. */
export async function readTheme(): Promise<ThemeChoice> {
  try {
    const stored = await commands.settingGet(THEME_KEY);
    return isThemeChoice(stored) ? stored : "system";
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
