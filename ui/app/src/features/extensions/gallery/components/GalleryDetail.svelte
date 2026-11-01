<script lang="ts">
  import {
    canInstall,
    installLabel,
    statusBadge,
    type GalleryViewEntry,
  } from "../lib/gallery-view";

  let {
    entry,
    onback,
    oninstall,
  }: {
    entry: GalleryViewEntry | null;
    onback: () => void;
    oninstall: (href: string) => void;
  } = $props();
</script>

{#if entry !== null}
  <section class="detail" aria-label={`${entry.name} details`}>
    <button type="button" class="back" onclick={onback}>Back to gallery</button>
    <h2 class="name">{entry.name}</h2>
    <p class="badge" data-status={entry.status}>{statusBadge(entry.status)}</p>
    <p class="note">{entry.note}</p>
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
      <p class="unavailable">There is no Firefox version to install.</p>
    {/if}
  </section>
{/if}

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-panel);
    background: var(--color-raised);
  }

  .back {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--text-label);
    color: var(--color-muted);
    cursor: pointer;
  }

  .name {
    margin: 0;
    font-size: var(--text-body);
    color: var(--color-text);
  }

  .badge {
    margin: 0;
    font-size: var(--text-label);
    color: var(--color-faint);
  }

  .note {
    margin: 0;
    font-size: var(--text-label);
    line-height: 1.45;
    color: var(--color-text);
  }

  .get {
    align-self: flex-start;
    height: 28px;
    padding-inline: 12px;
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

  .unavailable {
    margin: 0;
    font-size: var(--text-label);
    color: var(--color-faint);
  }
</style>
