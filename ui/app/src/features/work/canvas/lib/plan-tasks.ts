/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** A plan doc's steps as the person's tasks.
 *
 *  The same path the tasks UI uses: `planSteps` (capped by `resultPlan`,
 *  the cap the Work board applies) into `stepPlan`, then `WorkTasks.make`
 *  issues one `ResourceCall` mutate per missing step. Nothing here drafts
 *  tasks its own way; this module only names the doc a plan came from.
 */
import { resultPlan } from "../../lib/plan-steps";
import { stepPlan, type StepPlan, type WorkTasks } from "../../lib/work-tasks";
import type { CanvasDoc } from "./types";

/** The plan doc's steps as tasks would carry them; null when it has none. */
export function canvasStepPlan(doc: CanvasDoc, result: string, work: string): StepPlan | null {
  if (doc.kind !== "plan") return null;
  const steps = resultPlan(doc.artifact.content);
  if (!steps.length) return null;
  return stepPlan(result, work, doc.artifact, steps);
}

export type { StepPlan };

/**
 * One task per step not yet made, through the same `WorkTasks` the tasks UI
 * uses: one `ResourceCall` mutate per missing step, a lane spent refused.
 */
export function makeCanvasPlanTasks(tasks: WorkTasks, result: string): Promise<boolean> {
  return tasks.make(result);
}
