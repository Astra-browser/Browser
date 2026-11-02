/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The agent step stream the canvas draws, and what it draws from it.
 *
 *  Until the agent runtime (P6-T05) lands a stream wire, the feed is
 *  deterministic mock data: one doc per renderer kind, each satisfying
 *  `artifactRenderable` so the surface never draws a truncated result as
 *  the complete artifact. Renderers own display; this module owns the feed.
 */
import {
  artifactRenderable,
  type ArtifactContent,
  type ArtifactView,
} from "$shared/ui/data/Artifact/artifact";
import type { CanvasDoc, CanvasDocKind, CanvasStepEvent } from "./types";

/** Which canvas doc an artifact becomes; null draws nothing (never truncated). */
export function docKindFor(content: ArtifactContent): CanvasDocKind | null {
  switch (content.kind) {
    case "table":
    case "comparison":
      return "table";
    case "chart":
      return "chart";
    case "diagram":
      return "diagram";
    case "checklist":
      return "plan";
    case "code":
      return "code";
    case "document":
    case "answer":
      return "document";
    default:
      return null;
  }
}

/**
 * Artifact views as canvas docs: kinds the canvas has no renderer for, and
 * views over the renderer ceilings, are left out rather than drawn halfway.
 */
export function toCanvasDocs(
  views: readonly ArtifactView[],
  stepsFor: (id: string) => readonly CanvasStepEvent[] = () => [],
): CanvasDoc[] {
  const docs: CanvasDoc[] = [];
  for (const artifact of views) {
    const kind = docKindFor(artifact.content);
    if (!kind || !artifactRenderable(artifact)) continue;
    docs.push({
      id: artifact.key,
      kind,
      title: artifact.title,
      status: artifact.reviewLabel,
      artifact,
      steps: stepsFor(artifact.key),
    });
  }
  return docs;
}

const step = (seq: number, kind: CanvasStepEvent["kind"], summary: string): CanvasStepEvent => ({
  seq,
  kind,
  summary,
});

function views(): ArtifactView[] {
  const reviewLabel = "Reviewed against its sources";
  return [
    {
      key: "canvas-table",
      title: "Harbor plan pricing",
      reviewLabel,
      evidence: [],
      content: {
        kind: "table",
        columns: ["Plan", "Build minutes", "Price"],
        rows: [
          ["Starter", "2,000", "$29"],
          ["Team", "10,000", "$99"],
          ["Studio", "40,000", "$249"],
        ],
      },
    },
    {
      key: "canvas-chart",
      title: "Weekday focus hours",
      reviewLabel,
      evidence: [],
      content: {
        kind: "chart",
        xLabel: "Day",
        yLabel: "Hours",
        series: [
          {
            name: "Focus",
            points: [
              { label: "Mon", value: "3" },
              { label: "Tue", value: "5" },
              { label: "Wed", value: "4" },
              { label: "Thu", value: "6" },
              { label: "Fri", value: "2" },
            ],
          },
          {
            name: "Meetings",
            points: [
              { label: "Mon", value: "2" },
              { label: "Tue", value: "1" },
              { label: "Wed", value: "2" },
              { label: "Thu", value: "1" },
              { label: "Fri", value: "3" },
            ],
          },
        ],
      },
    },
    {
      key: "canvas-diagram",
      title: "Trip planning flow",
      reviewLabel,
      evidence: [],
      content: {
        kind: "diagram",
        nodes: [
          { id: "search", name: "Search stays", kind: "tool", note: "Harbor listings" },
          { id: "compare", name: "Compare totals", kind: "step" },
          { id: "book", name: "Book the stay", kind: "action" },
        ],
        edges: [
          { from: "search", to: "compare", label: "candidates" },
          { from: "compare", to: "book", label: "cheapest total" },
        ],
        layers: [],
      },
    },
    {
      key: "canvas-plan",
      title: "Lisbon trip steps",
      reviewLabel,
      evidence: [],
      content: {
        kind: "checklist",
        items: [
          { text: "Book the train from Porto on Friday", completed: true },
          { text: "Pack the adapter", completed: false },
          { text: "Buy the museum tickets", completed: false },
          { text: "Confirm the stay check-in time", completed: false },
        ],
      },
    },
    {
      key: "canvas-code",
      title: "Total cost helper",
      reviewLabel,
      evidence: [],
      content: {
        kind: "code",
        language: "python",
        text: "def total(nights: int, rate: float, fee: float) -> float:\n    return nights * rate + fee\n",
        notes: [{ from: 2, to: 2, text: "Fee added once, not per night." }],
      },
    },
    {
      key: "canvas-document",
      title: "Lisbon notes",
      reviewLabel,
      evidence: [],
      content: {
        kind: "document",
        paragraphs: [
          "Three nights in Lisbon, arriving Friday by train from Porto.",
          "Stay near the Alfama; the museum tickets are already bought.",
        ],
        formatted: {
          version: 1,
          document: {
            type: "doc",
            content: [
              {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: "Lisbon notes" }],
              },
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Three nights in Lisbon, arriving Friday by train." },
                ],
              },
            ],
          },
        },
      },
    },
  ];
}

function stepsFor(id: string): CanvasStepEvent[] {
  const trail: Record<string, [CanvasStepEvent["kind"], string][]> = {
    "canvas-table": [
      ["observe", "Read the Harbor pricing page"],
      ["tool-result", "Kept the three plans and their prices"],
    ],
    "canvas-chart": [
      ["observe", "Read this week's focus sessions"],
      ["plan", "Plotted focus against meetings by day"],
    ],
    "canvas-diagram": [
      ["plan", "Drew the trip as three stages"],
      ["tool-result", "Linked each stage to the next"],
    ],
    "canvas-plan": [
      ["plan", "Listed the four Lisbon steps"],
      ["tool-call", "Checked the adapter against the packing list"],
    ],
    "canvas-code": [
      ["tool-call", "Wrote the total-cost helper"],
      ["tool-result", "Noted the fee applies once"],
    ],
    "canvas-document": [
      ["message", "Summarized the Lisbon notes"],
      ["done", "Kept the two paragraphs that matter"],
    ],
  };
  return (trail[id] ?? []).map(([kind, summary], index) => step(index, kind, summary));
}

/** The deterministic mock feed: one renderable doc per renderer kind. */
export function mockCanvasDocs(): CanvasDoc[] {
  return toCanvasDocs(views(), stepsFor);
}

/** The mock run's visible steps, oldest first, across every doc. */
export function mockStepEvents(): CanvasStepEvent[] {
  return mockCanvasDocs().flatMap((doc) => doc.steps);
}
