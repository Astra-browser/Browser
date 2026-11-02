# Canvas UI (P6-T06)

The run's outcome as docs: `ui/app/src/features/work/canvas/`. Six
renderers — tables, charts, diagrams, plans, code, documents — fed by the
agent step stream (deterministic mock data until the agent runtime lands a
stream wire), with plan→tasks and save→notes hand-offs.

## Layout

- `lib/types.ts` — display-only `CanvasDoc` / `CanvasDocKind` /
  `CanvasStepEvent`. Display-only on purpose: independent from the generated
  Work wire contract, which the runtime track owns.
- `lib/mock-stream.ts` — the feed. `docKindFor` maps an `ArtifactView` to
  the doc it draws (or null: kinds without a renderer, and views over the
  `artifactRenderable` ceilings, are left out rather than drawn halfway).
  `toCanvasDocs` applies that mapping; `mockCanvasDocs` is the deterministic
  mock feed (one renderable doc per kind), `mockStepEvents` its visible steps.
- `lib/plan-tasks.ts` — plan→tasks. `canvasStepPlan` runs the same path the
  tasks UI uses (`planSteps` capped by `resultPlan`, into `stepPlan`);
  `makeCanvasPlanTasks` delegates to the same `WorkTasks.make`, so a canvas
  plan issues one `ResourceCall` mutate per missing step and a spent lane is
  refused exactly like the Work board.
- `lib/save-note.ts` — save→notes. `canvasNoteMarkdown` runs the same
  `documentMarkdown` the notes UI uses; `saveCanvasNote` delegates to the
  same `WorkNotes.save` (one note per doc, written only when asked).
- `components/CanvasSurface.svelte` — the surface: one section per doc, its
  visible steps, then its hand-off (plan→tasks, document→note). Light+dark
  through semantic tokens; keyboard-accessible buttons; `role="alert"` for
  unrenderable docs and failed hand-offs; reduced-motion safe.
- `components/renderers/` — one thin renderer per kind over shared
  primitives (`Table`, `WorkChart`, `CodeBlock`, `DocumentView`), plus
  canvas-owned styling for diagrams (parts, then flows) and plans
  (struck-through done steps).

## Tests

- `tests/mock-stream.test.ts` — kind mapping, renderability, determinism.
- `tests/plan-tasks.test.ts` — StepPlan shape, non-plan null, the 12-step cap.
- `tests/save-note.test.ts` — Markdown shape, delegation, non-document null.
- `tests/CanvasSurface.component.test.ts` — all six docs in light+dark, a
  plan's steps becoming agent tasks through `resourceCall` only when asked,
  a document saved as a note only when asked and only once.

## Golden baselines

Not yet: the golden harness (`tools/golden-capture/manifest.ts`,
`ui/app/golden/screens.ts`) only covers its eight fixed screens, and
extending the matrix, the screen setup, and the runner is outside P6-T06's
file scope. Light+dark coverage for the canvas lives in the component test
above until a golden-matrix extension lands. When it does, add
`canvas-light` / `canvas-dark` captures from the mock feed and record them
in `tests/golden/MANIFEST.md` and `tests/golden/in-firefox/`.
