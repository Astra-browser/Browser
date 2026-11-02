<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<script lang="ts">
  import type { CanvasDoc } from "../../lib/types";

  let { doc }: { doc: CanvasDoc } = $props();
  const content = $derived(doc.artifact.content.kind === "diagram" ? doc.artifact.content : null);
  const labels = $derived(
    new Map((content?.edges ?? []).map((edge) => [`${edge.from}→${edge.to}`, edge.label])),
  );
</script>

<!-- A system as the agent drew it: each part, then what flows between them. -->
{#if content}
  <ol class="flow">
    {#each content.nodes as node (node.id)}
      <li>
        <span class="name">{node.name}</span>
        {#if node.note}<span class="note">{node.note}</span>{/if}
      </li>
    {/each}
  </ol>
  {#if content.edges.length}
    <ul class="edges" aria-label="Flows">
      {#each content.edges as edge (`${edge.from}→${edge.to}`)}
        <li>
          <span class="from">{content.nodes.find((node) => node.id === edge.from)?.name}</span>
          <span class="arrow" aria-hidden="true">→</span>
          <span class="to">{content.nodes.find((node) => node.id === edge.to)?.name}</span>
          {#if labels.get(`${edge.from}→${edge.to}`)}<span class="label"
              >{labels.get(`${edge.from}→${edge.to}`)}</span
            >{/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .flow,
  .edges {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .flow {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .flow li {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-row);
    padding: 8px 12px;
    font-size: var(--text-label);
  }

  .name {
    font-weight: 600;
  }

  .note {
    display: block;
    color: var(--color-muted);
    font-size: var(--text-caption);
  }

  .edges {
    margin-block-start: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--color-muted);
    font-size: var(--text-caption);
  }

  .arrow {
    margin-inline: 6px;
  }

  .label {
    margin-inline-start: 6px;
  }
</style>
