/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The canvas feature's public surface.
 *
 *  The run's outcome as docs (tables, charts, diagrams, plans, code,
 *  documents): a feed of renderable docs, plan→tasks through the same
 *  `WorkTasks` the tasks UI uses, save→notes through the same `WorkNotes`
 *  the notes UI uses. Mock docs stand in until the agent runtime lands
 *  a step stream wire.
 */
export const loadCanvasSurface = () => import("./components/CanvasSurface.svelte");
export { mockCanvasDocs, mockStepEvents } from "./lib/mock-stream";
export { toCanvasDocs, docKindFor } from "./lib/mock-stream";
export { canvasStepPlan, makeCanvasPlanTasks } from "./lib/plan-tasks";
export { canvasNoteMarkdown, saveCanvasNote } from "./lib/save-note";
export type { StepPlan } from "./lib/plan-tasks";
export type { CanvasDoc, CanvasDocKind, CanvasStepEvent } from "./lib/types";
