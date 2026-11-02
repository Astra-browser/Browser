<script lang="ts">
  import Button from "$shared/ui/Button";
  import {
    budgetLabel,
    isLiveHelper,
    statusLabel,
    usageLabel,
    type HelperEntry,
  } from "../lib/helpers";

  let {
    helper,
    oncancel,
  }: {
    /** The helper whose live page this source pane shows. */
    helper: HelperEntry;
    /** The person stopped the helper from its own pane. */
    oncancel?: (helperId: string) => void;
  } = $props();
</script>

<section
  class="helper-source-pane"
  data-astra-helper-pane={helper.paneId}
  data-astra-helper-status={helper.status}
  data-astra-helper-container={helper.containerId ?? ""}
  aria-label={`Helper ${helper.goal}`}
>
  <header class="head">
    <div class="titles">
      <span class="goal" data-astra-helper-goal>{helper.goal}</span>
      <span class="meta" data-astra-helper-meta>
        {statusLabel(helper)} · {usageLabel(helper)} · {budgetLabel(helper.budget)}
      </span>
    </div>
    {#if isLiveHelper(helper.status)}
      <Button
        variant="danger"
        size="compact"
        data-astra-helper-cancel={helper.id}
        aria-label={`Cancel helper ${helper.goal}`}
        onclick={() => oncancel?.(helper.id)}
      >
        Cancel
      </Button>
    {/if}
  </header>
  <!-- The shell mounts the helper's live page here: the pane anchors to
       `data-astra-helper-pane` and the `<browser>` content slot fills `.hole`. -->
  <div
    class="hole"
    data-astra-helper-hole={helper.paneId}
    role="region"
    aria-label={`Live page for helper ${helper.goal}`}
  ></div>
</section>

<style>
  .helper-source-pane {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: var(--radius-card);
    background: var(--color-surface);
    min-height: 12rem;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .titles {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .goal {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    color: var(--color-text-secondary);
    font-size: var(--text-caption);
  }

  .hole {
    flex: 1;
    min-height: 8rem;
    border-radius: var(--radius-row);
  }
</style>
