<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import {
    Download01Icon,
    Moon02Icon,
    MusicNote01Icon,
    Note01Icon,
    PuzzleIcon,
    SidebarLeftIcon,
    Sun03Icon,
    ZzzIcon,
  } from "@hugeicons/core-free-icons";
  import Icon from "$shared/ui/Icon";
  import Disclosure from "$shared/ui/Disclosure";
  import FavIcon from "$shared/ui/FavIcon";
  import LazyView from "$shared/ui/LazyView";
  import { loadExtensionHub } from "$features/extensions";
  import { RailSpaces } from "$features/tabs";
  import { extensions } from "$domain/extensions";
  import { favicons } from "$domain/favicons";
  import { mediaPlayer } from "$domain/media-player";
  import { preferences } from "$domain/preferences";
  import { tabs } from "$domain/tabs";
  import { webext } from "$domain/webext";
  import * as tools from "$session/tools.svelte";
  import { mediaTabs, railToolActive, sleepingTabs } from "../lib/rail-model";

  let {
    compact = false,
    ontoggle,
  }: {
    /** The 56px column: the bar stacks in two narrow columns instead of a row. */
    compact?: boolean;
    /** Puts the column away. Absent where the surface owns its own way out. */
    ontoggle?: () => void;
  } = $props();

  const privateWindow = $derived(tabs.profile()?.kind === "incognito");
  const space = $derived(privateWindow ? undefined : tabs.activeSpace());
  const player = $derived(privateWindow ? null : mediaPlayer.view());
  const playing = $derived(
    mediaTabs(tabs.tabs(), privateWindow).filter((tab) => tab.id !== player?.tab_id),
  );
  const sleeping = $derived(sleepingTabs(tabs.tabs(), privateWindow));
  const extensionActions = $derived(
    extensions.activeActions(tabs.profile()?.id ?? null, tabs.activeId()),
  );

  // The quick switch follows the sun rather than the stored word: in System,
  // the icon and the click say what the window is actually showing.
  let systemDark = $state(window.matchMedia("(prefers-color-scheme: dark)").matches);
  $effect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => (systemDark = media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });
  const appearance = $derived(preferences.value("appearance"));
  const dark = $derived(appearance === "dark" || (appearance === "system" && systemDark));
  // The hub and its menu machinery arrive the first time the door opens, not
  // with the column's own startup.
  let hubOpened = $state(false);

  function toggleTheme() {
    void preferences.set("appearance", dark ? "light" : "dark");
  }

  function pick(kind: "downloads" | "notes") {
    if (tools.activeTool() === kind) tools.close();
    else tools.open(kind);
  }
</script>

<!--
  The column's utilities, at its head: media, downloads, notes, spaces, the
  sleeping list and the one extension door, with the shape toggle first. They
  used to be a 44px strip beside the column; folding them into the column's
  own top row gives that width back to the page while keeping every entry one
  click away. The extension door is a single button: the hub it opens carries
  the installed extensions, the page actions, management, both stores and
  installing from a file, so there is no second puzzle to explain.
  Every entry has a real caller — the two tool panels through `$session/tools`,
  the spaces and media lists through the window's own tab projection. It never
  reads another window's or a private window's data.
-->
<nav class="utility-bar" data-compact={compact || undefined} aria-label={m.ui_navigation()}>
  {#if ontoggle}
    <button
      type="button"
      class="rail-button bar-toggle"
      style:--step={0}
      title={m.ui_compact_mode()}
      aria-label={m.ui_compact_mode()}
      onclick={ontoggle}
    >
      <Icon icon={SidebarLeftIcon} size={17} />
    </button>
  {/if}
  {#if ontoggle && !compact}<span class="bar-rule" aria-hidden="true"></span>{/if}

  <div class="bar-cell" style:--step={ontoggle ? 1 : 0}>
    <Disclosure
      label={m.rail_media()}
      triggerTitle={m.rail_media()}
      menu
      triggerClass="rail-item"
      panelClass="bar-popover"
    >
      {#snippet trigger()}{#if player !== null || playing.length > 0}<span
            class="rail-pip"
            aria-hidden="true"
          ></span>{/if}<Icon icon={MusicNote01Icon} size={18} />{/snippet}
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
            style:--row={0}
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
        {#each playing as tab, index (tab.id)}
          <button
            type="button"
            role="menuitem"
            class="ui-menu-item rail-row"
            style:--row={player ? index + 1 : index}
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
  </div>

  <button
    type="button"
    class="rail-button"
    style:--step={ontoggle ? 2 : 1}
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
    style:--step={ontoggle ? 3 : 2}
    title={m.panel_notes()}
    aria-label={m.panel_notes()}
    aria-current={railToolActive("notes", tools.activeTool()) ? "true" : undefined}
    onclick={() => pick("notes")}
  >
    <Icon icon={Note01Icon} size={18} />
  </button>

  {#if space}
    <div class="bar-cell" style:--step={ontoggle ? 4 : 3}>
      <RailSpaces active={space} label={m.browse_spaces_all()} />
    </div>
  {/if}

  <div class="bar-cell" style:--step={ontoggle ? 5 : 4}>
    <Disclosure
      label={m.settings_sleeping_tabs()}
      triggerTitle={m.settings_sleeping_tabs()}
      menu
      triggerClass="rail-item"
      panelClass="bar-popover"
    >
      {#snippet trigger()}{#if sleeping.length > 0}<span class="rail-pip" aria-hidden="true"
          ></span>{/if}<Icon icon={ZzzIcon} size={18} strokeWidth={1.9} />{/snippet}
      {#if privateWindow}
        <p class="rail-empty" role="presentation">{m.rail_private_sleeping_tabs()}</p>
      {:else if sleeping.length === 0}
        <p class="rail-empty" role="presentation">{m.rail_no_sleeping_tabs()}</p>
      {:else}
        {#each sleeping as tab, index (tab.id)}
          <button
            type="button"
            role="menuitem"
            class="ui-menu-item rail-row"
            style:--row={index}
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
                sleeping
              /></span
            >
            <span class="rail-row-title">{tab.title || m.untitled_tab()}</span>
          </button>
        {/each}
      {/if}
    </Disclosure>
  </div>

  <div class="bar-cell" style:--step={ontoggle ? 6 : 5}>
    <Disclosure
      label={m.webext_page_title()}
      triggerTitle={m.webext_page_title()}
      triggerClass="rail-item"
      panelClass="bar-popover extension-popover"
      onopen={() => {
        hubOpened = true;
        void webext.refresh();
      }}
    >
      {#snippet trigger()}{#if extensionActions.length > 0}<span class="rail-pip" aria-hidden="true"
          ></span>{/if}<Icon icon={PuzzleIcon} size={18} />{/snippet}
      {#if hubOpened}
        <LazyView
          loader={loadExtensionHub}
          loadingLabel={m.surface_loading()}
          failureLabel={m.surface_render_failed()}
          retryLabel={m.surface_retry()}
        >
          {#snippet children(View)}<View />{/snippet}
        </LazyView>
      {/if}
    </Disclosure>
  </div>

  <button
    type="button"
    class="rail-button"
    style:--step={ontoggle ? 7 : 6}
    title={dark ? m.command_theme_light() : m.command_theme_dark()}
    aria-label={dark ? m.command_theme_light() : m.command_theme_dark()}
    aria-pressed={dark}
    onclick={toggleTheme}
  >
    <Icon icon={dark ? Sun03Icon : Moon02Icon} size={18} />
  </button>
</nav>

<style>
  /* One row across the head of the column. The plates match the header's own
     controls, so the tools read as part of the chrome rather than a strip
     bolted to its side. */
  .utility-bar {
    position: relative;
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    min-inline-size: 0;
    color: var(--color-muted);
  }

  /* The disclosure's panel is positioned against the bar, not against the
     26px plate it hangs from: a list that opens under the bar's leading edge
     is the width of the column, so its rows can be read. */
  .utility-bar :global(.ui-disclosure) {
    position: static;
    display: grid;
    place-items: center;
  }

  .bar-cell {
    display: grid;
    place-items: center;
  }

  /* The shape toggle is not a tool: a hairline keeps it apart from the five
     marks that act on the page. */
  .bar-rule {
    flex: none;
    inline-size: 1px;
    block-size: 14px;
    margin-inline: 3px;
    border-radius: 1px;
    background: var(--color-border);
  }

  /* Every mark is the same 26px plate: an 18px glyph, an 8px corner, the row
     fills for hover and for the active one. */
  .rail-button,
  .utility-bar :global(.rail-item) {
    position: relative;
    display: grid;
    place-items: center;
    inline-size: 26px;
    block-size: 26px;
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

  /* Something to listen to, or something asleep: one accent point says the
     list behind the glyph is not empty, without opening it. */
  .rail-pip {
    position: absolute;
    inset-block-start: 5px;
    inset-inline-end: 5px;
    inline-size: 4px;
    block-size: 4px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: rail-pip-in var(--motion-base) var(--ease-out) both;
  }

  @keyframes rail-pip-in {
    from {
      opacity: 0;
      scale: 0.2;
    }
  }

  .rail-button:hover,
  .rail-button:focus-visible,
  .utility-bar :global(.rail-item:hover),
  .utility-bar :global(.rail-item:focus-visible) {
    background: var(--row-hover);
    color: var(--color-label-secondary);
  }

  .rail-button[aria-current="true"],
  .utility-bar :global(.rail-item[data-state="open"]) {
    background: var(--row-active);
    color: var(--color-text);
  }

  .rail-button:active,
  .utility-bar :global(.rail-item:active) {
    scale: 0.9;
    transition-duration: var(--motion-instant);
  }

  .rail-button:focus-visible,
  .utility-bar :global(.rail-item:focus-visible) {
    box-shadow: var(--shadow-field-focus);
  }

  /* The bar arriving: each plate settles a beat after the one before it, so
     opening a shape reads as the tools being laid out rather than snapping
     into place. */
  .utility-bar > :global(*) {
    animation: bar-plate-in var(--motion-base) var(--ease-out) backwards;
    animation-delay: calc(var(--step, 0) * 18ms);
  }

  @keyframes bar-plate-in {
    from {
      opacity: 0;
      scale: 0.82;
    }
  }

  /* Under the bar, from its leading edge: the width of the column, so names
     and hints have somewhere to go. */
  :global(.bar-popover.ui-disclosure-panel[data-align]) {
    inset-inline-start: 0;
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: none;
    max-block-size: calc(100vh - 120px);
    overflow-y: auto;
    overscroll-behavior: contain;
    transform-origin: top left;
  }

  /* The extension hub needs room for names, switches and menus even when the
     trigger sits in the 56px rail. It takes the column's width when that is
     wider, and otherwise grows past the trigger toward the page, bounded by
     the window rather than by the column. */
  :global(.extension-popover.ui-disclosure-panel[data-align]) {
    inset-inline-start: 0;
    inline-size: min(max(100%, 296px), calc(100vw - 20px));
    min-inline-size: min(280px, calc(100vw - 20px));
    max-inline-size: none;
    max-block-size: calc(100vh - 96px);
    padding: 4px;
    overflow: hidden auto;
    transform-origin: top left;
  }

  /* The expanded column never goes below its one-row minimum. The grid is for
     the narrow rail and a compact header, not for a settled expanded column. */
  @container (max-width: 240px) {
    .utility-bar:not([data-compact]) {
      display: grid;
      flex: 1;
      grid-template-columns: repeat(4, 26px);
      justify-content: center;
      gap: 4px;
      min-inline-size: 0;
    }

    .utility-bar:not([data-compact]) .bar-rule {
      display: none;
    }
  }

  @container (max-width: 196px) {
    .utility-bar:not([data-compact]) {
      grid-template-columns: repeat(4, 24px);
      gap: 2px;
    }

    .utility-bar:not([data-compact]) .rail-button,
    .utility-bar:not([data-compact]) :global(.rail-item) {
      inline-size: 24px;
      block-size: 24px;
    }

    .utility-bar:not([data-compact]) .rail-button :global(svg),
    .utility-bar:not([data-compact]) :global(.rail-item svg) {
      inline-size: 16px;
      block-size: 16px;
    }
  }

  .rail-row {
    inline-size: 100%;
    min-block-size: 32px;
    border: 0;
    background: transparent;
    font: inherit;
    text-align: start;
  }

  /* A list settles in behind its own rows, as the spaces stack does. */
  :global(.bar-popover[data-open="true"] .rail-row) {
    animation: bar-row-in var(--motion-base) var(--ease-out) both;
    animation-delay: calc(var(--row, 0) * 16ms);
  }

  @keyframes bar-row-in {
    from {
      opacity: 0;
      translate: 0 -4px;
    }
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

  .rail-empty {
    margin: 0;
    padding: 8px 6px;
    color: var(--color-faint);
    font-size: var(--text-label);
  }

  /* In the 56px column the bar is a two-column tool grid under the head, so
     it costs vertical room that the list already scrolls through and no
     width the page would miss. */
  .utility-bar[data-compact="true"] {
    display: grid;
    flex: none;
    grid-template-columns: repeat(2, 26px);
    gap: 4px;
    justify-content: center;
    inline-size: 100%;
    padding-block: 4px;
  }

  .utility-bar[data-compact="true"] .rail-row {
    justify-content: center;
    padding-inline: 0;
  }

  .utility-bar[data-compact="true"] .rail-row-title,
  .utility-bar[data-compact="true"] .rail-row-hint {
    display: none;
  }

  .utility-bar[data-compact="true"] .rail-empty {
    padding: 10px 0;
    overflow: hidden;
    font-size: 0;
    text-align: center;
  }

  .utility-bar[data-compact="true"] .rail-empty::after {
    color: var(--color-faint);
    content: "—";
    font-size: var(--text-label);
  }

  @media (prefers-reduced-motion: reduce) {
    .rail-button,
    .utility-bar :global(.rail-item) {
      transition: none;
    }

    .utility-bar > :global(*),
    :global(.bar-popover[data-open="true"] .rail-row) {
      animation: none;
    }

    .rail-pip {
      animation: none;
    }
  }
</style>
