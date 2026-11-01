<script lang="ts">
  import {
    canInstall,
    categoryTitle,
    installLabel,
    statusBadge,
    type GalleryViewGroup,
  } from "../lib/gallery-view";

  let {
    groups,
    onselect,
    oninstall,
  }: {
    groups: GalleryViewGroup[];
    onselect: (chromeStoreId: string) => void;
    oninstall: (href: string) => void;
  } = $props();
</script>

<section class="gallery" aria-label="Extension gallery">
  {#each groups as group (group.category)}
    <h2 class="group-title">{categoryTitle(group.category)}</h2>
    <ul class="cards">
      {#each group.entries as entry (entry.chromeStoreId)}
        <li class="card">
          <button type="button" class="main" onclick={() => onselect(entry.chromeStoreId)}>
            <span class="name">{entry.name}</span>
            <span class="badge" data-status={entry.status}>{statusBadge(entry.status)}</span>
          </button>
          {#if canInstall(entry) && entry.installHref !== null}
            <button
              type="button"
              class="get"
              disabled={entry.installed}
              onclick={() => oninstall(entry.installHref!)}
            >
              {installLabel(entry)}
            </button>
          {:else}
            <span class="get unavailable">{installLabel(entry)}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/each}
</section>

<style>
  .gallery {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .group-title {
    margin: 14px 0 6px;
    font-size: var(--text-label);
    font-weight: 550;
    color: var(--color-muted);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-panel);
    background: var(--color-raised);
  }

  .main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .name {
    overflow: hidden;
    font-size: var(--text-body);
    color: var(--color-text);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .badge {
    font-size: var(--text-label);
    color: var(--color-faint);
  }

  .badge[data-status="equivalent"] {
    color: var(--color-text);
  }

  .get {
    flex: none;
    height: 28px;
    padding-inline: 10px;
    border: 0;
    border-radius: var(--radius-control-compact);
    background: var(--row-active);
    font: inherit;
    font-size: var(--text-label);
    color: var(--color-text);
    cursor: pointer;
  }

  .get:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .get.unavailable {
    display: inline-flex;
    align-items: center;
    color: var(--color-faint);
  }
</style>
