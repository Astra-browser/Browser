<script lang="ts">
  import type { TabView } from "$shared/ipc/bindings";

  let {
    tab,
    onWake,
  }: {
    tab: TabView;
    /** Waking is a navigation intent the row owns; the badge only asks. */
    onWake: (id: string) => void;
  } = $props();

  let sleeping = $derived(tab.availability?.state === "sleeping");
</script>

{#if sleeping}
  <button
    type="button"
    class="sleeping-badge"
    data-astra-sleeping-badge
    title="Sleeping tab — select to wake it"
    aria-label={`Sleeping tab ${tab.title || "untitled"}, select to wake`}
    onclick={(event) => {
      event.stopPropagation();
      onWake(tab.id);
    }}
    onpointerdown={(event) => event.stopPropagation()}
    oncontextmenu={(event) => event.stopPropagation()}
    ><span class="sleeping-dot" aria-hidden="true"></span><span>Sleeping</span></button
  >
{/if}

<style>
  /* A quiet pill beside the favicon: a sleeping tab keeps its row, title
     and place, and says why it draws no process. */
  .sleeping-badge {
    display: flex;
    flex: none;
    align-items: center;
    gap: 5px;
    height: 18px;
    padding-inline: 7px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-capsule);
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    font-size: 11px;
    cursor: default;
  }

  .sleeping-badge:hover {
    background: var(--row-hover);
    color: var(--color-label-secondary);
  }

  .sleeping-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentcolor;
    opacity: 0.7;
  }
</style>
