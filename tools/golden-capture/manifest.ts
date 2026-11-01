// P0-T07 golden screen manifest: the URL/state/theme/viewport matrix.
// One entry per capture; `name` is the baseline PNG stem. Desktop covers all
// eight major screens in both themes; the narrow viewport proves the sidebar
// column still reads at phone widths (sidebar/tabs/spaces only — pages are
// desktop-first in this matrix).

export interface Capture {
  /** Baseline PNG stem (".png" appended by the runner). */
  name: string;
  screen:
    | "shell"
    | "spaces"
    | "newtab"
    | "launcher"
    | "tasks"
    | "notes"
    | "time"
    | "settings";
  theme: "light" | "dark";
  width: number;
  height: number;
}

const DESKTOP = { width: 1440, height: 900 };

const SCREENS: Capture["screen"][] = [
  "shell",
  "spaces",
  "newtab",
  "launcher",
  "tasks",
  "notes",
  "time",
  "settings",
];

const THEMES: Capture["theme"][] = ["light", "dark"];

export const MATRIX: Capture[] = [
  ...SCREENS.flatMap((screen) =>
    THEMES.map((theme) => ({
      name: `${screen}-${theme}`,
      screen,
      theme,
      ...DESKTOP,
    })),
  ),
  // Narrow column: sidebar/tabs/spaces only.
  {
    name: "shell-light-narrow",
    screen: "shell",
    theme: "light",
    width: 390,
    height: 844,
  },
  {
    name: "shell-dark-narrow",
    screen: "shell",
    theme: "dark",
    width: 390,
    height: 844,
  },
];

/** Pinned wall-clock instant for every capture (a Monday, like the benches). */
export const PINNED_ISO = "2026-09-28T14:32:00.000Z";
