<script lang="ts">
  import { tabs } from "$domain/tabs";
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
  const spaceName = () => tabs.activeSpace()?.name ?? "this space";

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
    <p class="space-note" role="status">{error}</p>
  {/if}
  <p class="space-note">
    Extensions stay installed once per profile. Turning one off here only changes
    {spaceName()}; switching to another space applies that space's own set.
  </p>
  {#if loading}
    <p class="space-note">Reading installed extensions…</p>
  {:else if items.length === 0}
    <p class="space-note">No extensions are installed in this profile yet.</p>
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

  .space-note {
    margin: 4px 0 10px;
    color: var(--color-muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .space-copy {
    padding: 8px 0 4px;
  }
</style>
