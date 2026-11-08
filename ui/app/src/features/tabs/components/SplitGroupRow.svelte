<script lang="ts">
  import type { TabView } from "$shared/ipc/bindings";
  import TabRow from "./TabRow.svelte";

  let {
    tabs,
    activeId,
    splitting,
    closable = true,
    motionKey,
    class: className = "",
    onSelect,
    onClose,
    onContextMenu,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  }: {
    tabs: TabView[];
    activeId: string | null;
    splitting: boolean;
    closable?: boolean;
    motionKey?: string;
    class?: string;
    onSelect: (id: string, event?: MouseEvent) => void;
    onClose: (id: string) => void;
    onContextMenu: (event: MouseEvent, tab: TabView) => void;
    onPointerDown: (event: PointerEvent, tab: TabView) => void;
    onPointerMove: (event: PointerEvent) => void;
    onPointerUp: (event: PointerEvent) => void;
    onPointerCancel: (event: PointerEvent) => void;
  } = $props();

  let holdsActive = $derived(tabs.some((tab) => tab.id === activeId));
  let first = $derived(tabs[0] ?? null);
  let label = $derived(tabs.length === 1 ? "Split view" : `Split view · ${tabs.length} panes`);
</script>

<!--
  One split view is a section: the head opens the whole split, and the rows
  below are the individual panes, so a person can bring any one of them in
  front without losing the split.
-->
<li
  data-motion-key={motionKey}
  class={[
    "split-group overflow-hidden transition-[box-shadow] duration-[var(--motion-fast)]",
    className,
  ]}
  class:bg-fill={!holdsActive}
  class:shadow-raised={holdsActive}
>
  <button
    type="button"
    class="split-group-head"
    aria-label={`Open ${label}`}
    onclick={() => {
      if (first) onSelect(first.id);
    }}
  >
    <span class="split-group-mark" aria-hidden="true">
      <span></span><span></span><span></span>
    </span>
    <span class="split-group-label">{label}</span>
    {#if holdsActive}<span class="split-group-live">in front</span>{/if}
  </button>
  <ul class="split-group-members" role="list" aria-label="Split view tabs">
    {#each tabs as tab, index (tab.id)}
      <TabRow
        {tab}
        grouped
        {closable}
        class={index > 0 ? "border-t border-border" : ""}
        active={tab.id === activeId}
        splitCandidate={splitting && tab.id !== activeId}
        {onSelect}
        {onClose}
        {onContextMenu}
        {onPointerDown}
        {onPointerMove}
        {onPointerUp}
        {onPointerCancel}
      />
    {/each}
  </ul>
</li>

<style>
  li.split-group {
    border-radius: var(--radius-tab);
  }

  .split-group-head {
    display: flex;
    align-items: center;
    gap: 7px;
    inline-size: 100%;
    min-block-size: 26px;
    padding: 3px 8px;
    border: 0;
    background: var(--color-fill);
    color: var(--color-label-secondary);
    font: inherit;
    font-size: 11px;
    text-align: start;
    cursor: pointer;
  }

  .split-group-head:hover,
  .split-group-head:focus-visible {
    background: var(--color-fill-hover);
    color: var(--color-text);
  }

  .split-group-mark {
    display: flex;
    flex: none;
    gap: 2px;
    align-items: center;
  }

  .split-group-mark > span {
    display: block;
    inline-size: 3px;
    block-size: 12px;
    border-radius: 1px;
    background: var(--color-accent);
    opacity: 0.75;
  }

  .split-group-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .split-group-live {
    flex: none;
    color: var(--color-accent);
    font-size: 10px;
    font-weight: 600;
  }

  .split-group-members {
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
