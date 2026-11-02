<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import type { CanvasDoc } from "../../lib/types";

  let { doc }: { doc: CanvasDoc } = $props();
  const content = $derived(doc.artifact.content.kind === "checklist" ? doc.artifact.content : null);
</script>

<!-- A plan as its steps: done steps strike through, open steps stay plain. -->
{#if content}
  <ul class="steps">
    {#each content.items as item (item.text)}
      <li class:done={item.completed}>
        <span
          class="mark"
          aria-label={item.completed ? m.work_item_complete() : m.work_item_open()}
          aria-hidden="false">✓</span
        >
        <span class="text">{item.text}</span>
      </li>
    {:else}
      <li class="empty">{m.work_empty_data()}</li>
    {/each}
  </ul>
{/if}

<style>
  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .steps li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: var(--text-label);
  }

  .mark {
    color: var(--color-faint);
    font-weight: 700;
  }

  li.done .mark {
    color: var(--color-text);
  }

  li.done .text {
    text-decoration: line-through;
    color: var(--color-muted);
  }

  .empty {
    color: var(--color-faint);
  }
</style>
