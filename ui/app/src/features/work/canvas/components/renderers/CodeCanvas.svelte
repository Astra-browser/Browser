<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<script lang="ts">
  import LazyView from "$shared/ui/LazyView";
  import { loadCodeBlock } from "$shared/ui/data/Code";
  import * as m from "$shared/i18n/messages";
  import type { CanvasDoc } from "../../lib/types";

  let { doc }: { doc: CanvasDoc } = $props();
  const content = $derived(doc.artifact.content.kind === "code" ? doc.artifact.content : null);
</script>

<!-- Code the run wrote, whole: the card shows the first lines, the canvas keeps all. -->
{#if content}<LazyView
    loader={loadCodeBlock}
    loadingLabel={m.surface_loading()}
    failureLabel={m.work_artifact_unavailable()}
    retryLabel={m.surface_retry()}
    >{#snippet children(CodeBlock)}<CodeBlock
        language={content.language}
        text={content.text}
        notes={content.notes}
        label={doc.title}
        variant="lift"
      />{/snippet}</LazyView
  >{/if}
