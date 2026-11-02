<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<script lang="ts">
  import Table from "$shared/ui/data/Artifact/Table.svelte";
  import { tableGrid } from "$shared/ui/data/Artifact/table";
  import type { CanvasDoc } from "../../lib/types";

  let { doc }: { doc: CanvasDoc } = $props();
  const content = $derived(
    doc.artifact.content.kind === "table" || doc.artifact.content.kind === "comparison"
      ? doc.artifact.content
      : null,
  );
  const grid = $derived(content ? tableGrid(content) : null);
</script>

<!-- A table the run kept: sortable, with its sticky header and first column. -->
{#if grid}<Table caption={doc.title} columns={grid.columns} rows={grid.rows} />{/if}

<style>
  :global(.canvas-table table) {
    font-size: var(--text-label);
  }
</style>
