<!-- P0-T07 golden NewTab stage: the composition Shell draws (sidebar beside
     the pane that paints its own ground), with a stand-in sidebar using the
     real column class so the ground each takes is captured together. -->
<script lang="ts">
  import { loadNewTab } from "../src/features/newtab";
  import { loadNewTabSearch } from "../src/features/search";
  import LazyView from "../src/shared/ui/LazyView";

  let { ontasks }: { ontasks?: () => void } = $props();
  const rows = ["Atlas", "Beacon", "Compass", "Chorus", "Harbor", "New Tab"];
</script>

<div class="shell" style="display: flex; block-size: 100%">
  <aside class="browser-sidebar" style="position: relative; inline-size: 200px; padding: 44px 10px">
    {#each rows as row (row)}<p style="margin: 0; padding: 7px 10px; font-size: 13px">
        {row}
      </p>{/each}
  </aside>
  <div style="flex: 1; min-inline-size: 0; padding-inline-start: 8px">
    <div class="content-pane" data-ground="own" style="block-size: 100%">
      <LazyView loader={loadNewTab} loadingLabel="" failureLabel="failed" retryLabel="retry"
        >{#snippet children(NewTab)}<NewTab oncustomize={() => {}} {ontasks} onaccount={() => {}}
            >{#snippet search()}<LazyView
                loader={loadNewTabSearch}
                loadingLabel=""
                failureLabel="failed"
                retryLabel="retry"
                >{#snippet children(Search)}<Search tabId="tab" />{/snippet}</LazyView
              >{/snippet}</NewTab
          >{/snippet}</LazyView
      >
    </div>
  </div>
</div>
