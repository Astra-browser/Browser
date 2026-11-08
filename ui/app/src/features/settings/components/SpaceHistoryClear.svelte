<script lang="ts">
  import { tabs } from "$domain/tabs";
  import { spaceHistoryClear, spaceHistoryStatus } from "$shared/ipc/surfaces";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Button from "$shared/ui/Button";

  let entries = $state(0);
  let busy = $state(false);
  let note = $state("");

  const space = () => tabs.activeSpaceId() ?? "";

  async function read(): Promise<void> {
    try {
      entries = (await spaceHistoryStatus(space())).entries;
    } catch {
      entries = 0;
    }
  }

  async function clear(): Promise<void> {
    if (busy) return;
    busy = true;
    note = "";
    try {
      const reply = await spaceHistoryClear(space());
      note = `${reply.cleared} visits removed for this space`;
      await read();
    } catch {
      note = "This space's history could not be cleared";
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    void tabs.activeSpaceId();
    void read();
  });
</script>

<SettingsRow
  settingId="history.space"
  title="History for {tabs.activeSpace()?.name ?? 'this space'}"
  description="Visits are read through this space only. Places keeps one database per profile; Astra scopes the list."
>
  <div class="history-clear">
    <span class="history-count">{entries} visit{entries === 1 ? "" : "s"}</span>
    <Button
      size="compact"
      variant="ghost"
      disabled={busy || entries === 0}
      onclick={() => void clear()}
    >
      Clear this space
    </Button>
  </div>
</SettingsRow>
{#if note}<p class="history-note" role="status">{note}</p>{/if}

<style>
  .history-clear {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .history-count {
    color: var(--color-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .history-note {
    margin: 4px 0 8px;
    color: var(--color-muted);
    font-size: 12px;
  }
</style>
