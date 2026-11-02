/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The canvas document shapes, as the canvas draws them.
 *
 *  Display-only component types: deliberately independent from the generated
 *  Work wire contract (which the runtime track owns). A doc carries the
 *  shared artifact view it renders plus the visible steps that produced it.
 */
import type { ArtifactView } from "$shared/ui/data/Artifact";

export type CanvasDocKind = "table" | "chart" | "diagram" | "plan" | "code" | "document";

/** One visible step of the agent run behind a doc: what happened, in words. */
export type CanvasStepEvent = {
  seq: number;
  kind: "observe" | "message" | "tool-call" | "tool-result" | "approval" | "plan" | "done";
  summary: string;
  detail?: string;
};

export type CanvasDoc = {
  /** Stable identity for one canvas: also the plan→tasks result key. */
  id: string;
  kind: CanvasDocKind;
  title: string;
  status: string;
  artifact: ArtifactView;
  /** The run's visible steps behind this doc, oldest first. */
  steps: readonly CanvasStepEvent[];
};

/** Every kind the canvas renders, for exhaustiveness checks. */
export const canvasDocKinds: readonly CanvasDocKind[] = [
  "table",
  "chart",
  "diagram",
  "plan",
  "code",
  "document",
];
