<script lang="ts">
  import { onMount } from "svelte";
  import * as m from "$shared/i18n/messages";
  import {
    Download01Icon,
    IncognitoIcon,
    Moon02Icon,
    MusicNote01Icon,
    Note01Icon,
    Settings02Icon,
    UserIcon,
  } from "@hugeicons/core-free-icons";
  import { commands } from "$shared/ipc/bindings";
  import { IS_MAC } from "$shared/platform";
  import { fullscreen } from "$shared/lib/fullscreen.svelte";
  import Disclosure from "$shared/ui/Disclosure";
  import FavIcon from "$shared/ui/FavIcon";
  import Icon from "$shared/ui/Icon";
  import ProfileAvatar from "$shared/ui/ProfileAvatar";
  import { RailSpaces } from "$features/tabs";
  import { favicons } from "$domain/favicons";
  import { mediaPlayer } from "$domain/media-player";
  import { drawn, profiles } from "$domain/profiles";
  import { tabs } from "$domain/tabs";
  import * as tools from "$session/tools.svelte";
  import { mediaTabs, railToolActive, sleepingTabs } from "../lib/rail-model";

  let { compact = false }: { compact?: boolean } = $props();

  const privateWindow = $derived(tabs.profile()?.kind === "incognito");
  const privately = $derived(profiles.inPrivate() || privateWindow);
  const space = $derived(privateWindow ? undefined : tabs.activeSpace());
  const player = $derived(privateWindow ? null : mediaPlayer.view());
  const playing = $derived(
    mediaTabs(tabs.tabs(), privateWindow).filter((tab) => tab.id !== player?.tab_id),
  );
  const sleeping = $derived(sleepingTabs(tabs.tabs(), privateWindow));
  const current = $derived(privately ? null : profiles.current());
  const face = $derived(current && current.avatar.revision > 0 ? drawn(current) : null);
  const who = $derived(privately ? "" : (tabs.profile()?.name ?? current?.name ?? ""));
  const others = $derived(privately ? [] : profiles.others());
  // macOS keeps AppKit's traffic lights in the window's top-left corner; the
  // rail gives them their row and starts beneath it.
  const lights = $derived(IS_MAC && !fullscreen());

  onMount(() => {
    void profiles.retain();
    return () => profiles.release();
  });

  const run = (id: string) => void commands.runCommand(id).catch(() => {});

  function pick(kind: "downloads" | "notes") {
    if (tools.activeTool() === kind) tools.close();
    else tools.open(kind);
  }
</script>

<!--
  The column's utility rail: the tools and lists that are always one click
  away, at the column's leading edge. Every entry has a real caller — the two
  tool panels through `$session/tools`, the spaces and media lists through the
  window's own tab projection, and the profile through the profile roster.
  It never reads another window's or a private window's data.
-->
<nav
  class="utility-rail"
  data-lights={lights || undefined}
  data-compact={compact || undefined}
  aria-label={m.ui_navigation()}
>
  <div class="rail-items">
    <Disclosure
      label={m.rail_media()}
      triggerTitle={m.rail_media()}
      menu
      triggerClass="rail-item"
      panelClass="rail-popover"
    >
      {#snippet trigger()}<Icon icon={MusicNote01Icon} size={18} />{/snippet}
      {#if privateWindow}
        <p class="rail-empty" role="presentation">{m.rail_private_media()}</p>
      {:else if player === null && playing.length === 0}
        <p class="rail-empty" role="presentation">{m.rail_nothing_playing()}</p>
      {:else}
        {#if player}
          <button
            type="button"
            role="menuitem"
            class="ui-menu-item rail-row"
            title={player.title}
            aria-label={player.title}
            onclick={() => mediaPlayer.show()}
          >
            <span class="rail-row-icon"
              ><FavIcon
                image={favicons.image(player.icon)}
                tone={favicons.tone(player.icon)}
                size={16}
              /></span
            >
            <span class="rail-row-title">{player.title}</span>
            <span class="rail-row-hint">{player.artist || m.media_player()}</span>
          </button>
        {/if}
        {#each playing as tab (tab.id)}
          <button
            type="button"
            role="menuitem"
            class="ui-menu-item rail-row"
            title={tab.title || m.untitled_tab()}
            aria-label={tab.title || m.untitled_tab()}
            onclick={() => tabs.activate(tab.id)}
          >
            <span class="rail-row-icon"
              ><FavIcon
                image={favicons.image(tab.icon)}
                tone={favicons.tone(tab.icon)}
                loading={tab.loading}
                size={16}
              /></span
            >
            <span class="rail-row-title">{tab.title || m.untitled_tab()}</span>
            <span class="rail-row-hint">{m.media_player()}</span>
          </button>
        {/each}
      {/if}
    </Disclosure>

    <button
      type="button"
      class="rail-button"
      title={m.menu_downloads()}
      aria-label={m.menu_downloads()}
      aria-current={railToolActive("downloads", tools.activeTool()) ? "true" : undefined}
      onclick={() => pick("downloads")}
    >
      <Icon icon={Download01Icon} size={18} />
    </button>

    <button
      type="button"
      class="rail-button"
      title={m.panel_notes()}
      aria-label={m.panel_notes()}
      aria-current={railToolActive("notes", tools.activeTool()) ? "true" : undefined}
      onclick={() => pick("notes")}
    >
      <Icon icon={Note01Icon} size={18} />
    </button>

    {#if space}
      <RailSpaces active={space} label={m.browse_spaces_all()} />
    {/if}

    <Disclosure
      label={m.settings_sleeping_tabs()}
      triggerTitle={m.settings_sleeping_tabs()}
      menu
      triggerClass="rail-item"
      panelClass="rail-popover"
    >
      {#snippet trigger()}<Icon icon={Moon02Icon} size={18} />{/snippet}
      {#if privateWindow}
        <p class="rail-empty" role="presentation">{m.rail_private_sleeping_tabs()}</p>
      {:else if sleeping.length === 0}
        <p class="rail-empty" role="presentation">{m.rail_no_sleeping_tabs()}</p>
      {:else}
        {#each sleeping as tab (tab.id)}
          <button
            type="button"
            role="menuitem"
            class="ui-menu-item rail-row"
            title={tab.title || m.untitled_tab()}
            aria-label={tab.title || m.untitled_tab()}
            onclick={() => tabs.activate(tab.id)}
          >
            <span class="rail-row-icon"
              ><FavIcon
                image={favicons.image(tab.icon)}
                tone={favicons.tone(tab.icon)}
                loading={tab.loading}
                size={16}
              /></span
            >
            <span class="rail-row-title">{tab.title || m.untitled_tab()}</span>
          </button>
        {/each}
      {/if}
    </Disclosure>
  </div>

  <div class="rail-foot">
    <Disclosure
      label={m.rail_profile()}
      triggerTitle={who || m.rail_profile()}
      menu
      triggerClass="rail-item rail-profile"
      panelClass="rail-profile-menu"
    >
      {#snippet trigger()}{#if face}<ProfileAvatar view={face} size={20} />{:else}<Icon
            icon={UserIcon}
            size={18}
          />{/if}{/snippet}
      <button
        type="button"
        role="menuitem"
        class="ui-menu-item rail-row"
        title={m.browse_profile_settings()}
        aria-label={who ? `${who} — ${m.browse_profile_settings()}` : m.browse_profile_settings()}
        onclick={() => run("settings.profiles")}
      >
        <span class="rail-row-icon"
          >{#if face}<ProfileAvatar view={face} size={16} />{:else}<Icon
              icon={UserIcon}
              size={16}
            />{/if}</span
        >
        <span class="rail-row-title">{who || m.browse_profile_settings()}</span>
        <span class="rail-row-hint">{m.browse_profile_settings()}</span>
      </button>
      {#if others.length > 0}
        <div class="rail-rule" role="separator"></div>
        {#each others as profile (profile.id)}
          <button
            type="button"
            role="menuitem"
            class="ui-menu-item rail-row"
            title={profile.name}
            aria-label={m.profiles_switch_label({ name: profile.name })}
            onclick={() => void profiles.switchTo(profile.id)}
          >
            <span class="rail-row-icon"><ProfileAvatar view={drawn(profile)} size={16} /></span>
            <span class="rail-row-title">{profile.name}</span>
          </button>
        {/each}
      {/if}
      {#if !privately}
        <div class="rail-rule" role="separator"></div>
        <button
          type="button"
          role="menuitem"
          class="ui-menu-item rail-row"
          title={m.menu_incognito()}
          aria-label={m.menu_incognito()}
          onclick={() => run("window.newPrivate")}
        >
          <span class="rail-row-icon"><Icon icon={IncognitoIcon} size={16} /></span>
          <span class="rail-row-title">{m.menu_incognito()}</span>
        </button>
      {/if}
      <div class="rail-rule" role="separator"></div>
      <button
        type="button"
        role="menuitem"
        class="ui-menu-item rail-row"
        title={m.command_browser_settings()}
        aria-label={m.command_browser_settings()}
        onclick={() => run("browser.settings")}
      >
        <span class="rail-row-icon"><Icon icon={Settings02Icon} size={16} /></span>
        <span class="rail-row-title">{m.command_browser_settings()}</span>
      </button>
    </Disclosure>
  </div>
</nav>

<style>
  /* The rail runs the full height of the column's card, so the profile can
     stand at its foot however long the tab list beside it is. */
  .utility-rail {
    display: flex;
    flex: 0 0 var(--rail-width);
    flex-direction: column;
    align-items: center;
    inline-size: var(--rail-width);
    min-block-size: 0;
    padding-block-end: 8px;
    color: var(--color-muted);
  }

  /* The traffic lights' row, when AppKit draws them in the window's corner. */
  .utility-rail[data-lights] {
    padding-block-start: var(--titlebar-height);
  }

  .rail-items {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .rail-foot {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-block-start: auto;
    padding-block-start: 8px;
  }

  /* Every rail mark is the same 32px plate: an 18px glyph, an 8px corner,
     the row fills for hover and the active one. */
  .rail-button,
  .utility-rail :global(.rail-item) {
    display: grid;
    place-items: center;
    inline-size: 32px;
    block-size: 32px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-inset);
    background: transparent;
    color: var(--color-faint);
    cursor: default;
    outline: none;
    transition:
      background-color var(--motion-fast) var(--ease-out),
      color var(--motion-fast) var(--ease-out),
      scale var(--motion-fast) var(--ease-out);
  }

  .rail-button:hover,
  .rail-button:focus-visible,
  .utility-rail :global(.rail-item:hover),
  .utility-rail :global(.rail-item:focus-visible) {
    background: var(--row-hover);
    color: var(--color-label-secondary);
  }

  .rail-button[aria-current="true"],
  .utility-rail :global(.rail-item[data-state="open"]) {
    background: var(--row-active);
    color: var(--color-text);
  }

  .rail-button:active,
  .utility-rail :global(.rail-item:active) {
    scale: 0.94;
    transition-duration: var(--motion-instant);
  }

  .rail-button:focus-visible,
  .utility-rail :global(.rail-item:focus-visible) {
    box-shadow: var(--shadow-field-focus);
  }

  /* The profile's trigger is an avatar rather than a glyph; the same plate
     still holds it, so the foot lines up with every mark above. */
  .utility-rail :global(.rail-profile) {
    border-radius: var(--radius-inset);
  }

  /* A list or a menu beside the rail, opening to its right rather than under
     the 32px mark it hangs from. It never runs past the column: the native
     page is drawn over everything beyond the published width, so a panel
     wider than the column would be cut off at the page's edge. */
  :global(.rail-popover.ui-disclosure-panel) {
    top: 0;
    inset-inline-start: calc(100% + 8px);
    min-inline-size: 0;
    max-inline-size: calc(var(--sidebar-width, 240px) - 40px);
    max-block-size: calc(100vh - 120px);
    overflow-y: auto;
    overscroll-behavior: contain;
    transform-origin: top left;
  }

  /* The profile's menu rises out of the foot, as the dock's does. */
  :global(.rail-profile-menu.ui-disclosure-panel) {
    top: auto;
    bottom: calc(100% + 8px);
    inset-inline-start: 0;
    min-inline-size: 0;
    max-inline-size: calc(var(--sidebar-width, 240px) - 8px);
    max-block-size: calc(100vh - 120px);
    overflow-y: auto;
    overscroll-behavior: contain;
    transform-origin: bottom left;
  }

  /* At rail width the column is only 56px, so a panel is the same narrow
     stack of glyphs the spaces menu uses; its rows keep their names for the
     keyboard and the native tooltip. */
  .utility-rail[data-compact="true"] :global(.rail-popover.ui-disclosure-panel),
  .utility-rail[data-compact="true"] :global(.rail-profile-menu.ui-disclosure-panel) {
    inset-inline-start: -8px;
    inline-size: 48px;
    min-inline-size: 48px;
    max-inline-size: 48px;
  }

  .rail-row {
    inline-size: 100%;
    min-block-size: 32px;
    border: 0;
    background: transparent;
    font: inherit;
    text-align: start;
  }

  .rail-row-icon {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 16px;
  }

  .rail-row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail-row-hint {
    margin-inline-start: auto;
    padding-inline-start: 16px;
    color: var(--color-faint);
    font-size: var(--text-label);
  }

  .rail-rule {
    block-size: 1px;
    margin: 4px var(--menu-item-inset);
    background: var(--color-border);
  }

  .rail-empty {
    margin: 0;
    padding: 8px 6px;
    color: var(--color-faint);
    font-size: var(--text-label);
  }

  .utility-rail[data-compact="true"] .rail-row {
    justify-content: center;
    padding-inline: 0;
  }

  .utility-rail[data-compact="true"] .rail-row-title,
  .utility-rail[data-compact="true"] .rail-row-hint {
    display: none;
  }

  .utility-rail[data-compact="true"] .rail-empty {
    padding: 10px 0;
    overflow: hidden;
    font-size: 0;
    text-align: center;
  }

  .utility-rail[data-compact="true"] .rail-empty::after {
    color: var(--color-faint);
    content: "—";
    font-size: var(--text-label);
  }

  @media (prefers-reduced-motion: reduce) {
    .rail-button,
    .utility-rail :global(.rail-item) {
      transition: none;
    }
  }
</style>
