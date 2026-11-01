<script lang="ts">
  import type { OmniboxSuggestion } from "../lib/omnibox-model";

  let {
    suggestions,
    selection,
    query,
    onselect,
    onhover,
  }: {
    suggestions: readonly OmniboxSuggestion[];
    /** -1 is the typed row; otherwise an index into `suggestions`. */
    selection: number;
    /** What the user typed; the search row carries it, never a stale answer. */
    query: string;
    onselect: (id: string) => void;
    onhover: (index: number) => void;
  } = $props();

  const kindLabel: Record<OmniboxSuggestion["source"], string> = {
    tabs: "Tab",
    history: "History",
    notes: "Note",
    search: "Search",
  };
</script>

{#if suggestions.length}
  <div class="omnibox-list" role="listbox" aria-label="Address bar suggestions">
    {#each suggestions as suggestion, index (suggestion.id)}
      <button
        type="button"
        class="row"
        class:selected={index === selection}
        tabindex="-1"
        role="option"
        aria-selected={index === selection}
        aria-posinset={index + 1}
        aria-setsize={suggestions.length}
        onpointermove={() => onhover(index)}
        onclick={() => onselect(suggestion.id)}
      >
        <span class="text">
          <span class="title">{suggestion.source === "search" ? query : suggestion.title}</span>
          {#if suggestion.detail}<span class="detail">{suggestion.detail}</span>{/if}
        </span>
        <span class="kind">{kindLabel[suggestion.source]}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .omnibox-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    min-height: 32px;
    padding: 5px 10px;
    border: 0;
    border-radius: var(--radius-row);
    background: transparent;
    color: var(--color-text);
    text-align: start;
    cursor: default;
  }

  .row.selected {
    background: var(--color-fill-active);
  }

  .text {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }

  .title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 13px;
    color: var(--color-muted);
  }

  .row.selected .title {
    color: var(--color-text);
  }

  .detail {
    flex: none;
    max-width: 38%;
    margin-inline-start: auto;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: end;
    font-size: 11.5px;
    color: var(--color-faint);
  }

  .kind {
    flex: none;
    font-size: 11.5px;
    color: var(--color-faint);
  }

  @media (forced-colors: active) {
    .row.selected {
      outline: 1px solid Highlight;
    }
  }
</style>
