<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<script lang="ts">
  import { artifactRenderable } from "$shared/ui/data/Artifact/artifact";
  import * as m from "$shared/i18n/messages";
  import type { NoteSession } from "$domain/notes";
  import type { CanvasDoc } from "../lib/types";
  import { canvasNoteMarkdown, saveCanvasNote } from "../lib/save-note";
  import { canvasStepPlan, makeCanvasPlanTasks } from "../lib/plan-tasks";
  import type { WorkNotes } from "../../lib/work-notes";
  import type { WorkTasks } from "../../lib/work-tasks";
  import TableCanvas from "./renderers/TableCanvas.svelte";
  import ChartCanvas from "./renderers/ChartCanvas.svelte";
  import DiagramCanvas from "./renderers/DiagramCanvas.svelte";
  import PlanCanvas from "./renderers/PlanCanvas.svelte";
  import CodeCanvas from "./renderers/CodeCanvas.svelte";
  import DocumentCanvas from "./renderers/DocumentCanvas.svelte";

  let {
    docs,
    tasks = null,
    workId = "",
    notes = null,
    session = null,
  }: {
    /** The run's docs, oldest first; the feed owns the order. */
    docs: readonly CanvasDoc[];
    /** The person's tasks, for plan docs; without it plans carry no action. */
    tasks?: WorkTasks | null;
    /** The lane a plan's steps are written to, the task's reserved `work` field. */
    workId?: string;
    /** The notes written from document docs, for save→notes. */
    notes?: WorkNotes | null;
    session?: NoteSession | null;
  } = $props();

  const renderable = (doc: CanvasDoc) => artifactRenderable(doc.artifact);
  const planState = (doc: CanvasDoc) => tasks?.state(doc.id) ?? "none";
  const noteId = (doc: CanvasDoc) => notes?.note(doc.id);
  const savingNote = (doc: CanvasDoc) => notes?.saving(doc.id) ?? false;
</script>

<!-- The run's outcome as docs: one section per doc, its steps, then its hand-off. -->
<div class="canvas" data-ready="true" role="feed" aria-label="Canvas">
  {#each docs as doc (doc.id)}
    <article class="doc" aria-label={doc.title}>
      <header>
        <p class="kind">{doc.kind}</p>
        <h2>{doc.title}</h2>
        <p class="status">{doc.status}</p>
      </header>
      {#if !renderable(doc)}
        <p role="alert">{m.work_artifact_unavailable()}</p>
      {:else if doc.kind === "table"}
        <TableCanvas {doc} />
      {:else if doc.kind === "chart"}
        <ChartCanvas {doc} />
      {:else if doc.kind === "diagram"}
        <DiagramCanvas {doc} />
      {:else if doc.kind === "plan"}
        <PlanCanvas {doc} />
      {:else if doc.kind === "code"}
        <CodeCanvas {doc} />
      {:else}
        <DocumentCanvas {doc} />
      {/if}
      {#if doc.steps.length}
        <ol class="steps">
          {#each doc.steps as step (step.seq)}
            <li>{step.summary}</li>
          {/each}
        </ol>
      {/if}
      {#if doc.kind === "plan" && tasks && canvasStepPlan(doc, doc.id, workId)}
        {@const state = planState(doc)}
        {#if state === "ready"}
          <button type="button" onclick={() => void makeCanvasPlanTasks(tasks, doc.id)}>
            {m.work_make_tasks()}
          </button>
          <p class="hint">{m.work_make_tasks_hint()}</p>
        {:else if state === "making"}
          <p class="pending" role="status">{m.work_making_tasks()}</p>
        {:else if state === "made"}
          {@const made = tasks.tasks(doc.id)}
          <ul class="made">
            {#each made as task (task?.id)}
              {#if task}
                <li>
                  <button type="button" onclick={() => tasks.open(task.id)}>
                    {m.work_open_in_tasks()}: {task.title}
                  </button>
                </li>
              {/if}
            {/each}
          </ul>
        {:else if tasks.failed}
          <p role="alert">{m.work_tasks_failed()}</p>
          <button type="button" onclick={() => void makeCanvasPlanTasks(tasks, doc.id)}>
            {m.work_make_tasks()}
          </button>
        {/if}
      {/if}
      {#if doc.kind === "document" && notes && canvasNoteMarkdown(doc)}
        {#if noteId(doc)}
          <p class="pending">{m.work_note_on_canvas()}</p>
        {:else if savingNote(doc)}
          <p class="pending" role="status">{m.work_saving_note()}</p>
        {:else}
          <button type="button" onclick={() => void saveCanvasNote(notes, doc, doc.id, session)}>
            {m.work_save_note()}
          </button>
          {#if notes.failed}
            <p role="alert">{m.work_note_failed()}</p>
          {/if}
        {/if}
      {/if}
    </article>
  {:else}
    <p class="empty">{m.work_empty_data()}</p>
  {/each}
</div>

<style>
  .canvas {
    display: flex;
    flex-direction: column;
    gap: 24px;
    min-width: 0;
    color: var(--color-text);
  }

  .doc {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-card);
    padding: 16px;
    background: var(--color-surface);
  }

  header {
    margin-block-end: 12px;
  }

  .kind {
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-faint);
    font-size: var(--text-caption);
  }

  h2 {
    margin: 4px 0;
    font-size: var(--text-title);
    font-weight: 600;
  }

  .status {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--text-caption);
  }

  .steps {
    margin: 12px 0 0;
    padding-inline-start: 20px;
    color: var(--color-muted);
    font-size: var(--text-caption);
  }

  button {
    margin-block-start: 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    padding: 6px 12px;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-label);
  }

  button:hover {
    border-color: var(--color-text);
  }

  button:focus-visible {
    outline: 2px solid var(--color-text);
    outline-offset: 2px;
  }

  .hint,
  .pending {
    margin-block: 8px 0;
    color: var(--color-muted);
    font-size: var(--text-caption);
  }

  .made {
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .made button {
    margin-block-start: 0;
  }

  .empty {
    color: var(--color-faint);
  }

  p[role="alert"] {
    color: var(--color-text);
  }

  @media (prefers-reduced-motion: reduce) {
    .doc {
      transition: none;
    }
  }
</style>
