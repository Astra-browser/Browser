/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from "vitest";
import { mockCanvasDocs } from "../lib/mock-stream";
import { canvasStepPlan } from "../lib/plan-tasks";

const docs = () => mockCanvasDocs();
const byKind = (kind: string) => docs().find((doc) => doc.kind === kind)!;

test("a plan doc's steps become a StepPlan for its lane's Work", () => {
  const plan = canvasStepPlan(byKind("plan"), "canvas-plan", "objective");
  expect(plan).not.toBeNull();
  expect(plan?.result).toBe("canvas-plan");
  expect(plan?.work).toBe("objective");
  expect(plan?.steps.map((step) => step.title)).toEqual([
    "Book the train from Porto on Friday",
    "Pack the adapter",
    "Buy the museum tickets",
    "Confirm the stay check-in time",
  ]);
});

test("anything but a plan has no steps to make tasks from", () => {
  for (const kind of ["table", "chart", "diagram", "code", "document"] as const) {
    expect(canvasStepPlan(byKind(kind), byKind(kind).id, "objective")).toBeNull();
  }
  const empty = {
    ...byKind("plan"),
    artifact: {
      ...byKind("plan").artifact,
      content: { kind: "checklist", items: [] },
    },
  } as never;
  expect(canvasStepPlan(empty, "canvas-plan", "objective")).toBeNull();
});

test("a longer plan stays whole at the same cap the Work board applies", () => {
  const plan = byKind("plan");
  const long = {
    ...plan,
    artifact: {
      ...plan.artifact,
      content: {
        kind: "checklist",
        items: Array.from({ length: 20 }, (_, index) => ({
          text: `Step ${index + 1}`,
          completed: false,
        })),
      },
    },
  } as never;
  expect(canvasStepPlan(long, "canvas-plan", "objective")?.steps).toHaveLength(12);
});
