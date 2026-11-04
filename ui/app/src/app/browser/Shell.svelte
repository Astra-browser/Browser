<script lang="ts">
  const loadWorkWorkspace = () => import("./WorkWorkspace.svelte");
  // Loaded on the first visit to Work, the only place it shows.
  let accountButton: ReturnType<typeof importAccountButton> | null = null;
  function importAccountButton() {
    return import("$features/account").then((account) => account.loadAccountButton());
  }
  const loadAccountButton = () => (accountButton ??= importAccountButton());
  // The settings rail stands only beside the settings page, whose own code is
  // lazy too; loaded once and kept, like the account foot.
  let settingsNavigation: ReturnType<typeof loadSettingsNavigation> | null = null;
  const importSettingsNavigation = () => (settingsNavigation ??= loadSettingsNavigation());
  // Dynamic like the panel's own path to Notes, so the feature's entry is
  // never a startup request.
  const loadNotesPage = () => import("$features/notes").then((notes) => notes.loadNotesPage());
  import LazyView from "$shared/ui/LazyView";
  import type { TabView } from "$shared/ipc/bindings";
  import { newTabImage } from "$session/newtab-background.svelte";
  import SkyLight from "./SkyLight.svelte";
  import RenderBoundary from "$shared/ui/RenderBoundary";
  import { loadClearSiteData, loadSettings } from "$features/settings";
  import { EssentialTile } from "$features/essentials";
  import { AddressField, SiteDetails, SiteHead, findInPage } from "$features/address";
  import { SidebarPagePermission } from "$features/permissions";
  import { Dock } from "$features/dock";
  import { DownloadPulse, DownloadStatus } from "$features/downloads";
  import { loadMediaPlayer } from "$features/media";
  import { mediaPlayer } from "$domain/media-player";
  import { UpdateNotice } from "$features/updates";
  import { EssentialsRail } from "$features/essentials";
  import { ExtensionsSection, PinnedExtensions } from "$features/extensions";
  import { loadWebExtensionManager, StoreInstallRail } from "$features/webext";
  import { sidebarTree } from "$features/tabs";
  import { SidebarBody } from "$features/tabs";
  import { TabList } from "$features/tabs";
  import { TabRail } from "$features/tabs";
  import { loadNavigationError, loadTabCapacityState } from "$features/tabs";
  import { selectionGlide } from "$features/tabs";
  import * as tabDrag from "$session/tab-drag.svelte";
  import { requestTab } from "$session/work-tab.svelte";
  import {
    expanded as sidebarWidth,
    isHidden as sidebarHidden,
  } from "$session/sidebar-mode.svelte";
  import { uiCommands as ui } from "$domain/ui-commands";
  import { untrack, type Component, type Snippet } from "svelte";
  import { clearRequest } from "$domain/site-data";
  import { BlockerShield, HidingBar, hideElements, toggleSiteProtection } from "$features/blocker";

  import { onMount } from "svelte";
  import { events } from "$shared/ipc/native-events";
  import { askSettings, handleNativeSection } from "$features/settings";
  import * as m from "$shared/i18n/messages";
  import { surface as browserPage } from "$domain/surface";
  import { loadToolSlot } from "$features/tools";
  import * as toolHost from "$session/tools.svelte";
  import * as notices from "$session/notice.svelte";
  import { loadSettingsNavigation } from "$features/settings";
  import { loadLibraryPage } from "$features/library";
  import { loadHistoryPage } from "$features/history";
  import { loadSourcePage } from "$features/source";
  import { bookmarkReveal } from "$features/bookmarks";
  import { loadTasksPage } from "$features/tasks";
  import { loadFocusCover, loadTimePage } from "$features/time";
  import { focus } from "$domain/time";
  import { loadNewTabSearch } from "$features/search";
  import { loadNewTab } from "$features/newtab";
  import {
    ModeTabs,
    PrivateBar,
    PrivateReturn,
    Sidebar,
    SidebarSearch,
    SidebarNotice,
    UtilityTray,
  } from "$features/sidebar";
  import { ContentBar } from "$features/toolbar";
  import { IS_WINDOWS } from "$shared/platform";
  import { installChromeMenu } from "$shared/lib/chrome-menu";
  import { ContextMenu, install as installShellMenu, openAt } from "$features/menus";
  import { installTabMenuPresenter } from "./tab-menu";
  import { tabs } from "$domain/tabs";
  import { preferences } from "$domain/preferences";
  /** New Note, from the menu or its shortcut: a note starts where notes are open. */
  async function newNote() {
    const profile = tabs.profile()?.id;
    if (!profile) return;
    const page = browserPage.currentPage() === "notes";
    if (!page) toolHost.open("notes");
    const { noteSession } = await import("$domain/notes");
    await noteSession(profile, page ? "page" : "sidebar")?.create();
  }
  // Settings opened from a page lands on the section that page asked for.
  function openSettings() {
    handleNativeSection("settings.section.newtab");
    void browserPage.open("settings");
  }
  function openAccount(intent: "account" | "credits") {
    askSettings(intent === "credits" ? "credits" : null);
    handleNativeSection("settings.section.account");
    void browserPage.open("settings");
  }
  function openAbout() {
    handleNativeSection("settings.section.about");
    void browserPage.open("settings");
  }
  // Astra's own menu stands wherever the engine would offer a browser menu.
  // The page's menu arrives from the shell (see `installShellMenu`), so both
  // are drawn by the app and neither is a Firefox menu. Anything in the app
  // that does not own a menu of its own — the sidebar's empty space, the new
  // tab, settings, lists — gets this one; a tab, a kept site or a folder has
  // already handled the event (and marked it), so it is not overridden.
  onMount(() => {
    const stopShellMenu = installShellMenu();
    const stopTabMenu = installTabMenuPresenter();
    const stopChromeMenu = installChromeMenu((event) => {
      if (!(event.target instanceof Element)) return;
      openChromeContextMenu(event);
    });
    return () => {
      stopChromeMenu();
      stopTabMenu();
      stopShellMenu();
    };
  });

  /** The browser's own menu: no page to act on, only the window and the app. */
  function openChromeContextMenu(event: MouseEvent) {
    const active = tabs.activeTab();
    const page =
      browserPage.currentPage() === null &&
      (active?.content ?? "web") === "web" &&
      (active?.url ?? null) !== null;
    const items = [
      { kind: "item" as const, id: "tab.new", label: "New Tab", hint: "Ctrl+T" },
      { kind: "item" as const, id: "window.new", label: "New Window", hint: "Ctrl+N" },
      {
        kind: "item" as const,
        id: "window.newPrivate",
        label: "New Private Window",
        hint: "Ctrl+Shift+P",
      },
      { kind: "separator" as const },
      ...(page
        ? [
            { kind: "item" as const, id: "page.reload", label: "Reload Page", hint: "Ctrl+R" },
            {
              kind: "item" as const,
              id: "bookmark.current",
              label: "Bookmark This Page",
              hint: "Ctrl+D",
            },
            { kind: "item" as const, id: "page.viewSource", label: "View Page Source" },
            { kind: "separator" as const },
          ]
        : []),
      { kind: "item" as const, id: "history.open", label: "History" },
      { kind: "item" as const, id: "bookmarks.open", label: "Bookmarks" },
      { kind: "item" as const, id: "settings.open", label: "Settings" },
    ];
    openAt({ x: event.clientX, y: event.clientY, items }, (id) => {
      if (id === "tab.new") {
        tabs.open();
        return;
      }
      if (id === "page.reload") {
        tabs.reloadActive();
        return;
      }
      if (id === "page.viewSource") {
        void browserPage.open("source");
        return;
      }
      if (id === "history.open") {
        void browserPage.open("history");
        return;
      }
      if (id === "bookmarks.open") {
        toolHost.open("bookmarks");
        return;
      }
      if (id === "settings.open") {
        void browserPage.open("settings");
        return;
      }
      // Window and bookmark actions belong to the chrome window; it owns the
      // real window and the Places store.
      try {
        window.parent.postMessage({ ns: "astra-shell", kind: "menu-run", id }, "*");
      } catch {
        // No shell: the row has nowhere to run.
      }
    });
  }
  onMount(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void events.uiCommand
      .listen((event) => {
        if (event.payload === "note.new") void newNote();
        else handleNativeSection(event.payload);
      })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else stop = unsubscribe;
      });
    // A note chosen in the launcher opens where notes already are: the page
    // if it is showing, the sidebar otherwise.
    const noteListener = events.noteOpenRequested.listen(({ payload: { profile, id } }) => {
      if (profile !== tabs.profile()?.id) return;
      const page = browserPage.currentPage() === "notes";
      if (!page) toolHost.open("notes");
      void import("$domain/notes").then(async ({ noteSession }) => {
        if (disposed || tabs.profile()?.id !== profile) return;
        await noteSession(profile, page ? "page" : "sidebar")?.requestOpen(id);
      });
    });
    return () => {
      disposed = true;
      stop?.();
      void noteListener.then((stop) => stop());
    };
  });
  let splitting = $state(false);
  let inWork = $derived(browserPage.currentPage() === "work");
  // Settings stands beside the rail the way a tool panel does.
  let paneled = $derived(
    toolHost.activeTool() !== null || browserPage.currentPage() === "settings",
  );
  let incognito = $derived(tabs.profile()?.kind === "incognito");
  // The column's body settles in only when the environment changes, never on launch.
  let modeSwitched = $state(false);
  let shownMode: boolean | null = null;
  $effect(() => {
    const next = inWork;
    untrack(() => {
      if (shownMode !== null && shownMode !== next) modeSwitched = true;
      shownMode = next;
    });
  });

  // Kept sites fill the row beside the tool shelf first; the rest stack in
  // rows of even columns above it. The floor is the narrowest a tile may get
  // before a row gives one up; the lead is the shelf, its rule and their gaps
  // (--dock-tile, --dock-shelf-gap), which the row beside it does not have.
  const TILE_FLOOR = 48;
  const TILE_GAP = 6;
  const SHELF_LEAD = 65;
  let sitesWidth = $state(0);
  // Until the row has been measured, the column's own width stands in for
  // it, so the first frame is already split the way the measured one will be.
  let besideRoom = $derived(sitesWidth || Math.max(0, sidebarWidth() - SHELF_LEAD));
  let beside = $derived(Math.max(1, Math.floor((besideRoom + TILE_GAP) / (TILE_FLOOR + TILE_GAP))));
  let dockColumns = $derived(
    Math.max(1, Math.floor((besideRoom + SHELF_LEAD + TILE_GAP) / (TILE_FLOOR + TILE_GAP))),
  );

  // The current tab's plate travels to the next current tab. Measured before
  // the change lands and played after it, across every list in the column.
  // Another space's list is a different sheet, so a plate never crosses to it:
  // the new space simply shows its own current tab.
  let shownActive: string | null = null;
  let shownSpace: string | null = null;
  let glideFrom: ReturnType<typeof selectionGlide.capture> = null;
  $effect.pre(() => {
    const next = tabs.activeId();
    const space = tabs.activeSpaceId();
    untrack(() => {
      if (next === shownActive) return;
      const origin = selectionGlide.capture(shownActive);
      glideFrom = space === shownSpace ? origin : null;
    });
  });
  $effect(() => {
    const next = tabs.activeId();
    const space = tabs.activeSpaceId();
    untrack(() => {
      if (next === shownActive) {
        shownSpace = space;
        return;
      }
      selectionGlide.play(glideFrom, next);
      glideFrom = null;
      shownActive = next;
      shownSpace = space;
    });
  });
  let tree = $derived(sidebarTree(tabs.sidebarNodes(), tabs.tabs()));
  let keptBeside = $derived(tree.favorites.slice(0, beside));
  let keptAbove = $derived(tree.favorites.slice(beside));
  // The rail shows one flat list. Folders and split grouping are shapes that
  // need labels, so they stay in the expanded body.
  let railTabs = $derived(
    tabs.tabs().filter((tab) => !railEssentials.some((essential) => essential.id === tab.id)),
  );
  let railEssentials = $derived(
    tree.favorites.flatMap((entry) => (entry.kind === "tab" ? [entry.tab] : [])),
  );
  let railClosable = $derived(
    new Set(tree.today.flatMap((entry) => (entry.kind === "tab" ? [entry.tab.id] : []))),
  );

  function linkCopied(copied: boolean) {
    if (copied) notices.show(m.notice_link_copied());
  }

  // The field's tray opens over the page, and the app frame sits under the
  // page surface. While the tray is open, raise the frame the way a context
  // menu does and let its ground step aside, so the panel is visible and the
  // page still shows around it. The shell owns the stacking; this only asks.
  let trayRaised = false;
  function raiseForTray(open: boolean) {
    trayRaised = open;
    try {
      if (open) document.documentElement.dataset.astraRaised = "true";
      else
        requestAnimationFrame(() => {
          // Lowered first, then the ground comes back: the shell needs one
          // turn to put the frame under the page again.
          if (!trayRaised) delete document.documentElement.dataset.astraRaised;
        });
    } catch {
      // No document marker outside the chrome.
    }
    try {
      window.parent.postMessage(
        { ns: "astra-shell", kind: open ? "menu-open" : "menu-close" },
        "*",
      );
    } catch {
      // No shell: the panel is drawn in this document.
    }
  }
  $effect(() => () => {
    if (!trayRaised) return;
    trayRaised = false;
    try {
      delete document.documentElement.dataset.astraRaised;
    } catch {
      // The document is already gone with the window.
    }
  });

  // Loaded when a command first asks to clear a site's data, then kept: the
  // dialog closes itself, and a native modal must never be removed while open.
  let ClearSiteData = $state.raw<Component | null>(null);
  $effect(() => {
    if (clearRequest.pending() && !untrack(() => ClearSiteData))
      void loadClearSiteData().then((module) => (ClearSiteData = module.default));
  });

  let handledCommand = 0;
  $effect(() => {
    const command = ui.uiCommand();
    if (command.seq === 0 || command.seq === handledCommand) return;
    handledCommand = command.seq;
    untrack(() => {
      if (command.id === "split.choose") splitting = true;
      if (command.id === "page.copyLink") void tabs.copyActiveLink().then(linkCopied);
      if (command.id === "page.clearSiteData") clearRequest.ask(tabs.activeTab()?.url);
      if (command.id === "find.show") findInPage.show(tabs.activeId());
      if (command.id === "find.next") findInPage.step(true, tabs.activeId());
      if (command.id === "find.previous") findInPage.step(false, tabs.activeId());
      if (command.id.startsWith("bookmark.added=")) {
        bookmarkReveal.request(command.id.slice("bookmark.added=".length));
        toolHost.open("bookmarks");
      }
      if (command.id === "extensions.manage") void browserPage.open("extensions");
      if (command.id === "protection.site") void toggleSiteProtection();
      if (command.id === "protection.hide") void hideElements();
      if (command.id.startsWith("focus.shut="))
        notices.show(
          m.focus_shut_notice({ site: command.id.slice("focus.shut=".length) }),
          "focus",
        );
      if (command.id === "focus.alert=finished") notices.show(m.focus_done_title(), "focus");
      if (command.id === "focus.alert=break") notices.show(m.focus_break_title(), "focus");
      if (command.id === "focus.alert=focus") notices.show(m.focus_back_title(), "focus");
    });
  });
  // A load started from the new tab keeps it on screen until the page
  // commits, so the content pane never empties between the two.
  let newTabLoad = $state<string | null>(null);
  let newTabShown = $derived.by(() => {
    const tab = tabs.activeTab();
    if (!tab || tab.url || (tab.content ?? "web") !== "web") return false;
    return browserPage.currentPage() === null && (!tab.loading || newTabLoad === tab.id);
  });
  // Beside a new tab the window, whatever it is made of, takes on the
  // sky's light; it gives it back as a page arrives.
  let skyShown = $derived(newTabShown && newTabImage() === null);
  // The card a page stands on. A native page cannot paint its own drop, and
  // the internal stages paint only their ground, so the column draws the card
  // behind them. The new tab and the failure pane draw a pane of their own and
  // keep its shadow; a card under them would double the edge.
  let stageCard = $derived.by(() => {
    const tab = tabs.activeTab();
    if (focus.cover() !== null && browserPage.currentPage() === null) return true;
    if (tab && failedPane(tab) && browserPage.currentPage() === null) return false;
    if (newTabShown) return false;
    if (
      tab?.availability?.state === "waiting_for_capacity" ||
      tab?.availability?.state === "blocked_by_capacity"
    )
      return browserPage.currentPage() === null;
    return browserPage.currentPage() !== null || (tab?.url ?? null) !== null;
  });

  $effect(() => {
    const tab = tabs.activeTab();
    const idle = !!tab && !tab.url && !tab.loading && (tab.content ?? "web") === "web";
    untrack(() => {
      if (idle) newTabLoad = tab.id;
      else if (!tab || tab.url || tab.id !== newTabLoad) newTabLoad = null;
    });
  });
  // A tab with nothing to show (a first load that failed, a restored page
  // that did not load, a crash it could not recover from, a page the engine
  // replaced with an empty error document) says why in its pane.
  function failedPane(tab: TabView): boolean {
    if (!tab.failure) return false;
    if (tab.failure.covers_page) return true;
    return !tab.loading && (!tab.url || tab.availability?.state === "sleeping");
  }
  // A load that failed over a page still showing leaves that page in place;
  // a notice says the new address did not open.
  let failureNoticed: string | null = null;
  $effect(() => {
    const tab = tabs.activeTab();
    const failure = tab?.failure;
    const key =
      failure && tab.url && !failedPane(tab) ? `${tab.id} ${failure.url} ${failure.reason}` : null;
    untrack(() => {
      if (key === null || key === failureNoticed) return;
      failureNoticed = key;
      let host = failure?.url ?? "";
      try {
        host = new URL(host).host || host;
      } catch {
        // The address is shown as given.
      }
      notices.show(m.navigation_error_notice({ host }));
    });
  });
  // A search belongs to the page it runs in; moving to another page ends it.
  $effect(() => {
    const active = tabs.activeId();
    untrack(() => {
      if (findInPage.isOpen() && findInPage.searching() !== active) findInPage.hide();
    });
  });
  function selectTab(id: string) {
    if (splitting) {
      tabs.split(id);
      splitting = false;
      return;
    }
    // In Work a tab opens over the canvas; the work stays where it is.
    if (inWork) requestTab(id);
    else tabs.activate(id);
  }

  /** The edge strip asks for the card; the column's own listener answers. */
  function dispatchSidebarEdge(near: boolean) {
    window.dispatchEvent(new CustomEvent("astra:sidebar-edge", { detail: { near } }));
  }
</script>

<!-- The player of a tab playing behind the page in front; its code loads the
     first time there is one. -->
{#snippet player(
  compact: boolean,
)}{#if mediaPlayer.view()}{#await loadMediaPlayer() then { default: MediaPlayer }}<MediaPlayer
        {compact}
      />{/await}{/if}{/snippet}

<!-- The chrome view starts at the window's corner in every shape and draws
     the gutter itself, which stays a place to drag the window by. -->
<div
  class="shell flex h-screen w-screen p-2"
  data-tauri-drag-region
  class:pb-0={inWork}
  data-caption={IS_WINDOWS || undefined}
  data-astra-active-tab={tabs.activeId() ?? ""}
  data-astra-surface={browserPage.currentPage() ?? "browse"}
  data-private={incognito || undefined}
>
  <a href="#astra-stage" class="skip-link">{m.ui_skip_to_content()}</a>
  <!--
    The window's left edge while the column is away. It lives here, beside the
    column, because a fixed child of the card would be positioned by the card's
    own transform and travel off screen with it. Reaching it asks the card out;
    leaving lets it go. Nothing is laid out again: the card is out of the row
    while hidden, so the page never moves.
  -->
  {#if sidebarHidden()}
    <div
      class="sidebar-edge"
      role="presentation"
      aria-hidden="true"
      onpointerenter={() => dispatchSidebarEdge(true)}
      onpointerover={() => dispatchSidebarEdge(true)}
      onpointerleave={() => dispatchSidebarEdge(false)}
      onpointerout={() => dispatchSidebarEdge(false)}
    ></div>
  {/if}
  {#if !newTabImage()}<SkyLight shown={skyShown} />{/if}
  <Sidebar
    >{#snippet browserBody(compact)}
      {#if compact && (inWork || paneled)}
        {#if !inWork}<StoreInstallRail />{/if}
        {#if paneled && IS_WINDOWS}
          {#if browserPage.currentPage() === "settings"}<ModeTabs compact standalone />{/if}
          <div class="rail-search"><SidebarSearch /></div>
        {:else if paneled}<ModeTabs compact standalone />{/if}
      {:else if compact}<StoreInstallRail />
      {:else if !incognito && preferences.enabled("work")}<div class="sidebar-head">
          <ModeTabs />
        </div>{/if}
      <!-- One column in both environments: only what it lists changes, and the
           new list settles in where the old one was. -->
      {#key inWork}<div class="sidebar-mode-body" data-arriving={modeSwitched}>
          {#if compact}
            <TabRail entries={railTabs} closable={railClosable} onSelect={selectTab} />
          {:else}
            <!--
            The address field belongs to the main page now, in the bar above
            the stage; the column starts at the list. Work floats its page
            over the whole window, sidebar included.
          -->
            {#if !inWork}<SidebarPagePermission />{/if}

            <HidingBar />
            {#if splitting}<p class="shrink-0 px-3 pb-1 text-[12px] text-accent" aria-live="polite">
                {m.choose_split()}
              </p>{/if}
            <SidebarBody pinned={tree.pinned} today={tree.today} {splitting} onSelect={selectTab}>
              {#snippet extras()}<PinnedExtensions />{/snippet}
            </SidebarBody>
            <!-- Brief notices and downloads sit at the foot of the column, by the dock. -->
            <SidebarNotice />
            {#if tabs.profile()?.id}<DownloadStatus
                profile={tabs.profile()!.id}
                onopen={() => toolHost.open("downloads")}
              />{/if}
            <UpdateNotice view="cards" />
            <PrivateReturn />
            {@render player(false)}
          {/if}
        </div>{/key}
    {/snippet}{#snippet dock(
      compact,
    )}{#snippet accountFoot()}{#await loadAccountButton() then { default: AccountButton }}<AccountButton
            name={tabs.profile()?.name ?? ""}
          />{/await}{/snippet}{#if compact && incognito}{@render player(true)}<PrivateBar
          compact
        />{:else if compact}{@render player(true)}{#if tabs.profile()?.id && !inWork}<DownloadPulse
            profile={tabs.profile()?.id ?? ""}
          />{/if}<PrivateReturn compact /><UpdateNotice view="glyph" onabout={openAbout} /><Dock
          compact
          tools={!inWork}
          foot={inWork ? accountFoot : undefined}
        >
          {#snippet sites()}<EssentialsRail
              entries={railEssentials}
              onSelect={selectTab}
            />{/snippet}
        </Dock>{:else if incognito}
        <!-- A private window keeps nothing, so it has no tools or kept sites;
             its foot names the scope and closes it. -->
        <PrivateBar />{:else}<Dock>
          {#snippet above()}
            <div
              class="dock-sites"
              data-essentials-drop
              data-over={tabDrag.overEssentials()}
              hidden={keptAbove.length === 0}
            >
              <TabList
                entries={keptAbove}
                section="favorites"
                variant="essentials"
                columns={dockColumns}
                label={m.essentials()}
                {splitting}
                onSelect={selectTab}
                >{#snippet essentialTile(props)}<EssentialTile {...props} />{/snippet}</TabList
              >
            </div>
          {/snippet}
          {#snippet sites()}
            <div
              class="dock-sites"
              bind:clientWidth={sitesWidth}
              data-essentials-drop
              data-over={tabDrag.overEssentials()}
              data-empty={tree.favorites.length === 0}
            >
              {#if tree.favorites.length === 0}<span class="dock-sites-hint"
                  >{m.essential_drop_hint()}</span
                >{/if}
              <TabList
                entries={keptBeside}
                section="favorites"
                variant="essentials"
                label={m.essentials()}
                {splitting}
                onSelect={selectTab}
                >{#snippet essentialTile(props)}<EssentialTile {...props} />{/snippet}</TabList
              >
            </div>
            {#if tabDrag.moveFailed()}<p class="sidebar-move-error" role="alert">
                {m.essential_move_failed()}
              </p>{/if}
          {/snippet}
        </Dock>{/if}{/snippet}{#snippet settingsNavigation()}{#await importSettingsNavigation() then { default: Navigation }}<Navigation
        />{/await}{/snippet}{#snippet toolPanel(kind)}<LazyView
        loader={loadToolSlot}
        loadingLabel={m.surface_loading()}
        failureLabel={m.surface_render_failed()}
        retryLabel={m.surface_retry()}
        >{#snippet children(View)}<View
            tool={kind}
            profile={tabs.profile()?.id ?? "unbound"}
            onclose={toolHost.close}
          />{/snippet}</LazyView
      >{/snippet}</Sidebar
  >
  <div class="stage-column">
    <!-- The page's own bar: navigation and the one address field, above the
         stage and never in the sidebar. The field is composed here, with the
         tray that acts on the page it names, and the bar only places it. -->
    <ContentBar>
      {#snippet field()}
        <AddressField>
          {#snippet trailing(page)}
            <UtilityTray
              label={page === null
                ? m.utilities()
                : page.warning
                  ? m.site_info_label_status({ status: page.warning })
                  : m.site_info_label()}
              warning={page?.warning}
              onopen={() => raiseForTray(true)}
              onclose={() => raiseForTray(false)}
            >
              {#snippet children(open)}
                {#snippet siteHead(name: string | null, control?: Snippet)}
                  <SiteHead {page} label={name}>{@render control?.()}</SiteHead>
                {/snippet}
                <BlockerShield {open} head={page ? siteHead : undefined} />
                <ExtensionsSection />
                <SiteDetails {page} {open} />
              {/snippet}
            </UtilityTray>
          {/snippet}
        </AddressField>
      {/snippet}
    </ContentBar>
    {#if stageCard}<div class="stage-card" aria-hidden="true"></div>{/if}
    {#if browserPage.navigationFailed()}<div class="navigation-error" role="alert">
        {m.browser_nav_failed()}
      </div>{/if}
    {#if focus.cover() !== null && browserPage.currentPage() === null}
      <!-- Focus shuts the site this tab shows; native has taken the page off
         the stage, so this stands where it was. -->
      <main class="internal-stage" id="astra-stage" tabindex="-1">
        <div class="stage-page">
          <LazyView
            loader={loadFocusCover}
            loadingLabel={m.surface_loading()}
            failureLabel={m.surface_render_failed()}
            retryLabel={m.surface_retry()}
            >{#snippet children(View)}<View site={focus.cover() ?? ""} />{/snippet}</LazyView
          >
        </div>
      </main>
    {:else if (tabs.activeTab()?.availability?.state === "waiting_for_capacity" || tabs.activeTab()?.availability?.state === "blocked_by_capacity") && browserPage.currentPage() === null}
      {@const capacityTab = tabs.activeTab()}
      <main class="internal-stage" id="astra-stage" tabindex="-1">
        {#if capacityTab}<LazyView
            loader={loadTabCapacityState}
            loadingLabel={m.surface_loading()}
            failureLabel={m.surface_render_failed()}
            retryLabel={m.surface_retry()}
            >{#snippet children(View)}<View tab={capacityTab} />{/snippet}</LazyView
          >{/if}
      </main>
    {:else if tabs.activeTab() && failedPane(tabs.activeTab()!) && browserPage.currentPage() === null}
      {@const failedTab = tabs.activeTab()}
      {@const failure = failedTab?.failure}
      <!-- A page that could not be shown: the pane says why instead of staying blank. -->
      <main class="min-w-0 flex-1 ps-2" id="astra-stage" tabindex="-1">
        <div class="content-pane h-full w-full overflow-hidden">
          {#if failedTab && failure}<LazyView
              loader={loadNavigationError}
              loadingLabel={m.surface_loading()}
              failureLabel={m.surface_render_failed()}
              retryLabel={m.surface_retry()}
              >{#snippet children(View)}<View tab={failedTab} {failure} />{/snippet}</LazyView
            >{/if}
        </div>
      </main>
    {:else if newTabShown}
      <!--
      A tab opened straight to an address is loading before it has a URL; it
      goes to its page rather than flashing the new tab first.
      Occupies exactly the rect a content WebView would, so moving between a
      page and the new tab never changes the window's shape. The inline start
      inset matches the core layout gap between chrome and content.
    -->
      <main class="min-w-0 flex-1 ps-2" data-astra-new-tab id="astra-stage" tabindex="-1">
        <!-- New Tab paints its own ground, so its dock can open onto the frame. -->
        <div class="content-pane h-full w-full overflow-hidden" data-ground="own">
          <LazyView
            loader={loadNewTab}
            loadingLabel={m.surface_loading()}
            failureLabel={m.surface_render_failed()}
            retryLabel={m.surface_retry()}
            >{#snippet children(NewTab)}<NewTab
                oncustomize={openSettings}
                onaccount={openAccount}
                ontasks={() => void browserPage.open("tasks")}
                ontime={() => void browserPage.open("time")}
                >{#snippet search()}{#key tabs.activeId()}<LazyView
                      loader={loadNewTabSearch}
                      loadingLabel={m.surface_loading()}
                      failureLabel={m.surface_render_failed()}
                      retryLabel={m.surface_retry()}
                      >{#snippet children(Search)}<Search
                          tabId={tabs.activeId()}
                        />{/snippet}</LazyView
                    >{/key}{/snippet}</NewTab
              >{/snippet}</LazyView
          >
        </div>
      </main>
    {/if}
    {#if browserPage.currentPage() !== null}
      <main class="internal-stage" id="astra-stage" tabindex="-1">
        <!-- Each destination arrives as its own page: the ground settles in
           while its content rises onto it. -->
        {#key browserPage.currentPage()}<div
            class="stage-page"
            data-page={browserPage.currentPage()}
          >
            <RenderBoundary title={m.surface_render_failed()} retryLabel={m.surface_retry()}>
              {#if browserPage.currentPage() === "settings"}
                <LazyView
                  loader={loadSettings}
                  loadingLabel={m.surface_loading()}
                  failureLabel={m.surface_render_failed()}
                  retryLabel={m.surface_retry()}
                  >{#snippet children(View)}<View />{/snippet}</LazyView
                >
              {:else if browserPage.currentPage() === "extensions"}
                <LazyView
                  loader={loadWebExtensionManager}
                  loadingLabel={m.surface_loading()}
                  failureLabel={m.surface_render_failed()}
                  retryLabel={m.surface_retry()}
                  >{#snippet children(View)}<View />{/snippet}</LazyView
                >
              {:else if browserPage.currentPage() === "work"}
                {#key tabs.profile()?.id}<LazyView
                    loader={loadWorkWorkspace}
                    loadingLabel={m.surface_loading()}
                    failureLabel={m.surface_render_failed()}
                    retryLabel={m.surface_retry()}
                    >{#snippet children(View)}<View />{/snippet}</LazyView
                  >{/key}
              {:else if browserPage.currentPage() === "notes"}
                {#key tabs.profile()?.id}<LazyView
                    loader={loadNotesPage}
                    loadingLabel={m.surface_loading()}
                    failureLabel={m.surface_render_failed()}
                    retryLabel={m.surface_retry()}
                    >{#snippet children(View)}<View
                        profile={tabs.profile()?.id ?? ""}
                        onclose={() => void browserPage.close()}
                      />{/snippet}</LazyView
                  >{/key}
              {:else if browserPage.currentPage() === "tasks"}
                <LazyView
                  loader={loadTasksPage}
                  loadingLabel={m.surface_loading()}
                  failureLabel={m.surface_render_failed()}
                  retryLabel={m.surface_retry()}
                  >{#snippet children(View)}<View />{/snippet}</LazyView
                >
              {:else if browserPage.currentPage() === "time"}
                {#key tabs.profile()?.id}<LazyView
                    loader={loadTimePage}
                    loadingLabel={m.surface_loading()}
                    failureLabel={m.surface_render_failed()}
                    retryLabel={m.surface_retry()}
                    >{#snippet children(View)}<View />{/snippet}</LazyView
                  >{/key}
              {:else if browserPage.currentPage() === "history"}
                <LazyView
                  loader={loadHistoryPage}
                  loadingLabel={m.surface_loading()}
                  failureLabel={m.surface_render_failed()}
                  retryLabel={m.surface_retry()}
                  >{#snippet children(View)}<View />{/snippet}</LazyView
                >
              {:else if browserPage.currentPage() === "source"}
                {#key tabs.activeId()}<LazyView
                    loader={loadSourcePage}
                    loadingLabel={m.surface_loading()}
                    failureLabel={m.surface_render_failed()}
                    retryLabel={m.surface_retry()}
                    >{#snippet children(View)}<View
                        tab={tabs.activeId() ?? ""}
                      />{/snippet}</LazyView
                  >{/key}
              {:else}
                <LazyView
                  loader={loadLibraryPage}
                  loadingLabel={m.surface_loading()}
                  failureLabel={m.surface_render_failed()}
                  retryLabel={m.surface_retry()}
                  >{#snippet children(View)}<View kind="downloads" />{/snippet}</LazyView
                >{/if}
            </RenderBoundary>
          </div>{/key}
      </main>
    {/if}
  </div>
</div>
{#if ClearSiteData}<ClearSiteData />{/if}
<ContextMenu />

<style>
  /* The reach: a strip at the window's left edge while the column is away.
     Out of the row, above the page and under the card, so asking for the card
     never lays anything out again. Wide enough to find, narrow enough that a
     page's own left edge is still usable. */
  .sidebar-edge {
    position: fixed;
    inset-block: 8px;
    inset-inline-start: 0;
    z-index: 29;
    inline-size: 10px;
    border-start-end-radius: var(--radius-capsule);
    border-end-end-radius: var(--radius-capsule);
    transition: background-color var(--motion-base) var(--ease-out);
  }

  .sidebar-edge:hover {
    background: var(--row-hover);
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar-edge {
      transition: none;
    }
  }

  /* Keyboard-only way past the chrome: hidden until it takes focus, then a
     chip over the column. Fixed so it never disturbs the shell's layout. */
  .skip-link {
    position: fixed;
    inset-inline-start: 12px;
    top: -48px;
    z-index: 100;
    padding: 8px 12px;
    border-radius: var(--radius-row);
    background: var(--color-raised);
    color: var(--color-text);
    font-size: var(--text-label);
    text-decoration: none;
    box-shadow: var(--shadow-overlay);
    transition: top var(--motion-fast) var(--ease-out);
  }

  .skip-link:focus-visible {
    top: 12px;
    outline: 2px solid var(--color-ring);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .skip-link {
      transition: none;
    }
  }

  @media (forced-colors: active) {
    .skip-link:focus-visible {
      outline-color: Highlight;
      border: 1px solid Highlight;
    }
  }

  .stage-column {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /* The card the page stands on. A native page is rounded by the shell but
     cannot paint its own drop, and an internal stage paints only its ground,
     so the column draws the card under both. It is transparent and takes no
     pointer: only the drop outside the page's own rectangle shows. */
  .stage-card {
    position: absolute;
    inset-block: var(--main-bar-height) 0;
    inset-inline: var(--main-bar-inset) 0;
    border-radius: var(--content-radius);
    box-shadow: var(--shadow-card);
    pointer-events: none;
  }

  .stage-column > :global(main) {
    flex: 1;
    min-height: 0;
  }

  .rail-search {
    display: flex;
    justify-content: center;
    margin-block: 8px 14px;
  }

  .sidebar-mode-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .sidebar-mode-body[data-arriving="true"] {
    /* Release the opacity backdrop root after entry so descendant menus can blur. */
    animation: mode-body-in var(--motion-slow) var(--ease-emphasized) backwards;
  }

  @keyframes mode-body-in {
    from {
      opacity: 0;
      translate: 0 6px;
    }
  }
</style>
