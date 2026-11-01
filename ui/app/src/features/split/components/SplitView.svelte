<script lang="ts">
  import type { SplitVariant } from "../lib/split-view";

  /** One rendered pane: the slot's stable identity plus its bound tab. */
  export interface SplitPaneView {
    id: string;
    tabId: string | null;
    title: string;
    url: string | null;
    ratio: number;
  }

  interface SplitViewProps {
    panes: SplitPaneView[];
    activeId: string;
    variant: SplitVariant;
    onfocus?: (id: string) => void;
    onclose?: (id: string) => void;
    onswap?: (id: string) => void;
  }

  let { panes, activeId, variant, onfocus, onclose, onswap }: SplitViewProps = $props();

  function columns(): string | undefined {
    if (panes.length < 2) return undefined;
    if (panes.length === 2) {
      return panes.map((pane) => `${pane.ratio * 100}%`).join(" ");
    }
    const half = Math.ceil(panes.length / 2);
    const left = panes.slice(0, half).reduce((sum, pane) => sum + pane.ratio, 0);
    return `${left * 100}% ${(1 - left) * 100}%`;
  }
</script>

<!-- CSS-grid content slots (S-01): `data-layout` switches the variant,
     per-cell `hidden` is unnecessary here — the host renders exactly the
     bound panes — and each cell keeps its slot identity across resizes. -->
<div class="split" data-layout={variant} style:grid-template-columns={columns()}>
  {#each panes as pane (pane.id)}
    <section
      class="pane"
      class:active={pane.id === activeId}
      data-slot-id={pane.id}
      aria-label={`Pane ${pane.id}`}
    >
      <div class="pane-header">
        <button
          type="button"
          class="pane-title"
          aria-label={`Focus pane ${pane.id}`}
          onclick={() => onfocus?.(pane.id)}
        >
          {pane.title}
        </button>
        <span class="pane-actions">
          <button
            type="button"
            aria-label={`Swap pane ${pane.id} with next`}
            title="Swap with next pane"
            onclick={() => onswap?.(pane.id)}
          >
            Swap
          </button>
          <button
            type="button"
            aria-label={`Close pane ${pane.id}`}
            title="Close pane"
            onclick={() => onclose?.(pane.id)}
          >
            Close
          </button>
        </span>
      </div>
      <div class="pane-content" data-slot-id={pane.id} data-tab-id={pane.tabId ?? ""}></div>
    </section>
  {/each}
</div>

<style>
  .split {
    display: grid;
    gap: 4px;
    min-block-size: 0;
    block-size: 100%;
    padding: 4px;
  }

  .split[data-layout="single"] {
    grid-template-columns: 1fr;
  }

  .split[data-layout="cols-2"] {
    grid-template-rows: 1fr;
  }

  .split[data-layout="grid-2x2"] {
    grid-template-rows: 1fr 1fr;
  }

  .pane {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    min-block-size: 0;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .pane.active {
    border-color: var(--color-accent);
  }

  .pane-header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
  }

  .pane-title {
    flex: 1;
    overflow: hidden;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .pane-actions {
    display: flex;
    flex: none;
    gap: 2px;
  }

  .pane-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-block-size: 0;
  }
</style>
