<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    ArrowLeft02Icon,
    FilterIcon,
    Image02Icon,
    LockIcon,
    RefreshIcon,
    Setting07Icon,
  } from "@hugeicons/core-free-icons";
  import * as m from "$shared/i18n/messages";
  import { surface as browser } from "$domain/surface";
  import { tabs } from "$domain/tabs";
  import { commands } from "$shared/ipc/bindings";
  import Button from "$shared/ui/Button";
  import EmptyState from "$shared/ui/EmptyState";
  import Icon from "$shared/ui/Icon";
  import IconButton from "$shared/ui/IconButton";
  import Menu from "$shared/ui/Menu";
  import type { MenuEntry } from "$shared/ui/Menu";
  import SearchField from "$shared/ui/SearchField";
  import type { GalleryItem } from "$shared/ipc/bindings";
  import { GallerySession } from "../lib/gallery-session.svelte";
  import { countLabel, relativeUpdate } from "../lib/gallery-model";
  import GalleryGrid from "./GalleryGrid.svelte";
  import GalleryViewer from "./GalleryViewer.svelte";

  const profile = $derived(tabs.profile());
  const profileId = $derived(profile?.id ?? "");
  const privateWindow = $derived(profile?.kind === "incognito");
  let session = $state.raw<GallerySession | null>(null);
  let query = $state("");
  let viewing = $state<{
    index: number;
    origin: HTMLElement | null;
  } | null>(null);
  let openFocus: HTMLElement | null = null;

  // A private window never starts a scan: the gallery reads real folders, and
  // a private window records nothing. A normal window gets its own session,
  // torn down when the page is left.
  $effect(() => {
    // The id, not the projection object: a tab event replaces the profile
    // object with the same id, and rebuilding the session there would cancel
    // a scan or a search the reader is using.
    const owner = profileId;
    if (privateWindow || !owner) {
      session = null;
      return;
    }
    const next = untrack(() => new GallerySession(owner));
    session = next;
    void next.start();
    return () => next.stop();
  });

  $effect(() => {
    const owner = session;
    const value = query;
    if (!owner) return;
    // `setQuery` loads a page, and the page's own state is reactive: keep the
    // effect's dependencies to the session and the typed value only.
    untrack(() => {
      if (owner.query !== value) owner.setQuery(value);
    });
  });

  const folders = $derived((session?.folders ?? []).filter((folder) => folder.exists));
  const filterEntries: MenuEntry[] = $derived.by(() => [
    { kind: "heading", label: m.gallery_filter_title() },
    {
      kind: "item",
      id: "all",
      label: m.gallery_filter_all(),
      checked: !session?.folder,
    },
    ...folders.map((folder) => ({
      kind: "item" as const,
      id: folder.path,
      label: folder.label,
      checked: session?.folder === folder.path,
    })),
  ]);
  const status = $derived.by(() => {
    if (!session) return "";
    if (session.scanning) return m.gallery_scanning();
    if (session.total === 0) return "";
    return `${countLabel(session.total)} · ${m.gallery_updated({ when: relativeUpdate(session.scannedAt) })}`;
  });

  function openViewer(_item: GalleryItem, index: number, tile: HTMLElement | null) {
    openFocus =
      tile?.querySelector<HTMLElement>(".tile") ?? (tile instanceof HTMLElement ? tile : null);
    viewing = { index, origin: openFocus };
  }

  async function closeViewer() {
    viewing = null;
    await tick();
    openFocus?.focus();
    openFocus = null;
  }

  function manageFolders() {
    viewing = null;
    // The command names the section and opens the page; the shell routes both,
    // so this feature does not reach into Settings' own state.
    void commands.runCommand("settings.section.gallery");
  }

  function chooseFolder(id: string) {
    if (!session) return;
    session.setFolder(id === "all" ? null : id);
  }
</script>

<section class="library-shell gallery-shell">
  <header class="internal-toolbar">
    <IconButton
      icon={ArrowLeft02Icon}
      label={m.settings_back()}
      onclick={() => void browser.close()}
    /><span class="toolbar-current">{m.gallery_title()}</span>
    <span class="toolbar-status" aria-live="polite">{status}</span>
    <span class="toolbar-gap"></span>
    {#if session && session.enabled && !privateWindow}
      <IconButton icon={Setting07Icon} label={m.gallery_open_settings()} onclick={manageFolders} />
      <IconButton
        icon={RefreshIcon}
        label={m.gallery_refresh()}
        disabled={session.loading || session.scanning}
        onclick={() => void session?.refresh()}
      />
    {/if}
  </header>

  <div class="gallery-content">
    {#if privateWindow}
      <div class="centered">
        <EmptyState title={m.gallery_private_title()} description={m.gallery_private_body()}>
          {#snippet icon()}<Icon icon={LockIcon} size={26} />{/snippet}
        </EmptyState>
      </div>
    {:else if !session}
      <div class="centered">
        <EmptyState title={m.gallery_loading()} description={m.gallery_off_note()}>
          {#snippet icon()}<Icon icon={Image02Icon} size={26} />{/snippet}
        </EmptyState>
      </div>
    {:else if !session.enabled}
      <div class="centered">
        <div class="opt-in">
          <span class="opt-in-mark"><Icon icon={Image02Icon} size={26} /></span>
          <h1>{m.gallery_off_title()}</h1>
          <p>{m.gallery_off_body()}</p>
          <ul>
            <li>{m.settings_gallery_default()}: {m.gallery_off_defaults()}</li>
            <li>{m.gallery_off_gallery()}</li>
          </ul>
          <Button onclick={() => void session?.enable()}>{m.gallery_off_button()}</Button>
          <span class="opt-in-note"><Icon icon={LockIcon} size={12} />{m.gallery_off_note()}</span>
        </div>
      </div>
    {:else}
      <div class="controls">
        <SearchField
          label={m.gallery_search()}
          placeholder={m.gallery_search()}
          size="page"
          value={query}
          oninput={(value) => (query = value)}
        />
        <Menu
          label={m.gallery_filter()}
          entries={filterEntries}
          onselect={(id) => chooseFolder(id)}
        >
          {#snippet trigger()}<span class="filter-trigger"
              ><Icon icon={FilterIcon} size={15} />{m.gallery_filter()}</span
            >{/snippet}
        </Menu>
      </div>

      <div class="gallery-body" data-gallery-scroll>
        {#if session.error}
          <div class="centered">
            <EmptyState title={m.gallery_unavailable()} description={m.gallery_unavailable_body()}>
              {#snippet icon()}<Icon icon={Image02Icon} size={26} />{/snippet}
              {#snippet action()}<Button onclick={() => session?.reload()}
                  >{m.gallery_retry()}</Button
                >{/snippet}
            </EmptyState>
          </div>
        {:else if session.items.length === 0}
          {#if session.loading || session.scanning}
            <div class="skeleton-grid" aria-label={m.gallery_loading()}>
              {#each Array(18) as _, index (index)}
                <span class="skeleton" style:--step={index}></span>
              {/each}
            </div>
          {:else}
            <div class="centered">
              <EmptyState
                title={query.trim() || session.folder
                  ? m.gallery_no_matches()
                  : m.gallery_empty_title()}
                description={query.trim() || session.folder
                  ? m.gallery_no_matches_body()
                  : m.gallery_empty_body()}
              >
                {#snippet icon()}<Icon icon={Image02Icon} size={26} />{/snippet}
                {#snippet action()}<div class="empty-actions">
                    <Button onclick={() => void session?.refresh()}>{m.gallery_refresh()}</Button>
                    <Button variant="secondary" onclick={manageFolders}
                      >{m.gallery_open_settings()}</Button
                    >
                  </div>{/snippet}
              </EmptyState>
            </div>
          {/if}
        {:else}
          {#if session.truncated}
            <p class="truncated">
              {m.gallery_truncated({ count: session.items.length })}
            </p>
          {/if}
          <GalleryGrid {session} items={session.items} onopen={openViewer} />
        {/if}
      </div>
    {/if}
  </div>
</section>

{#if viewing && session && session.items.length > 0}
  <!-- A picture the viewer cannot draw must not take the page down with it. -->
  <svelte:boundary onerror={(error) => console.error("gallery viewer:", error)}>
    <GalleryViewer
      items={session.items}
      index={Math.min(viewing.index, session.items.length - 1)}
      {session}
      origin={viewing.origin}
      thumb={session.thumbs.get(
        session.items[Math.min(viewing.index, session.items.length - 1)]?.path ?? "",
      ) ?? null}
      onclose={() => void closeViewer()}
      onmanage={manageFolders}
    />
    {#snippet failed()}
      <div class="viewer-failure" role="alert">
        <p>{m.gallery_unavailable_body()}</p>
        <Button onclick={() => (viewing = null)}>{m.gallery_retry()}</Button>
      </div>
    {/snippet}
  </svelte:boundary>
{/if}

<style>
  .gallery-shell {
    container-type: inline-size;
  }

  .toolbar-status {
    overflow: hidden;
    margin-inline-start: 8px;
    color: var(--color-faint);
    font-size: var(--text-label);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .toolbar-gap {
    flex: 1;
    min-inline-size: 8px;
  }

  .gallery-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-block-size: 0;
    padding: 0 clamp(16px, 3vw, 36px);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    padding-block: 6px 14px;
  }

  .controls :global(.ui-search) {
    flex: 1;
    min-inline-size: 0;
  }

  .filter-trigger {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    box-sizing: border-box;
    block-size: var(--search-height);
    padding: 0 12px;
    border-radius: var(--radius-field);
    background: var(--color-field);
    color: var(--color-label-secondary);
    font-size: var(--text-label);
    white-space: nowrap;
    transition: background-color var(--motion-instant) var(--ease-smooth);
  }

  .filter-trigger:hover {
    background: var(--color-field-hover);
  }

  .gallery-body {
    flex: 1;
    min-block-size: 0;
    margin-inline: calc(clamp(16px, 3vw, 36px) * -1);
    padding-inline: clamp(16px, 3vw, 36px);
    padding-block-end: 24px;
    overflow: hidden auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .centered {
    display: grid;
    place-items: center;
    min-block-size: min(420px, 60vh);
    padding-block: 28px;
  }

  .opt-in {
    display: flex;
    align-items: center;
    flex-direction: column;
    max-inline-size: 430px;
    padding: 30px 28px 22px;
    border-radius: var(--radius-panel);
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
    text-align: center;
  }

  .opt-in-mark {
    display: grid;
    place-items: center;
    inline-size: 52px;
    block-size: 52px;
    margin-block-end: 12px;
    border-radius: var(--radius-card);
    background: var(--color-fill);
    color: var(--color-faint);
  }

  .opt-in h1 {
    margin: 0 0 6px;
    font-size: var(--text-headline);
    font-weight: 600;
    letter-spacing: -0.03em;
  }

  .opt-in p {
    margin: 0 0 14px;
    color: var(--color-muted);
    font-size: var(--text-page-title);
    line-height: 1.55;
  }

  .opt-in ul {
    align-self: stretch;
    margin: 0 0 18px;
    padding: 12px 14px;
    border-radius: var(--radius-card);
    background: var(--color-field);
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.8;
    list-style: none;
    text-align: start;
  }

  .opt-in-note {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-block-start: 12px;
    color: var(--color-faint);
    font-size: 11px;
  }

  .empty-actions {
    display: flex;
    gap: 8px;
  }

  .viewer-failure {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    padding: 24px;
    background: var(--overlay-scrim);
    color: var(--color-text);
  }

  .truncated {
    margin: 0 0 12px;
    padding: 8px 12px;
    border-radius: var(--radius-field);
    background: var(--color-field);
    color: var(--color-muted);
    font-size: var(--text-label);
  }

  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(138px, 1fr));
    gap: 12px;
    padding-block: 4px;
  }

  .skeleton {
    display: block;
    aspect-ratio: 1;
    border-radius: var(--radius-card);
    background: var(--color-field);
    animation: skeleton 1.5s ease-in-out infinite;
    animation-delay: calc(var(--step, 0) * 28ms);
  }

  @keyframes skeleton {
    0%,
    100% {
      opacity: 0.55;
    }

    50% {
      opacity: 1;
    }
  }

  @container (width < 620px) {
    .controls {
      gap: 6px;
    }

    .filter-trigger {
      padding-inline: 10px;
    }

    .toolbar-status {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
      opacity: 0.7;
    }
  }
</style>
