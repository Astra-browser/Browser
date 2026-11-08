<script lang="ts">
  import { tabs } from "$domain/tabs";
  import { surface as browserPage } from "$domain/surface";
  import {
    copySpaceExtensions,
    setSpaceExtension,
    spaceExtensions,
    type SpaceExtensionView,
  } from "$shared/ipc/surfaces";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Switch from "$shared/ui/Switch";
  import Button from "$shared/ui/Button";

  let items = $state.raw<SpaceExtensionView[]>([]);
  let loading = $state(true);
  let error = $state("");
  let busy = $state<string | null>(null);

  const spaceId = () => tabs.activeSpaceId() ?? "";

  async function load(): Promise<void> {
    loading = true;
    error = "";
    try {
      const reply = await spaceExtensions(spaceId());
      items = reply.extensions;
    } catch {
      items = [];
      error = "Extensions are not reachable in this build.";
    } finally {
      loading = false;
    }
  }

  async function toggle(entry: SpaceExtensionView, enabled: boolean): Promise<void> {
    busy = entry.id;
    try {
      await setSpaceExtension(spaceId(), entry.id, enabled);
      items = items.map((row) => (row.id === entry.id ? { ...row, assigned: enabled } : row));
    } catch {
      error = "That extension refused the change.";
    } finally {
      busy = null;
    }
  }

  async function copyHere(): Promise<void> {
    const spaces = tabs.profileSpaces().filter((space) => space.id !== spaceId());
    const from = spaces[0];
    if (!from) return;
    busy = "copy";
    try {
      await copySpaceExtensions(from.id, spaceId());
      await load();
    } catch {
      error = "The set could not be copied.";
    } finally {
      busy = null;
    }
  }

  // A switch of space is a different assignment; reload it.
  $effect(() => {
    void tabs.activeSpaceId();
    void load();
  });

  let otherSpaces = $derived(tabs.profileSpaces().filter((space) => space.id !== spaceId()));
</script>

<div class="space-extensions">
  {#if error}
    <p class="space-status" role="status">{error}</p>
  {/if}
  {#if loading}
    <p class="space-status">Reading installed extensions…</p>
  {:else if items.length === 0}
    <div class="space-empty">
      <span class="space-empty-mark" aria-hidden="true"></span>
      <span>
        <strong>No extensions installed</strong>
        <span>Install one from the extensions gallery, then it appears here for every space.</span>
      </span>
      <Button size="compact" variant="ghost" onclick={() => void browserPage.open("extensions")}
        >Manage extensions</Button
      >
    </div>
  {:else}
    {#each items as entry (entry.id)}
      <SettingsRow
        settingId={`space.extension.${entry.id}`}
        title={entry.name}
        description={entry.version}
      >
        <Switch
          label={entry.name}
          labelHidden
          checked={entry.assigned}
          disabled={busy !== null}
          onchange={(value) => void toggle(entry, value)}
        />
      </SettingsRow>
    {/each}
  {/if}
  {#if otherSpaces.length > 0}
    <div class="space-copy">
      <Button
        size="compact"
        variant="ghost"
        disabled={busy !== null}
        onclick={() => void copyHere()}
      >
        Copy {otherSpaces[0]?.name ?? "another space"}'s set here
      </Button>
    </div>
  {/if}
</div>

<style>
  .space-extensions {
    display: flex;
    flex-direction: column;
  }

  .space-status {
    margin: 0;
    padding: 10px 18px;
    border-block-start: 1px solid var(--color-border);
    color: var(--color-muted);
    font-size: var(--text-label, 12px);
  }

  .space-empty {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    border-block-start: 1px solid var(--color-border);
    color: var(--color-muted);
    font-size: var(--text-label, 12px);
    line-height: 1.5;
  }

  .space-empty-mark {
    flex: none;
    inline-size: 18px;
    block-size: 18px;
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-control);
  }

  .space-empty strong {
    display: block;
    color: var(--color-text);
    font-weight: 500;
  }

  .space-empty span span {
    display: block;
  }

  .space-copy {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 18px 14px;
  }

  .space-empty :global(button) {
    margin-inline-start: auto;
  }
</style>
