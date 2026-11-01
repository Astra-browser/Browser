/** The welcome flow's steps: a door, three choices, a stub, and the end.
 *  The import step is a stub until P4 (P3-T10): it renders disabled with a
 *  "coming soon" note and is never a dead button. */
export const WELCOME_STEPS = ["welcome", "profile", "theme", "import", "done"] as const;

export type WelcomeStep = (typeof WELCOME_STEPS)[number];

/** The step after (or before) the given one, if any. */
export function neighbour(step: WelcomeStep, by: 1 | -1): WelcomeStep | undefined {
  const next = WELCOME_STEPS[WELCOME_STEPS.indexOf(step) + by];
  // Welcome is the door, never a destination to step back through.
  return next === "welcome" ? undefined : next;
}

/** Where a step stands among the ones that count, welcome being the door
 *  rather than a step: 1-based, with the total. */
export function position(step: WelcomeStep): { at: number; of: number } {
  const counted: readonly WelcomeStep[] = WELCOME_STEPS.filter(
    (candidate) => candidate !== "welcome",
  );
  return { at: counted.indexOf(step) + 1, of: counted.length };
}
