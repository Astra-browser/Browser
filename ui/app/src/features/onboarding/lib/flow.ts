import { flags } from "$shared/flags";

export type Step = "welcome" | "import" | "essentials" | "launcher" | "work" | "ai" | "ready";

export const STEPS: readonly Step[] = [
  "welcome",
  "import",
  "essentials",
  "launcher",
  "work",
  "ai",
  "ready",
];

/** The steps a run walks: AI's pages while AI is on, and the Work demo only
 *  while Work is both on and shipped by this build. */
export const stepsFor = (ai: boolean, work = flags.work): readonly Step[] =>
  STEPS.filter((step) => {
    if (step === "work") return ai && work;
    if (step === "ai") return ai;
    return true;
  });

/** Where a step stands among the ones that count, welcome being the door
 *  rather than a step: 1-based, with the total. */
export function position(step: Step, ai = true): { at: number; of: number } {
  const counted: Step[] = stepsFor(ai).filter((candidate) => candidate !== "welcome");
  return { at: counted.indexOf(step) + 1, of: counted.length };
}

export function neighbour(step: Step, by: 1 | -1, ai = true): Step | undefined {
  const steps = stepsFor(ai);
  const next = steps[steps.indexOf(step) + by];
  return next === "welcome" ? undefined : next;
}
