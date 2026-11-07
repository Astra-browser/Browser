<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import type { Snippet } from "svelte";
  import { EllipsisIcon } from "@hugeicons/core-free-icons";
  import { tabs } from "$domain/tabs";
  import { blocker, siteMenuState } from "$domain/blocker";
  import { pageSite } from "$domain/site-data";
  import { extensions } from "$domain/extensions";
  import { webext } from "$domain/webext";
  import { uiCommands as ui } from "$domain/ui-commands";
  import { untrack } from "svelte";
  import { commands } from "$shared/ipc/bindings";
  import { IS_MAC } from "$shared/platform";
  import { fullscreen } from "$shared/lib/fullscreen.svelte";
  import IconButton from "$shared/ui/IconButton";
  import ModeTabs from "./ModeTabs.svelte";
  import SidebarSearch from "./SidebarSearch.svelte";

  let {
    compact,
    pageControls = true,
    utilities,
  }: {
    compact: boolean;
    /** Back, forward and reload act on a page; Work shows none. */
    pageControls?: boolean;
    /** The tools that stand at the column's head, in one row or the rail grid. */
    utilities?: Snippet;
  } = $props();

  let active = $derived(tabs.activeTab());
  // In fullscreen the lights are gone, and so is the room kept for them.
  let lights = $derived(IS_MAC && !fullscreen());

  // At rail width the extensions' buttons live in this menu; a popup chosen
  // there hangs from the button that opened it.
  let menuAnchor: DOMRect | null = null;
  function openSidebarMenu(event: MouseEvent) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) return;
    const anchor = target.getBoundingClientRect();
    menuAnchor = anchor;
    const { siteProtected, canHide } = siteMenuState(blocker.status());
    // A private window keeps nothing to clear, and only a web page has a site.
    const canClearData =
      tabs.profile()?.kind !== "incognito" &&
      (active?.content ?? "web") === "web" &&
      pageSite(active?.url) !== null;
    const listed = extensions
      .activeActions(tabs.profile()?.id ?? null, tabs.activeId())
      .map((action) => ({
        id: action.runtime.install_id,
        label: action.badge ? `${action.label} (${action.badge})` : action.label,
        icon: action.icon_rgba_base64,
        enabled: action.enabled,
      }));
    void commands.sidebarMenuPopup(
      anchor.left,
      anchor.bottom,
      siteProtected,
      canHide,
      canClearData,
      listed,
      webext.isAvailable(),
    );
  }

  let handledCommand = 0;
  $effect(() => {
    const command = ui.uiCommand();
    if (command.seq === 0 || command.seq === handledCommand) return;
    handledCommand = command.seq;
    if (!command.id.startsWith("extension.action=")) return;
    const id = command.id.slice("extension.action=".length);
    untrack(() => {
      const profile = tabs.profile()?.id ?? null;
      const tab = tabs.activeId();
      const action = extensions
        .activeActions(profile, tab)
        .find((candidate) => candidate.runtime.install_id === id);
      if (profile === null || tab === null || !action || !menuAnchor) return;
      void extensions.invoke(profile, tab, action, menuAnchor);
    });
  });
</script>

<!--
  macOS keeps AppKit's traffic lights through the overlay title bar, so the
  leading 52px of the top row belongs to the system, except in fullscreen,
  where AppKit hides them. Windows reveals native controls at the top-right
  edge. Linux's are the product's own, and they are not part of this row: they
  wait at the window's top-right corner until the pointer reaches it
  (`WindowControlsOverlay`), so the header holds nothing that acts on the
  window rather than on the column.
-->
{#if compact}
  <!--
    The rail's head: which environment you are in, then the two controls that
    act on the column. At 56px two 26px buttons are exactly what fits on one
    line, and the rule below them says where the head ends.
  -->
  <header
    class="flex shrink-0 flex-col items-center gap-[3px]"
    data-drag-region
    aria-label={m.ui_navigation()}
  >
    {#if lights}
      <div style:height="var(--titlebar-height)" aria-hidden="true"></div>
    {:else if IS_MAC}
      <div style:height="8px" aria-hidden="true"></div>
    {/if}
    <ModeTabs compact />
    <div class="flex items-center gap-0.5">
      <!-- Its menu acts on the page and the column's shape; Work has neither. -->
      {#if pageControls}<IconButton
          icon={EllipsisIcon}
          label={m.ui_sidebar_options()}
          size={15}
          buttonSize={26}
          haspopup
          onclick={openSidebarMenu}
        />{/if}
      <SidebarSearch small />
    </div>
    <span class="mt-[6px] mb-[7px] h-px w-[22px] rounded-full bg-border" aria-hidden="true"></span>
  </header>
{:else}
  <header
    class="sidebar-toolbar flex shrink-0 items-center pe-2"
    data-drag-region
    style:min-height="var(--titlebar-height)"
    style:padding-inline-start={lights ? "var(--traffic-light-inset)" : "var(--tab-inset)"}
    aria-label={m.ui_navigation()}
  >
    {#if utilities}{@render utilities()}{/if}
  </header>
{/if}
