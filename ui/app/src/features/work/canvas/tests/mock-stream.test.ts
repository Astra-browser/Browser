/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from "vitest";
import { artifactRenderable, type ArtifactContent } from "$shared/ui/data/Artifact/artifact";
import { docKindFor, mockCanvasDocs, mockStepEvents, toCanvasDocs } from "../lib/mock-stream";
import { canvasDocKinds } from "../lib/types";

const kinds: ArtifactContent["kind"][] = [
  "table",
  "comparison",
  "matrix",
  "findings",
  "chart",
  "checklist",
  "sources",
  "browser",
  "diagram",
  "code",
  "answer",
  "document",
  "unavailable",
];

test("every artifact kind either maps to a canvas renderer or is left out", () => {
  const mapped = kinds.map((kind) => docKindFor({ kind } as ArtifactContent));
  expect(mapped).toEqual([
    "table",
    "table",
    null,
    null,
    "chart",
    "plan",
    null,
    null,
    "diagram",
    "code",
    "document",
    "document",
    null,
  ]);
});

test("the mock feed draws one renderable doc per renderer kind, deterministically", () => {
  const first = mockCanvasDocs();
  expect(first.map((doc) => doc.kind).toSorted()).toEqual([...canvasDocKinds].toSorted());
  for (const doc of first) {
    expect(doc.id).toBe(doc.artifact.key);
    expect(doc.title).toBe(doc.artifact.title);
    expect(artifactRenderable(doc.artifact)).toBe(true);
    expect(doc.steps.length).toBeGreaterThan(0);
    expect(doc.steps.map((step) => step.seq)).toEqual(doc.steps.map((_, index) => index));
  }
  expect(mockCanvasDocs()).toEqual(first);
  expect(mockStepEvents()).toEqual(first.flatMap((doc) => doc.steps));
});

test("kinds without a renderer and views over the ceilings are left out, not drawn halfway", () => {
  const docs = mockCanvasDocs();
  const views = [
    ...docs.map((doc) => doc.artifact),
    {
      key: "too-big",
      title: "Too big",
      reviewLabel: "review",
      evidence: [],
      content: {
        kind: "table",
        columns: Array.from({ length: 33 }, (_, index) => `c${index}`),
        rows: [],
      },
    },
    {
      key: "matrix",
      title: "Matrix",
      reviewLabel: "review",
      evidence: [],
      content: { kind: "matrix", subjects: [], criteria: [], cells: [], notes: [] },
    },
  ] as never;
  const kept = toCanvasDocs(views);
  expect(kept.map((doc) => doc.id)).toEqual(docs.map((doc) => doc.id));
  expect(toCanvasDocs([], () => [{ seq: 0, kind: "done", summary: "x" }])).toEqual([]);
});
