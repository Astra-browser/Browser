<script lang="ts">
  import Button from "$shared/ui/Button";
  import { isLiveHelper, statusLabel, usageLabel, type HelperEntry } from "../lib/helpers";

  let {
    helpers = [],
    oncancel,
  }: {
    /** Every helper of the run in spawn order, each with its own container and pane. */
    helpers?: readonly HelperEntry[];
    /** The person stopped one helper: its container is torn down, no orphan tab. */
    oncancel?: (helperId: string) => void;
  } = $props();
</script>

<section class="helper-list" data-astra-helper-list aria-label="Helpers">
  {#if helpers.length === 0}
    <p class="empty" data-astra-helper-empty>No helpers running.</p>
  {:else}
    <ul>
      {#each helpers as helper (helper.id)}
        <li
          class="row"
          data-astra-helper-row={helper.id}
          data-astra-helper-status={helper.status}
          data-astra-helper-pane={helper.paneId}
        >
          <div class="main">
            <span class="goal" data-astra-helper-goal>{helper.goal}</span>
            <span class="meta" data-astra-helper-meta>
              {statusLabel(helper)} · {usageLabel(helper)}
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
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .helper-list ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-radius: var(--radius-row);
    background: var(--color-surface);
  }

  .main {
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

  .empty {
    color: var(--color-text-secondary);
  }
</style>
