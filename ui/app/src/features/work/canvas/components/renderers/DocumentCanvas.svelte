<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<script lang="ts">
  import DocumentView from "$shared/ui/data/Artifact/DocumentView.svelte";
  import * as m from "$shared/i18n/messages";
  import type { CanvasDoc } from "../../lib/types";

  let { doc }: { doc: CanvasDoc } = $props();
  const content = $derived(doc.artifact.content.kind === "document" ? doc.artifact.content : null);
</script>

<!-- A document the run kept: formatted when it has formatting, prose otherwise. -->
{#if content}
  {#if content.formatted}<DocumentView document={content.formatted} />
  {:else}{#each content.paragraphs as paragraph (paragraph)}<p>{paragraph}</p>{:else}<p
        class="empty"
      >
        {m.work_empty_data()}
      </p>{/each}{/if}
{/if}

<style>
  p {
    margin-block: 0 12px;
    line-height: 1.65;
    font-size: var(--text-label);
  }

  .empty {
    color: var(--color-faint);
  }
</style>
