<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import type { Snippet } from "svelte";
  import { EllipsisIcon } from "@hugeicons/core-free-icons";
  import { tabs } from "$domain/tabs";
  import { blocker, blockerSites, siteMenuState } from "$domain/blocker";
  import { clearRequest, pageSite } from "$domain/site-data";
  import { extensions } from "$domain/extensions";
  import { webext } from "$domain/webext";
  import { surface } from "$domain/surface";
  import { uiCommands as ui } from "$domain/ui-commands";
  import { toggleMode } from "$session/sidebar-mode.svelte";
  import { openAt } from "$features/menus";
  import { untrack } from "svelte";
  import { IS_MAC } from "$shared/platform";
  import { fullscreen } from "$shared/lib/fullscreen.svelte";
  import IconButton from "$shared/ui/IconButton";
  import ModeTabs from "./ModeTabs.svelte";
  import SidebarSearch from "./SidebarSearch.svelte";
  import SiteShield from "./SiteShield.svelte";

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
    const url = active?.url ?? null;
    // A private window keeps nothing to clear, and only a web page has a site.
    const canClearData =
      tabs.profile()?.kind !== "incognito" &&
      (active?.content ?? "web") === "web" &&
      pageSite(url) !== null;
    const profile = tabs.profile()?.id ?? null;
    const tab = tabs.activeId();
    const actions = extensions.activeActions(profile, tab);
    const rows: Parameters<typeof openAt>[0]["items"] = [
      ...(siteProtected !== null
        ? [
            {
              kind: "item" as const,
              id: "sidebar.siteProtection",
              label: `Site protection: ${siteProtected ? "On" : "Off"}`,
            },
          ]
        : []),
      ...(canHide ? [{ kind: "item" as const, id: "sidebar.hide", label: "Hide sidebar" }] : []),
      ...(canClearData
        ? [
            {
              kind: "item" as const,
              id: "sidebar.clearData",
              label: m.native_clear_data_for_this_site_more(),
            },
          ]
        : []),
      ...(actions.length > 0
        ? [
            { kind: "separator" as const },
            ...actions.map((action) => ({
              kind: "item" as const,
              id: `sidebar.extension.${action.runtime.install_id}`,
              label: action.badge ? `${action.label} (${action.badge})` : action.label,
              disabled: !action.enabled,
            })),
          ]
        : []),
      ...(webext.isAvailable()
        ? [
            ...(actions.length > 0 ? [{ kind: "separator" as const }] : []),
            {
              kind: "item" as const,
              id: "sidebar.manageExtensions",
              label: m.native_manage_extensions_more(),
            },
          ]
        : []),
    ];
    openAt({ x: anchor.left, y: anchor.bottom, items: rows }, (choice) => {
      if (choice === "sidebar.siteProtection" && siteProtected !== null)
        void blockerSites.setProtected(!siteProtected);
      else if (choice === "sidebar.hide") toggleMode();
      else if (choice === "sidebar.clearData") clearRequest.ask(url);
      else if (choice === "sidebar.manageExtensions") void surface.open("extensions");
      else if (choice.startsWith("sidebar.extension.")) {
        const id = choice.slice("sidebar.extension.".length);
        const action = actions.find((candidate) => candidate.runtime.install_id === id);
        if (profile !== null && tab !== null && action) {
          void extensions.invoke(profile, tab, action, anchor);
        }
      }
    });
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
      <SiteShield />
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
    <SiteShield />
  </header>
{/if}

<style>
  /* The utility bar inside follows the header's own width, not the window's,
     so dragging the column narrow rearranges the tools at the right moment. */
  .sidebar-toolbar {
    container-type: inline-size;
  }

  /* When the utilities become the two-row grid, the shield belongs on the
     first row with the tools instead of floating at the seam between rows. */
  @container (max-width: 260px) {
    .sidebar-toolbar :global(.site-shield) {
      align-self: flex-start;
    }
  }
</style>
