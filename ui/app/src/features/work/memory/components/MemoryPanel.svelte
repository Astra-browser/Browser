<script lang="ts">
  import { scopeLabel, searchMemories, type MemoryEntry } from "../lib/memory";

  let {
    entries = [],
    onupdate,
    ondelete,
  }: {
    /** Memories to show, newest display order handled internally. */
    entries?: MemoryEntry[];
    /** Called with (id, content) when an edit is saved. */
    onupdate?: (id: string, content: string) => void;
    /** Called with id only after the delete confirm is accepted. */
    ondelete?: (id: string) => void;
  } = $props();

  let query = $state("");
  let confirming: string | null = $state(null);
  let editing: string | null = $state(null);
  let draft = $state("");

  const ranked = $derived(searchMemories(entries, query));

  function startEdit(id: string, content: string) {
    editing = id;
    confirming = null;
    draft = content;
  }

  function saveEdit(id: string) {
    const text = draft.trim();
    if (text) onupdate?.(id, text);
    editing = null;
  }
</script>

<section class="memory-panel" aria-label="Memories">
  <header class="head">
    <h2>Memories</h2>
    <p class="hint">{entries.length} kept · the agent recalls these with your goals</p>
  </header>

  <input
    class="search"
    type="search"
    placeholder="Search memories"
    aria-label="Search memories"
    bind:value={query}
  />

  {#if ranked.length === 0}
    <p class="empty">{query.trim() ? "No memories match." : "Nothing kept yet."}</p>
  {:else}
    <ul class="list">
      {#each ranked as { entry } (entry.id)}
        <li class="row" data-entry={entry.id}>
          <div class="meta">
            <span class="scope">{scopeLabel(entry.scope)}</span>
            {#if entry.site}<span class="site">{entry.site}</span>{/if}
          </div>

          {#if editing === entry.id}
            <textarea class="draft" aria-label="Edit memory" bind:value={draft} rows="3"></textarea>
            <div class="actions">
              <button type="button" onclick={() => saveEdit(entry.id)} disabled={!draft.trim()}>
                Save
              </button>
              <button type="button" class="quiet" onclick={() => (editing = null)}>Cancel</button>
            </div>
          {:else if confirming === entry.id}
            <p class="content">{entry.content}</p>
            <p class="confirm" role="alert">Delete this memory? This cannot be undone.</p>
            <div class="actions">
              <button
                type="button"
                class="danger"
                onclick={() => {
                  confirming = null;
                  ondelete?.(entry.id);
                }}
              >
                Confirm delete
              </button>
              <button type="button" class="quiet" onclick={() => (confirming = null)}>Cancel</button
              >
            </div>
          {:else}
            <p class="content">{entry.content}</p>
            <div class="actions">
              <button
                type="button"
                class="quiet"
                onclick={() => startEdit(entry.id, entry.content)}
              >
                Edit
              </button>
              <button
                type="button"
                class="quiet"
                onclick={() => {
                  editing = null;
                  confirming = entry.id;
                }}
              >
                Delete
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .memory-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    inline-size: 100%;
  }
  .head h2 {
    margin: 0;
    font-size: 14px;
  }
  .hint {
    margin: 0;
    opacity: 0.65;
    font-size: 12px;
  }
  .search {
    inline-size: 100%;
  }
  .empty {
    opacity: 0.65;
    font-size: 13px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    border: 1px solid var(--edge, #444);
    border-radius: 8px;
    padding: 8px;
  }
  .meta {
    display: flex;
    gap: 6px;
    margin-block-end: 4px;
  }
  .scope {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  .site {
    font-size: 11px;
    opacity: 0.6;
  }
  .content {
    margin: 0 0 6px;
    font-size: 13px;
    white-space: pre-wrap;
  }
  .draft {
    inline-size: 100%;
    font: inherit;
  }
  .confirm {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 600;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .danger {
    color: #ff6b61;
  }
  .quiet {
    opacity: 0.75;
  }
</style>
