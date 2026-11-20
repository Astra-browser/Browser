<script lang="ts">
  import { untrack } from "svelte";
  import {
    Alert02Icon,
    Cancel01Icon,
    FolderAddIcon,
    Folder01Icon,
    Image02Icon,
  } from "@hugeicons/core-free-icons";
  import * as m from "$shared/i18n/messages";
  import type { GalleryFolder, GalleryState } from "$shared/ipc/bindings";
  import { commands } from "$shared/ipc/bindings";
  import Button from "$shared/ui/Button";
  import Icon from "$shared/ui/Icon";
  import IconButton from "$shared/ui/IconButton";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Switch from "$shared/ui/Switch";
  import { tabs } from "$domain/tabs";
  import { formatBytes } from "$shared/lib/bytes";
  import { timeAgo } from "$shared/lib/relative-time";
  import { getLocale } from "$shared/i18n/runtime";

  const profile = $derived(tabs.profile());
  const profileId = $derived(profile?.id ?? "");
  const privateWindow = $derived(profile?.kind === "incognito");
  let snapshot = $state<GalleryState | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const locale = getLocale();

  async function apply(call: Parameters<typeof commands.mediaGallery>[1]) {
    if (!profile?.id || busy) return;
    busy = true;
    error = null;
    try {
      const owner = profile.id;
      const response = await commands.mediaGallery(owner, call);
      if (response.kind === "state") snapshot = response;
      else if (response.kind === "error") {
        error =
          response.error === "cancelled"
            ? null
            : response.error === "covered"
              ? m.settings_gallery_add_failed()
              : response.error;
      }
    } catch {
      error = m.settings_gallery_unavailable();
    } finally {
      busy = false;
    }
  }

  async function load() {
    if (!profileId || privateWindow) return;
    try {
      const response = await commands.mediaGallery(profileId, { kind: "state" });
      if (response.kind === "state") snapshot = response;
      else if (response.kind === "error") error = response.error;
    } catch {
      error = m.settings_gallery_unavailable();
    }
  }

  $effect(() => {
    const owner = profileId;
    if (!owner || privateWindow) return;
    return untrack(() => {
      void load();
    });
  });

  const folders = $derived(snapshot?.folders ?? []);
  const live = $derived(folders.filter((folder) => folder.exists).length);
  const scanned = $derived.by(() => {
    if (!snapshot) return "";
    if (!snapshot.scanned_at) return m.settings_gallery_never();
    return m.settings_gallery_scanned({
      when: timeAgo(snapshot.scanned_at, { locale, justNow: m.gallery_just_now() }),
    });
  });

  function tag(folder: GalleryFolder): string {
    if (!folder.exists) return m.settings_gallery_missing();
    return folder.kind === "custom" ? m.settings_gallery_custom() : m.settings_gallery_default();
  }
</script>

{#if privateWindow || !profile}
  <p class="note">{m.settings_gallery_private()}</p>
{:else}
  <SettingsGroup title={m.settings_gallery_title()} description={m.settings_gallery_help()}>
    <SettingsRow
      title={m.settings_gallery_enabled()}
      description={m.settings_gallery_enabled_help()}
    >
      <Switch
        label={m.settings_gallery_enabled()}
        labelHidden
        checked={snapshot?.enabled ?? true}
        disabled={busy}
        onchange={(enabled) => void apply({ kind: "set_enabled", enabled })}
      />
    </SettingsRow>
  </SettingsGroup>

  <div class="warning" role="note">
    <span class="warning-mark"><Icon icon={Alert02Icon} size={17} /></span>
    <span>
      <strong>{m.settings_gallery_warning_title()}</strong>
      <p>{m.settings_gallery_warning_body()}</p>
    </span>
  </div>

  <SettingsGroup
    title={m.settings_gallery_folders()}
    description={m.settings_gallery_folders_help()}
  >
    {#if folders.length === 0}
      <p class="empty">{m.settings_gallery_no_folders()}</p>
    {/if}
    {#each folders as folder (folder.path)}
      <div class="folder" data-gallery-folder={folder.path}>
        <span class="mark"><Icon icon={Folder01Icon} size={17} /></span>
        <span class="words">
          <span class="name">
            <strong>{folder.label}</strong>
            <span class="tag" data-missing={!folder.exists || undefined}>{tag(folder)}</span>
          </span>
          <code>{folder.path}</code>
        </span>
        <IconButton
          icon={Cancel01Icon}
          size={14}
          buttonSize={26}
          label={m.settings_gallery_remove({ name: folder.label })}
          disabled={busy}
          onclick={() => void apply({ kind: "remove_folder", path: folder.path })}
        />
      </div>
    {/each}
    <div class="folder-actions">
      <Button variant="secondary" disabled={busy} onclick={() => void apply({ kind: "add_folder" })}
        ><span class="with-icon"
          ><Icon icon={FolderAddIcon} size={15} />{m.settings_gallery_add()}</span
        ></Button
      >
      <Button
        variant="ghost"
        disabled={busy}
        onclick={() => void apply({ kind: "restore_defaults" })}
        >{m.settings_gallery_restore()}</Button
      >
    </div>
  </SettingsGroup>

  <p class="summary">
    <Icon icon={Image02Icon} size={13} />
    {m.settings_gallery_stats({ count: snapshot?.total ?? 0, folders: live })} · {scanned}{#if snapshot && snapshot.cache_count > 0}
      · {m.settings_gallery_cache({ size: formatBytes(snapshot.cache_bytes) })}{/if}
  </p>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
{/if}

<style>
  .note,
  .empty {
    margin: 0;
    padding: 14px 18px;
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.55;
  }

  .warning {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-block: -14px 26px;
    padding: 13px 15px;
    border-radius: var(--radius-card);
    background: color-mix(in srgb, var(--color-warning) 12%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-warning) 26%, transparent);
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.5;
  }

  .warning-mark {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    border-radius: 50%;
    color: var(--color-warning);
  }

  .warning strong {
    display: block;
    margin-block-end: 2px;
    color: var(--color-text);
    font-weight: 600;
  }

  .warning p {
    margin: 0;
  }

  .folder {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px 12px 18px;
  }

  .folder + .folder {
    box-shadow: inset 0 1px 0 var(--color-border);
  }

  .mark {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 30px;
    block-size: 30px;
    border-radius: var(--radius-field);
    background: var(--color-field);
    color: var(--color-muted);
  }

  .words {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    gap: 2px;
  }

  .name {
    display: flex;
    align-items: center;
    gap: 8px;
    min-inline-size: 0;
  }

  .name strong {
    overflow: hidden;
    font-size: var(--text-page-title);
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .tag {
    flex: none;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--color-field);
    color: var(--color-faint);
    font-size: 10px;
    font-weight: 550;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .tag[data-missing] {
    color: var(--color-warning);
  }

  code {
    overflow: hidden;
    color: var(--color-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
    /* stylelint-disable-next-line property-no-vendor-prefix */
    -webkit-user-select: text;
    user-select: text;
  }

  .folder-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 12px 16px;
    box-shadow: inset 0 1px 0 var(--color-border);
  }

  .with-icon {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .summary {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: -18px 16px 26px;
    color: var(--color-faint);
    font-size: var(--text-label);
  }

  .error {
    margin: -16px 16px 24px;
    color: var(--color-danger);
    font-size: var(--text-label);
  }
</style>
