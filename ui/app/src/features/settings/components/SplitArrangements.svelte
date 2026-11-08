<script lang="ts">
  import { onMount } from "svelte";
  import {
    splitArrangements,
    splitDeleteArrangement,
    splitRestoreArrangement,
    splitSaveArrangement,
    type SplitArrangement,
  } from "$shared/ipc/surfaces";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Button from "$shared/ui/Button";

  let rows = $state.raw<SplitArrangement[]>([]);
  let busy = $state<string | null>(null);
  let note = $state("");

  async function load(): Promise<void> {
    try {
      rows = (await splitArrangements()).arrangements;
    } catch {
      rows = [];
    }
  }

  async function save(): Promise<void> {
    busy = "save";
    note = "";
    try {
      await splitSaveArrangement("");
      note = "The split in front was saved";
      await load();
    } catch {
      note = "Open a split view first, then save it";
    } finally {
      busy = null;
    }
  }

  async function restore(id: string): Promise<void> {
    busy = id;
    note = "";
    try {
      const reply = await splitRestoreArrangement(id);
      note =
        reply.restored === true || (reply.members?.length ?? 0) >= 2
          ? "Arrangement restored"
          : "The arrangement opened without a split";
    } catch {
      note = "Switch to the arrangement's space first";
    } finally {
      busy = null;
    }
  }

  async function remove(id: string): Promise<void> {
    busy = id;
    try {
      await splitDeleteArrangement(id);
      await load();
    } finally {
      busy = null;
    }
  }

  onMount(() => void load());
</script>

<div class="split-arrangements">
  <SettingsRow
    settingId="split.arrangements"
    title="Saved split arrangements"
    description="A saved arrangement remembers the pages, their order and the divider position."
  >
    <Button size="compact" variant="ghost" disabled={busy !== null} onclick={() => void save()}>
      Save current split
    </Button>
  </SettingsRow>
  {#if note}<p class="arrangement-note" role="status">{note}</p>{/if}
  {#if rows.length === 0}
    <p class="arrangement-empty">No arrangement saved yet.</p>
  {:else}
    <ul class="arrangement-list">
      {#each rows as row (row.id)}
        <li class="arrangement-row">
          <span
            class="arrangement-name"
            title={row.panes.map((pane) => pane.title || pane.url).join(" · ")}
          >
            {row.name}
          </span>
          <span class="arrangement-meta">{row.panes.length} panes · {row.space_id || "space"}</span>
          <Button
            size="compact"
            variant="ghost"
            disabled={busy !== null}
            onclick={() => void restore(row.id)}
          >
            Restore
          </Button>
          <Button
            size="compact"
            variant="ghost"
            disabled={busy !== null}
            onclick={() => void remove(row.id)}
          >
            Delete
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="arrangement-note">
    Restoring reuses tabs already open at the same address; it does not duplicate them.
  </p>
</div>

<style>
  .split-arrangements {
    display: flex;
    flex-direction: column;
  }

  .arrangement-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 4px 0;
    padding: 0;
    list-style: none;
  }

  .arrangement-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-block-end: 1px solid var(--color-border);
  }

  .arrangement-name {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .arrangement-meta {
    color: var(--color-faint);
    font-size: 11px;
    white-space: nowrap;
  }

  .arrangement-note,
  .arrangement-empty {
    margin: 4px 0;
    color: var(--color-muted);
    font-size: 12px;
  }
</style>
