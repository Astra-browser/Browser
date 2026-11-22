<script lang="ts">
  import { installCloseService } from "$shared/lib/close";
  import "$styles/global.css";
  import { onMount, untrack } from "svelte";
  import {
    WebExtensionAccessPrompt,
    WebExtensionInstallPrompt,
    WebExtensionReview,
  } from "$features/webext";
  import { PeekLayer, peek } from "$features/peek";
  import { webext } from "$domain/webext";
  import { PagePermissionPrompt } from "$features/permissions";
  import { PageDialogPrompt, pageDialogs } from "$features/dialogs";
  import { PasskeyPrompt } from "$features/passkeys";
  import { passkeys } from "$domain/passkeys";
  import { updateNotices } from "$features/updates";
  import * as sidebar from "$session/sidebar-mode.svelte";
  import { commands } from "$shared/ipc/bindings";
  import { IS_MAC, IS_WINDOWS } from "$shared/platform";
  import { blocker } from "$domain/blocker";
  import { extensions } from "$domain/extensions";
  import { favicons } from "$domain/favicons";
  import { layout } from "$domain/layout";
  import { operations } from "$domain/operations";
  import { pagePermissions } from "$domain/permissions";
  import { runtime } from "$domain/runtime";
  import { mediaPlayer } from "$domain/media-player";
  import { updates } from "$domain/updates";
  import { focus } from "$domain/time";
  import { tabs } from "$domain/tabs";
  import { theme } from "$domain/appearance";
  import { uiCommands as ui } from "$domain/ui-commands";
  import { surface as browserPage } from "$domain/surface";
  import * as motion from "$session/motion.svelte";
  import * as notices from "$session/notice.svelte";
  import * as tools from "$session/tools.svelte";
  import { preferences } from "$domain/preferences";
  import { keymap } from "$domain/keymap";
  import { browserImport, nativeImportAdapter } from "$domain/browser-import";
  import { findInPage } from "$features/address";
  import { acceleratorFrom, sameAccelerator } from "$shared/lib/accelerator";
  import { applyLanguage } from "$shared/lib/locale.svelte";
  import { applySpaceTheme, spaceThemeValues } from "$features/tabs";
  import * as m from "$shared/i18n/messages";
  import Shell from "./Shell.svelte";
  import { LauncherOverlay } from "$features/launcher";
  import { WindowControlsOverlay } from "$shared/ui/WindowControls";

  // Follows the stored preference and nothing else. Adopting reads the
  // sidebar's own shape; tracked, that read made every toggle re-adopt the
  // not-yet-saved old value, bouncing the column back and forth and cutting
  // the page's slide short.
  $effect(() => {
    const mode = preferences.value("sidebar.mode");
    if (mode === "default" || mode === "compact" || mode === "hidden")
      untrack(() => sidebar.adoptMode(mode));
  });

  $effect(() => {
    theme.applyUiPreferences(
      preferences.value("ui.accent"),
      preferences.value("ui.reduce-motion") === "true",
    );
  });

  // A space with a theme of its own dresses the whole window while it is
  // active. Read as plain values, so a projection that changes nothing about
  // it does not apply the theme again.
  const worn = $derived(
    spaceThemeValues(tabs.activeSpace()?.theme ?? null, {
      theme: preferences.value("ui.theme"),
      custom: preferences.value("ui.theme-custom"),
    }),
  );
  const wornTheme = $derived(worn.theme);
  const wornCustom = $derived(worn.custom);
  $effect(() => {
    const next = {
      theme: wornTheme,
      custom: wornCustom,
      level: preferences.value("ui.theme-contrast"),
      contrast: preferences.value("ui.contrast") === "true",
      font: preferences.value("ui.font"),
      fontSize: preferences.value("ui.font-size"),
      codeFont: preferences.value("ui.code-font"),
    };
    const space = tabs.activeSpaceId();
    untrack(() =>
      applySpaceTheme(space, JSON.stringify(next), () => theme.applyCustomization(next)),
    );
  });

  $effect(() => void applyLanguage(preferences.value("ui.language")));

  $effect(() => {
    theme.applyLayout({
      density: preferences.value("ui.density") === "compact" ? "compact" : "comfortable",
      contrast: preferences.value("ui.contrast") === "true",
    });
  });

  // A prompt in the sidebar leaves the page and chrome usable; only the
  // sheet, shown without that column, holds the window.
  let pagePermissionSheet = $derived(
    pagePermissions.prompt()?.in_sidebar === false ? pagePermissions.prompt() : null,
  );
  let consentActive = $derived(
    pagePermissionSheet !== null ||
      webext.review() !== null ||
      webext.prompt() !== null ||
      webext.accessRequest() !== null,
  );

  // The launcher overlay. The shortcut, the address field's "search or enter
  // an address" and the sidebar's search button all ask for it through the one
  // command, so there is one surface and one key path.
  let launcherOpen = $state(false);
  // An address handed over by Ctrl+L (or the field's own edit-in-launcher
  // hand-off). The overlay takes it as its first query; empty opens blank.
  let launcherSeed = $state("");
  // Whether the core really holds the desktop hotkey. While it does, the
  // desktop delivers the press (and the host coalesces a second delivery);
  // when it does not — no core, or another app owns the chord — this window
  // must still answer its own shortcut.
  let launcherGlobal = $state(false);
  const launcherKey = () =>
    keymap.all().find((entry) => entry.id === "launcher.toggle")?.accelerator ?? null;
  let handledLauncher = 0;
  $effect(() => {
    const command = ui.uiCommand();
    if (command.seq === 0 || command.seq === handledLauncher) return;
    handledLauncher = command.seq;
    // Commands with no Astra surface still answer: the person pressed a key
    // and must see why nothing opened, not a dead window.
    if (command.id === "notice.print-unavailable") {
      notices.show(m.notice_print_unavailable(), "data");
      return;
    }
    if (command.id.startsWith("launcher.edit=")) {
      try {
        launcherSeed = decodeURIComponent(command.id.slice("launcher.edit=".length));
      } catch {
        launcherSeed = "";
      }
      launcherOpen = true;
      window.focus();
      return;
    }
    if (command.id !== "launcher.toggle") return;
    launcherSeed = "";
    launcherOpen = !launcherOpen;
    // A shortcut pressed while another app was in front has to bring this one
    // forward: the overlay is drawn here, not in a window of its own.
    if (launcherOpen) window.focus();
  });

  // Page keystrokes are matched natively (menu bar, engine key tables, the
  // GTK window handler); these are the same keys while chrome has focus,
  // read from the one resolved keymap.
  function handleKeydown(event: KeyboardEvent) {
    // The native content stage is suppressed while this browser-owned modal
    // is active. Keep chrome shortcuts from mutating tabs behind it as well.
    if (consentActive || event.defaultPrevented || event.isComposing) return;
    const pressed = acceleratorFrom(event, IS_MAC);
    if (pressed === null) return;
    // The launcher's shortcut reaches this window as a `launcher.toggle`
    // command while the core holds the desktop hotkey. When it does not (no
    // core, or the registration was refused), no command will arrive, so the
    // window matches the bound chord itself — one path at a time, never both.
    if (launcherOpen) return;
    const bound = launcherKey();
    const command =
      !launcherGlobal && bound !== null && sameAccelerator(bound, pressed, IS_MAC)
        ? "launcher.toggle"
        : keymap.commandFor(event, IS_MAC, pressed);
    if (command === null) return;
    event.preventDefault();
    void commands.runCommand(command);
  }

  onMount(installCloseService);
  // Register the launcher's shortcut with the desktop once per window: the
  // core owns the registration, and this is the first read that hands it over.
  // The answer says whether the desktop really holds it.
  onMount(() => {
    void commands
      .launcherTrigger()
      .then((state) => {
        launcherGlobal = state?.registered === true;
      })
      .catch(() => {
        launcherGlobal = false;
      });
  });
  onMount(() => void passkeys.start());
  // The startup read can land before the session has a profile, which lists
  // nothing; read again once the profile is known, and when it changes.
  let extensionProfile = $derived(tabs.profile()?.id);
  $effect(() => {
    if (extensionProfile) void webext.refresh();
  });
  // The listing in front shows the browser's own install button in the page.
  let frontTab = $derived(tabs.activeTab()?.id);
  let frontListing = $derived(
    webext.isAvailable() && browserPage.currentPage() === null
      ? extensions.chromeStoreListingId(tabs.activeTab()?.url ?? "")
      : null,
  );
  // Again as loading ends: a view replaced under the tab starts with none.
  let frontLoading = $derived(tabs.activeTab()?.loading ?? false);
  $effect(() => {
    void frontLoading;
    if (frontTab === undefined || frontListing === null) return;
    webext.showStoreButton(frontTab, frontListing, (state) =>
      state === "remove"
        ? m.webext_store_remove()
        : state === "adding"
          ? m.webext_store_adding()
          : m.webext_store_install(),
    );
  });
  onMount(() => {
    let disposed = false;

    // Each async initializer performs its synchronous setup before its first
    // await. In particular, tabs installs every scoped projection listener
    // before bootstrap can ask native code for a snapshot.
    const themeReady = theme.init();

    // Runtime status is emitted by the same actor-ordered bootstrap that
    // supplies tabs, so its listener must exist before tabs starts bootstrap.
    const toolsReady = tools.init();
    const browserPageReady = browserPage.init();
    const preferencesReady = preferences.init();
    const runtimeReady = runtime.init();
    // Native offers the player with the same bootstrap that supplies tabs.
    void mediaPlayer.init();
    void peek.init();
    void focus.init();
    void updates.init();
    void updateNotices.init();
    const extensionsReady = extensions.init();
    void webext.refresh();
    const stopAccess = webext.listenForAccess();
    const stopPrompt = webext.listenForPrompt();
    const stopStoreClicks = webext.listenForStoreClicks();
    const stopDrops = webext.listenForDrops(() => browserPage.currentPage() !== "work");
    const pagePermissionsReady = pagePermissions.init();
    const pageDialogsReady = pageDialogs.init();

    // Rasters are emitted immediately before the projection that references
    // them, so this listener must exist before tabs asks native to bootstrap.
    const faviconsReady = favicons.init();
    const tabsReady = tabs.init();
    const sidebarReady = sidebar.init();
    const uiEventsReady = ui.init();
    void keymap.init();
    // An embedder (a test) may have provided its own port already.
    const ownsImport = !browserImport.available();
    if (ownsImport) browserImport.provide(nativeImportAdapter());
    void operations.init();
    void blocker.init();
    if (!IS_MAC) void layout.init();
    document.addEventListener("keydown", handleKeydown);

    void (async () => {
      try {
        await Promise.all([
          toolsReady,
          browserPageReady,
          preferencesReady,
          themeReady,
          runtimeReady,
          extensionsReady,
          pagePermissionsReady,
          pageDialogsReady,
          faviconsReady,
          tabsReady,
          uiEventsReady,
          sidebarReady,
        ]);
        if (disposed) return;
        await applyLanguage(preferences.value("ui.language"));
        if (disposed) return;

        // A hidden native window can suspend animation frames indefinitely.
        // Resolve style/layout synchronously before admitting native reveal.
        void document.documentElement.getBoundingClientRect();
        void getComputedStyle(document.body).backgroundColor;
        if (!(await commands.uiReady())) {
          throw new Error("native startup gate rejected UI");
        }
        motion.reveal();
      } catch {
        // Native owns the fail-closed watchdog. Keep attacker-controlled page
        // data and native internals out of this static diagnostic.
        console.error("trusted UI initialization failed");
      }
    })();

    return () => {
      disposed = true;
      theme.dispose();
      browserPage.dispose();
      tools.dispose();
      motion.dispose();
      preferences.dispose();
      operations.dispose();
      blocker.dispose();
      runtime.dispose();
      mediaPlayer.dispose();
      peek.dispose();
      updates.dispose();
      updateNotices.dispose();
      focus.dispose();
      extensions.dispose();
      webext.dispose();
      pagePermissions.dispose();
      pageDialogs.dispose();
      void stopAccess.then((stop) => stop());
      void stopPrompt.then((stop) => stop());
      void stopStoreClicks.then((stop) => stop());
      void stopDrops.then((stop) => stop());
      favicons.dispose();
      tabs.dispose();
      ui.dispose();
      keymap.dispose();
      findInPage.dispose();
      if (ownsImport) browserImport.provide(null);
      if (!IS_MAC) layout.dispose();
      document.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

<div class="contents" inert={consentActive}>
  <Shell />
  <PeekLayer />
  {#if !IS_MAC && !IS_WINDOWS}
    <WindowControlsOverlay />
  {/if}
</div>
{#if launcherOpen}
  <LauncherOverlay initial={launcherSeed} onclose={() => (launcherOpen = false)} />
{/if}
{#if pageDialogs.prompt() !== null}
  {#key pageDialogs.prompt()!.request}
    <PageDialogPrompt />
  {/key}
{:else if webext.review() !== null}
  <WebExtensionReview review={webext.review()!} />
{:else if webext.prompt() !== null}
  <WebExtensionInstallPrompt prompt={webext.prompt()!} />
{:else if webext.accessRequest() !== null}
  {#key webext.accessRequest()!.request}
    <WebExtensionAccessPrompt request={webext.accessRequest()!} />
  {/key}
{:else if passkeys.prompt() !== null}
  <PasskeyPrompt />
{:else if pagePermissionSheet !== null}
  {#key `${pagePermissionSheet.profile_id}:${pagePermissionSheet.item_id}:${pagePermissionSheet.request_id}`}
    <PagePermissionPrompt prompt={pagePermissionSheet} />
  {/key}
{/if}
