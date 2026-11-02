<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<script lang="ts">
  import LazyView from "$shared/ui/LazyView";
  import * as m from "$shared/i18n/messages";
  import type { CanvasDoc } from "../../lib/types";

  let { doc }: { doc: CanvasDoc } = $props();
  const content = $derived(doc.artifact.content.kind === "chart" ? doc.artifact.content : null);
  const loadWorkChart = () => import("$shared/ui/data/Artifact/WorkChart.svelte");
</script>

<!-- A chart the run plotted, on the shared chart spec: full readout, not the card. -->
{#if content}<LazyView
    loader={loadWorkChart}
    loadingLabel={m.surface_loading()}
    failureLabel={m.work_artifact_unavailable()}
    retryLabel={m.surface_retry()}
    >{#snippet children(WorkChart)}<WorkChart
        title={doc.title}
        chart={content}
      />{/snippet}</LazyView
  >{/if}
