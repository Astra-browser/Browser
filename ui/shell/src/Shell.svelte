<script>
  import { onDestroy, onMount } from "svelte";
  import Hello from "./Hello.svelte";
  import { loadHost, newRequestId } from "./host.js";
  import { mountUrlBar } from "./urlbar.js";
  import { createTitlebar, createSidebar, createToolbar } from "./frame/frame.js";
  import { mountTabStrip } from "./tabs/tab-strip.js";
  import { mountSplit } from "./split/split.js";
  import { mountAppFrame } from "./app-frame.js";
  import { installContentMenu, runChromeAction } from "./content-menu.js";
  import { createShellMenu } from "./menu.js";
  import { slotStateFor } from "./content/slot-state.js";
  import { stageRectOf, stageStateFor, stageStyle } from "./content/stage-rect.js";
  import "./urlbar.css";
  import "./frame/frame.css";
  import "./tabs/tab-strip.css";
  import "./split/split.css";

  // P3-T13 shell assembly: frame builders (P3-T03), tab strip (P3-T04) and
  // split renderer (P3-T06) mounted into one frame layout (docs/astra/
  // ASSEMBLY.md). Everything interactive is built with imperative XHTML DOM
  // (chrome XUL sanitizer strips Svelte-compiled <button>/<input>), and the
  // P1-T08 hello (kept rendered) + P1-T10 URL bar / content slot keep working.
  let frameRoot;
  let titleMount;
  let toolMount;
  let sideMount;
  let tabsMount;
  let barMount;
  let splitMount;
  let slot;
  let slotError = $state("");
  /** Host of the page still arriving, so the stage says what it is waiting
   *  for instead of showing an unexplained dark rectangle. */
  let loadingHost = $state("");
  // P3-T15 full-app shell: the packaged app mounts into appMount (remote
  // content browser + host relay). The interim mounts stay wired as the
  // fallback: hidden once the app boots in host mode (P3-T16), shown with
  // appError/slotError whenever the app is unavailable. The interim content
  // slot is NEVER hidden — it is the only web-page surface (the app drives
  // it through Host navigation events); the titlebar stays for window
  // controls and dragging.
  let appMount;
  let appError = $state("");
  // True once the packaged app announces host-ready. The interim chrome
  // (titlebar/toolbar/sidebar/urlbar/split/content) is the fallback shell:
  // it stays mounted and wired, but hides while the app owns the window so
  // the user sees one product UI, not two nested chromes. Any app failure
  // flips this back and surfaces appError beside the interim chrome.
  // null while the app is still booting: the window paints the app's own
  // ground colour instead of a throwaway skeleton, so the first thing the
  // person sees is the product UI, never the fallback chrome (P3-T21).
  let appBooted = $state(null);
  let appApi = null;
  // The page covers the app frame, so the top-edge strip belongs to the shell
  // while the bar is away. It forwards hover to the app, which owns the bar's
  // own reveal delay.
  let barHoverPosted = false;
  function postBarHover(hover) {
    if (barHoverPosted === hover) return;
    barHoverPosted = hover;
    try {
      appApi?.element?.contentWindow?.postMessage(
        { ns: "astra-shell", kind: "bar-hover", hover },
        "*",
      );
    } catch {
      // The app frame is gone with the window.
    }
  }
  /** The tab the stage shows, as the last projection named it. */
  let activeTabId = "";
  /** The tab and address the stage has already put in front (a real document
   *  commit, not the model's optimistic one). The cover (skeleton + spinner)
   *  ends here, not at the end of the load: the document is painting while its
   *  subresources may still be arriving. */
  let committedTabId = "";
  let committedUrl = "";

  const SIDEBAR_ITEMS = [
    { id: "tabs", label: "Tabs" },
    { id: "notes", label: "Notes" },
  ];
  const TOOLBAR_ACTIONS = [
    { id: "new-tab", label: "+" },
    { id: "split", label: "◫" },
    { id: "toggle-fullscreen", label: "⛶" },
  ];
  const TOOLBAR_LABELS = {
    "new-tab": "New tab",
    "split": "Split pane",
    "toggle-fullscreen": "Toggle fullscreen",
  };

  /** Commands the chrome window performs itself (real windows, DevTools, the
   *  page's save/print dialogs). The app's keyboard path emits them. */
  const SHELL_COMMANDS = new Set([
    "bookmark.add",
    "page.copy",
    "page.devtools",
    "page.devtools.alt",
    "page.print",
    "page.save",
    "page.selectAll",
    "page.viewSource",
    "window.closePrivate",
    "window.new",
    "window.newPrivate",
    "window.showPrivate",
    "window.showRegular",
    "window.togglePrivate",
    "window.fullscreen",
  ]);

  /** What the stage names while a page is on its way. */
  function labelFor(url) {
    if (typeof url !== "string" || url === "" || url === "about:blank") return "Loading…";
    try {
      return `Loading ${new URL(url).host}…`;
    } catch {
      return "Loading…";
    }
  }

  let teardown = null;
  onDestroy(() => {
    try {
      teardown?.();
    } catch {
      // Already torn down with the window.
    }
  });

  onMount(async () => {
    const host = await loadHost();
    if (!host) {
      slotError = "Host API unavailable outside the browser window";
      // Same pattern for the app region: without the Host API the packaged
      // app cannot boot in host mode, so the interim chrome stays visible.
      appError = "Host API unavailable outside the browser window";
      return;
    }
    // One startup owner for the Rust core. The command comes from
    // `astra.core.command` (dev/packaged path); empty is an honest
    // `unavailable` and never starts a fake process. The core is optional:
    // the browser works without it while the Rust backend is pending.
    try {
      const services = frameRoot?.ownerDocument?.defaultView?.Services;
      const chromeWin = frameRoot?.ownerDocument?.defaultView ?? null;
      const ifile = chromeWin?.Ci?.nsIFile ?? (typeof Ci !== "undefined" ? Ci.nsIFile : null);
      let command = services?.prefs?.getStringPref("astra.core.command", "") ?? "";
      // Empty means "look beside the browser binary": a packaged build ships
      // `astra-core` in dist/bin, and a dev build can install it the same way.
      if (command === "" && services && ifile) {
        try {
          const beside = services.dirsvc.get("GreD", ifile).clone();
          beside.append("astra-core");
          if (beside.exists()) command = beside.path;
        } catch {
          command = "";
        }
      }
      // The organisation store lives beside the profile, never in a shared
      // location: a database is per profile, like cookies and history.
      let database = services?.prefs?.getStringPref("astra.core.database", "") ?? "";
      if (command !== "" && database === "") {
        try {
          const file = ifile ? services.dirsvc.get("ProfD", ifile) : null;
          database = file?.path ? `${file.path}/astra/core.sqlite` : "";
        } catch {
          database = "";
        }
      }
      // P5b: the sidecar must be up before the organisation snapshot is read.
      // A missing binary is an honest unavailable; the browser still boots.
      if (command !== "" && database !== "") {
        await host.Boot.launchCore({
          request_id: "shell-boot",
          command,
          arguments: ["--db", database],
        });
      }
    } catch {
      // No Services in a preview DOM.
    }
    // One Host API instance per window. `resource://` ES modules are per
    // document, so an import inside the app frame would give it a second tab
    // model while this window owns the content browser: a navigation would
    // commit into a model nothing listens to and the stage would stay blank.
    // `Services` is the per-process singleton both chrome documents share, so
    // the instance travels there rather than through a cross-compartment
    // expando.
    try {
      const chromeWindow = frameRoot?.ownerDocument?.defaultView ?? null;
      const services = chromeWindow?.Services;
      if (services) {
        services.astraHost = host;
        // The process-wide slot alone would let a late frame bind to another
        // window's model. Keep the exact window's instance too.
        let hosts = services.astraHosts;
        if (typeof hosts?.get !== "function") {
          hosts = new WeakMap();
          services.astraHosts = hosts;
        }
        if (chromeWindow) hosts.set(chromeWindow, host);
      }
    } catch {
      // No Services in a preview DOM: the app falls back to its own import.
    }
    const doc = frameRoot.ownerDocument;
    const win = doc.defaultView ?? null;
    // Bind this exact chrome window to win-1 before any Host API call. A
    // lazy Services/getMostRecentWindow can otherwise bind win-1 to a newly
    // opened window and make fullscreen/close hit the wrong one.
    let ownWindowId = "win-1";
    try {
      ownWindowId = host.__bindCurrentWindow?.(win) || "win-1";
    } catch {
      // Preview DOM without a chrome window.
    }

    // P6b: replace the engine's own prompt for the page permissions the app
    // renders. The integration is process-wide; this window joins the routing
    // registry. Safe to retry from another window.
    try {
      await host.Permissions?.install?.({ window: win });
    } catch {
      // Without the integration the engine keeps its own prompt; nothing is
      // silently granted because of this failure.
    }
    // P6c: HTTP auth becomes the app's sign-in card. Without this the engine
    // dialog would answer, which the product forbids.
    try {
      await host.DialogPrompts?.install?.({ window: win });
    } catch {
      // No dialog bridge: the engine keeps its own prompt.
    }
    // Shields: install the process-wide observers (CNAME/CSP/forget-on-close)
    // once at boot, not only when Settings or the shield menu is opened.
    try {
      host.Blocker?.install?.();
      host.Privacy?.install?.();
    } catch {
      // A partially installed observer set still leaves the engine filters in
      // place; the next Settings open retries.
    }

    // P4: the native tabbrowser deck is the product path. The stage follows
    // the Astra content slot; mountNative marks it mounted once gBrowser owns
    // the tabs.
    if (win?.Services?.prefs?.getBoolPref) {
      try {
        win.Services.prefs.clearUserPref("astra.gbrowser.enabled");
      } catch {
        // No stale user override to clear.
      }
    }
    // P8: the Source page's engine read. The host module owns the request
    // shape and bounds; the shell supplies the document read.
    try {
      host.PageSource?.setDriver?.(async (tabId) => {
        // Never read a private window's page from chrome.
        if (privateWindow) return null;
        const list = await host.Tabs.list({ request_id: newRequestId() });
        const tab = (list.tabs ?? []).find((t) => t.astra_tab_id === tabId);
        if (!tab) return null;
        const url = typeof tab.url === "string" ? tab.url : "";
        if (!/^https?:/i.test(url)) return { url, text: "", truncated: false };
        const response = await fetch(url, { credentials: "include" });
        const text = await response.text();
        const cap = 2_000_000;
        return { url, text: text.slice(0, cap), truncated: text.length > cap };
      });
    } catch {
      // No host module: the Source page shows "no document".
    }
    let stageObserver = null;
    let stageMutation = null;
    let onStageResize = null;
    let applyGbrowserStage = null;
    const gbrowserRoot = doc.documentElement;
    gbrowserRoot.setAttribute("data-astra-gbrowser", "true");
    {
      const applyStage = () => {
        const rect = stageRectOf(slot);
        const vars = stageStyle(rect);
        for (const [key, value] of Object.entries(vars)) {
          gbrowserRoot.style.setProperty(key, value);
        }
        const mounted = gbrowserRoot.getAttribute("data-astra-native-mounted") === "true";
        const state = mounted
          ? stageStateFor({
              booted: frameRoot.getAttribute("data-app-booted") === "true",
              hasPage: slot.dataset.hasPage === "true",
              loading: slot.dataset.loading === "true",
              internal: slot.dataset.internal === "true",
            })
          : "app";
        gbrowserRoot.setAttribute("data-astra-stage", state);
      };
      stageObserver = new ResizeObserver(applyStage);
      stageObserver.observe(slot);
      stageMutation = new MutationObserver(applyStage);
      stageMutation.observe(slot, {
        attributes: true,
        attributeFilter: ["data-has-page", "data-loading", "data-internal"],
      });
      stageMutation.observe(frameRoot, {
        attributes: true,
        attributeFilter: ["data-app-booted"],
      });
      applyGbrowserStage = applyStage;
      onStageResize = () => applyStage();
      win?.addEventListener("resize", onStageResize);
      applyStage();
    }
    // The Rust core is per-process: stop it on application quit, not on a
    // single window close. Multiple windows may hold this observer; Boot
    // shutdown is idempotent.
    let coreStopped = false;
    const stopCore = () => {
      if (coreStopped) return;
      coreStopped = true;
      // Flush the last organisation change before the sidecar exits; the
      // debounced save may not have fired yet.
      void (async () => {
        try {
          await host.Metadata?.flush?.();
        } catch {
          // The core is already gone; nothing left to persist.
        }
        try {
          await host.Boot.shutdown({ request_id: "shell-quit", reason: "quit-application-granted" });
        } catch {
          // Shutdown is best effort on quit.
        }
      })();
    };
    const quitObserver = {
      observe(_subject, topic) {
        if (topic === "quit-application-granted") stopCore();
      },
    };
    try {
      win?.Services?.obs?.addObserver(quitObserver, "quit-application-granted");
    } catch {
      // No Services in a preview DOM.
    }
    // The browser's shortcuts belong to the product, not to hidden Firefox
    // chrome. The app's keymap is the one registry; the shell matches the same
    // accelerators when focus is on the page (where the app document never
    // sees the key) and runs the same command ids. The native keys those
    // commands own are disabled below, so Ctrl+D cannot fall through to the
    // page-action bookmark flow that has no anchor in this window.
    const KEY_ALIAS = {
      "nav.back.alt": "nav.back",
      "nav.forward.alt": "nav.forward",
      "tab.next.alt": "tab.next",
      "tab.previous.alt": "tab.previous",
      "page.devtools.alt": "page.devtools",
    };
    const NATIVE_KEYS = [
      "addBookmarkAsKb",
      "key_savePage",
      "printKb",
      "key_openDownloads",
      "key_openAddons",
      "openFileKb",
      "key_newNavigator",
      "key_newNavigatorTab",
      "key_close",
      "key_closeWindow",
      "goBackKb",
      "goForwardKb",
      "goBackKb2",
      "goForwardKb2",
      // Alt+Home is the product's own `nav.home`; the native goHome key must
      // not also run `cmd_home` (it would answer with the engine homepage).
      "goHome",
      "key_reload",
      "key_reload2",
      "key_reload_skip_cache",
      "key_reload_skip_cache2",
      "showAllHistoryKb",
      "key_showAllHistory",
      "key_enterFullScreen",
      "key_enterFullScreen_old",
      "key_enterFullScreen_compat",
      "key_toggleReaderMode",
      "key_togglePictureInPicture",
      "key_toggleMute",
      // DevTools registers its shortcuts as <key> elements at startup.
      "key_toggleToolboxF12",
      "key_toggleToolbox",
      "key_browserToolbox",
      "key_browserConsole",
      "key_responsiveDesignMode",
      "key_inspector",
      "key_webconsole",
    ];
    const KEY_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
    const normalKey = (key) => {
      if (key.length === 1) return key.toUpperCase();
      if (key.startsWith("VK_")) key = key.slice(3);
      if (key.startsWith("Arrow")) key = key.slice(5);
      return key;
    };
    const canonicalKey = (accelerator) => {
      const parts = String(accelerator).split("+").map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0) return "";
      const key = normalKey(parts.pop());
      const mods = new Set();
      for (const part of parts) {
        if (part === "CmdOrCtrl" || part === "Ctrl" || part === "Control") mods.add("Ctrl");
        else if (part === "Alt" || part === "Option") mods.add("Alt");
        else if (part === "Shift") mods.add("Shift");
        else if (part === "Meta" || part === "Cmd" || part === "Command") mods.add("Meta");
      }
      return [...KEY_ORDER.filter((m) => mods.has(m)), key].join("+");
    };
    const acceleratorOf = (event) => {
      const mods = [];
      if (event.ctrlKey) mods.push("Ctrl");
      if (event.altKey) mods.push("Alt");
      if (event.shiftKey) mods.push("Shift");
      if (event.metaKey) mods.push("Meta");
      return [...mods, normalKey(event.key ?? "")].join("+");
    };
    const globalKeys = new Map();
    const loadGlobalKeys = async () => {
      globalKeys.clear();
      try {
        for (const entry of await host.Keymap.entries({})) {
          if (!entry?.accelerator) continue;
          const key = canonicalKey(entry.accelerator);
          if (key) globalKeys.set(key, KEY_ALIAS[entry.id] ?? entry.id);
        }
      } catch {
        // No keymap: the native keys stay as they are and the app still works.
      }
      // Function keys the native keyset owns but the registry names differently.
      globalKeys.set("F5", "nav.reload");
      globalKeys.set("F11", "window.fullscreen");
      globalKeys.set("F12", "page.devtools");
    };
    await loadGlobalKeys();
    const disableNativeKeys = () => {
      for (const id of NATIVE_KEYS) {
        try {
          doc.getElementById(id)?.setAttribute("disabled", "true");
        } catch {
          // A key the build does not have.
        }
      }
    };
    disableNativeKeys();
    // DevTools creates its key elements during startup, which can land after
    // this mount; one later pass covers it.
    const keySweep = setTimeout(disableNativeKeys, 1500);
    const onGlobalKey = (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      let fromApp = false;
      try {
        fromApp = !!appApi?.element && event.target?.ownerDocument === appApi.element.contentDocument;
      } catch {
        fromApp = false;
      }
      // The app document's own keymap handles its keys; this path exists for
      // the page and the chrome around it.
      if (fromApp) return;
      const id = globalKeys.get(acceleratorOf(event));
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      void host.Commands.run({ id });
    };
    win.addEventListener("keydown", onGlobalKey, true);
    // Auxiliary mouse buttons are shortcuts too (back / forward / extra).
    // With no binding the engine's own button behaviour is untouched.
    const onGlobalMouse = (event) => {
      if (event.defaultPrevented || event.button < 3 || event.button > 5) return;
      let fromApp = false;
      try {
        fromApp = !!appApi?.element && event.target?.ownerDocument === appApi.element.contentDocument;
      } catch {
        fromApp = false;
      }
      if (fromApp) return;
      const mods = [];
      if (event.ctrlKey) mods.push("Ctrl");
      if (event.altKey) mods.push("Alt");
      if (event.shiftKey) mods.push("Shift");
      if (event.metaKey) mods.push("Meta");
      const id = globalKeys.get([...mods, `Mouse${event.button}`].join("+"));
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      void host.Commands.run({ id });
    };
    win.addEventListener("mousedown", onGlobalMouse, true);
    // A page's fullscreen request can be refused by the engine for reasons
    // outside the stage's control (the content not yet focused on a first
    // click). The chrome document's fullscreen element is the stage browser
    // by then; if the engine did not apply the chrome layout, do it here so
    // the page still gets the window. Leaving fullscreen clears it either way.
    const onFsRequest = (event) => {
      const target = event.target;
      const astra =
        target?.hasAttribute?.("data-astra-browser") ||
        target?.hasAttribute?.("data-astra-browser-parked");
      if (!astra) return;
      setTimeout(() => {
        if (doc.documentElement.hasAttribute("inDOMFullscreen")) return;
        if (!doc.fullscreenElement) return;
        doc.documentElement.setAttribute("inDOMFullscreen", "true");
        try {
          win.fullScreen = true;
        } catch {
          // The window manager refused; the layout still fills the window.
        }
      }, 250);
    };
    const onFsExit = () => {
      doc.documentElement.removeAttribute("inDOMFullscreen");
      try {
        if (win.fullScreen) win.fullScreen = false;
      } catch {
        // Already out.
      }
    };
    doc.addEventListener("MozDOMFullscreen:Request", onFsRequest, true);
    doc.addEventListener("MozDOMFullscreen:Exit", onFsExit, true);
    doc.addEventListener("MozDOMFullscreen:Exited", onFsExit, true);
    // A private window keeps nothing. Its tabs inherit the window's private
    // browsing context, so Places never records them; the projection also
    // has to say so or the app would paint a normal window's chrome and offer
    // history/bookmarks the window cannot keep.
    let privateWindow = false;
    try {
      const { PrivateBrowsingUtils } = await import(
        /* @vite-ignore */ "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
      );
      privateWindow = PrivateBrowsingUtils.isWindowPrivate(win);
    } catch {
      // Older/odd build: the window is treated as normal.
    }
    privateWindow = privateWindow === true;
    // P3-T15: mount the full app into the main column. The relay terminates
    // in this window's host modules, so the app boots in host mode. The
    // interim mounts stay wired (live contract tests drive them); they hide
    // on host-ready and return only if the app fails (P3-T16).
    appApi = mountAppFrame(appMount, host, {
      window_id: ownWindowId,
      // Records the mode the app actually booted in (P3-T15 contract seam:
      // live suites assert `host` here). Ready also retires the interim
      // chrome (P3-T16); a failure keeps it visible with appError set.
      onReady: (mode) => {
        appMount.dataset.appReady = mode;
        appBooted = mode === "host";
        if (!appBooted) {
          appError = `app booted in ${mode} mode, expected host`;
        } else {
          // A prompt raised before the app frame subscribed must still show.
          try {
            void host.Permissions?.republish?.();
          } catch {
            // No permission surface in a preview DOM.
          }
        }
      },
      onFailure: (message) => {
        appBooted = false;
        appError = message;
      },
      // The app chooses light or dark; web pages follow the same choice, and
      // the shell's own loading ground (which paints before/behind a page)
      // follows it too.
      onTheme: (theme) => {
        frameRoot.dataset.astraTheme = theme === "light" ? "light" : "dark";
        void host.System?.setContentColorScheme?.({ light: theme === "light" });
      },
      // The app renders from the projection, and a private window's profile
      // is the one thing the host model does not carry yet. Rewrite only that
      // field; every tab, space and active id stays the model's own.
      transformEvent: (event) => {
        // A per-window surface (peek cards) must never reach another window's
        // app frame. The shell filters before the bridge sees it.
        if (event?.data?.window_id && event.data.window_id !== ownWindowId) return null;
        if (!privateWindow || event?.type !== "items-changed" || !event.data) return event;
        return {
          ...event,
          data: {
            ...event.data,
            profile: { id: "incognito", name: "Private", kind: "incognito" },
          },
        };
      },
      // A private window has no history and no bookmarks to show or write.
      // Answer in the caller's own shape so the surface renders its private
      // state instead of an error (and never reads the normal profile).
      guardCall: async (moduleName, methodName) => {
        if (!privateWindow) return null;
        if (moduleName === "Bookmarks" && methodName === "call") {
          return { payload: { kind: "error", error: "unavailable", profile: "incognito" } };
        }
        if (moduleName === "HistoryCall" && methodName === "call") {
          return { payload: { kind: "page", visits: [], next: null, profile: "incognito" } };
        }
        if (moduleName === "History" && methodName === "visit") {
          return { payload: { mirrored: false, private: true } };
        }
        return null;
      },
    });

    // Frame.sys.mjs rides the same resource:// mapping as the Host API
    // (jar.mn: content/astra/res/frame/Frame.sys.mjs). Degrades to null
    // outside the browser; window controls then report unsupported_chrome_op.
    let Frame = null;
    try {
      Frame = await import(
        /* @vite-ignore */ "resource://astra/frame/Frame.sys.mjs"
      );
    } catch {
      Frame = null;
    }

    // Chrome adapter for dispatchWindowControl: the DOM window owns
    // minimize/maximize/restore (no Host API equivalent). Only methods the
    // window actually has are exposed, so a missing op still reports
    // unsupported_chrome_op instead of silently no-op'ing.
    const chromeAdapter = {};
    if (win) {
      for (const op of ["minimize", "maximize", "restore"]) {
        if (typeof win[op] === "function") {
          chromeAdapter[op] = () => win[op]();
        }
      }
    }

    async function currentWindowId() {
      return ownWindowId || "win-1";
    }

    function mirrorFullscreen(fullscreen) {
      frameRoot.setAttribute("data-astra-fullscreen", fullscreen ? "true" : "false");
    }

    async function handleControl(action) {
      if (!Frame) {
        return;
      }
      const res = await Frame.dispatchWindowControl(host, chromeAdapter, {
        action,
        window_id: await currentWindowId(),
        request_id: newRequestId(),
      });
      if (res && !res.error && action === "toggle-fullscreen") {
        mirrorFullscreen(res.fullscreen === true);
      }
    }

    const titlebar = createTitlebar(doc, {
      title: "Astra",
      onControl: (action) => void handleControl(action),
    });
    titleMount.replaceWith(titlebar.element);

    const sidebar = createSidebar(doc, {
      items: SIDEBAR_ITEMS,
      activeId: "tabs",
      onSelect: (id) => sidebar.select(id),
    });
    sideMount.replaceWith(sidebar.element);

    const toolbar = createToolbar(doc, {
      actions: TOOLBAR_ACTIONS,
      onAction: (id) => void handleToolbar(id),
    });
    // frame.js builders carry no accessible names; label from the shell map.
    try {
      for (const b of toolbar.element.querySelectorAll("[data-action]")) {
        const label = TOOLBAR_LABELS[b.getAttribute("data-action")];
        if (label) {
          b.setAttribute("aria-label", label);
          b.title = label;
        }
      }
    } catch {
      // Fake/minimal DOMs in contract tests may lack querySelectorAll.
    }
    toolMount.replaceWith(toolbar.element);

    const tabstrip = mountTabStrip(tabsMount, host);

    const bar = mountUrlBar(barMount, host);

    // Split grid starts hidden: blankSplit() is a single empty pane, so the
    // P1-T10 content slot keeps the whole main column until the user (or a
    // toolbar action) opens a second slot. The mount is still present.
    splitMount.hidden = true;
    const splitApi = mountSplit(splitMount, host, {
      tabs: [],
      onChange: (state) => {
        splitMount.hidden = state.slots.length < 2;
      },
    });

    async function handleToolbar(id) {
      try {
        if (id === "new-tab") {
          await host.Tabs.create({ request_id: newRequestId(), url: "about:blank" });
        } else if (id === "split") {
          splitApi.split(null);
        } else if (id === "toggle-fullscreen") {
          await handleControl("toggle-fullscreen");
        }
      } catch {
        // Refused host ops leave the last painted state; the next host
        // event resynchronizes the strip.
      }
    }

    async function refreshTabs() {
      try {
        const list = await host.Tabs.list({ request_id: newRequestId() });
        const snaps = list.tabs ?? [];
        splitApi.update(
          snaps.map((t) => ({ id: t.astra_tab_id, title: t.title, url: t.url })),
        );
        const active = snaps.find((t) => t.selected) ?? snaps[0];
        titlebar.setTitle(active && active.title ? `Astra — ${active.title}` : "Astra");
      } catch {
        // Window teardown: leave the last painted state.
      }
    }

    if (win && !win.__astraHost) {
      // Shell test seam for the Marionette contract tests
      // (tests/contract/content_slot.py, shell_assembly live checks):
      // exposes the window's Host API instance plus the Frame dispatch
      // bound to this window's host + chrome adapter. Chrome code already
      // has these capabilities; this adds none.
      win.__astraHost = {
        Tabs: host.Tabs,
        Navigation: host.Navigation,
        Panes: host.Panes,
        SplitView: host.SplitView,
        Peek: host.Peek,
        SpaceHistory: host.SpaceHistory,
        SpaceExtensions: host.SpaceExtensions,
        SpaceClone: host.SpaceClone,
        TabGroups: host.TabGroups,
        Settings: host.Settings,
        Windows: host.Windows,
        Metadata: host.Metadata,
        __spacesState: host.__spacesState,
        Frame: Frame
          ? {
              version: Frame.FRAME_VERSION,
              actions: Frame.WINDOW_ACTIONS,
              dispatchWindowControl: (opts = {}) =>
                (async () => {
                  const window_id = opts.window_id ?? ownWindowId;
                  return Frame.dispatchWindowControl(host, chromeAdapter, {
                    request_id: newRequestId(),
                    ...opts,
                    window_id,
                  });
                })(),
            }
          : null,
        addEventListener: host.addEventListener,
      };
    }

    const off = host.addEventListener((event) => {
      if (!event || typeof event.type !== "string") {
        return;
      }
      try {
        // Diagnostics: which host events actually reach the shell.
        const log = (appMount.dataset.hostEvents ?? "").split(",").filter(Boolean);
        log.push(event.type);
        appMount.dataset.hostEvents = [...new Set(log)].slice(-14).join(",");
      } catch {
        // Best-effort diagnostics only.
      }
      if (event.type === "keymap-changed") {
        // A rebind applies to the page and chrome keys immediately, not only
        // after the window is reopened.
        void loadGlobalKeys();
      } else if (event.type === "window.fullscreen-changed") {
        if (event.data?.window_id === ownWindowId) {
          mirrorFullscreen(event.data?.fullscreen === true);
        }
      } else if (event.type.startsWith("tab.")) {
        void refreshTabs();
      } else if (event.type === "sidebar.changed") {
        // The app publishes the column's laid-out width. Hidden, the column is
        // a card over the page: the page takes the window's gutter, not the
        // column's width. The CSS adds the 8px gutter + 8px content gap.
        const width = event.data?.width;
        const hidden = event.data?.hidden === true;
        const peeking = event.data?.peeking === true;
        const column = hidden || typeof width !== "number" || !Number.isFinite(width) ? 0 : width;
        frameRoot.style.setProperty("--astra-sidebar-width", `${Math.max(0, column)}px`);
        // The card keeps the column's reported width even while hidden (the
        // page takes the gutter, not the column's room). The peek clip below
        // needs that width: it is the only part of the chrome that may sit
        // over the page and take the pointer.
        const card = typeof width === "number" && Number.isFinite(width) ? Math.max(0, width) : 0;
        frameRoot.style.setProperty("--astra-sidebar-card-width", `${card}px`);
        // A hidden column peeks as a card over the page. The app frame holds
        // the card, so it has to come above the page surface and let the page
        // show through around it; the app clears its own ground for the same
        // window (`data-astra-peek`).
        // The peek treatment (clip + raise over the page) only applies when a
        // real page is in front. Over a New Tab the app frame holds the page
        // the person is looking at, so clipping it to the card left only a
        // dark strip. With no page the card simply slides inside the app.
        const overPage = slot.dataset.hasPage === "true";
        frameRoot.dataset.astraSidebarPeek = hidden && peeking && overPage ? "true" : "false";
        // `animate` marks a deliberate change of shape (the app's `travel`):
        // the page travels with the column. A drag reports false and the page
        // tracks the pointer without a transition lagging behind it.
        frameRoot.dataset.astraSidebarAnimate = event.data?.animate === true ? "true" : "false";
      } else if (event.type === "ui-command") {
        // Work, Settings, Tasks, Notes and Time are the app's own pages: the
        // real page surface must get out of their way. This command is only
        // the first word — the app's `surface` message above is the
        // authority, because choosing a web tab parks the page without
        // emitting a host command at all.
        const command = typeof event.data === "string" ? event.data : "";
        if (SHELL_COMMANDS.has(command)) {
          void runChromeAction(win, host, command, { browser: mounted?.browser ?? null });
        }
        if (command === "browser.return") {
          delete slot.dataset.internal;
        } else if (command.startsWith("browser.") && command !== "browser.return-failed") {
          slot.dataset.internal = "true";
        }
      } else {
        // The stage's two flags (a real page in front, and whether it is still
        // arriving) are derived in `content/slot-state.js` so every path —
        // nav.started, nav.committed, a projection with no active tab — agrees.
        // The projection names the tab in front, so a background tab's
        // navigation cannot take the stage over.
        if (event.type === "items-changed") {
          activeTabId = typeof event.data?.active === "string" ? event.data.active : "";
        }
        const next = slotStateFor(event, {
          activeId: activeTabId,
          committedId: committedTabId,
          committedUrl,
        });
        if (next !== null) {
          if (event.type === "nav.committed" && event.data?.external === true) {
            // A real document commit: the page is in front and paints from
            // here. The rest of the load must not put the cover back over it.
            committedTabId =
              typeof event.data?.astra_tab_id === "string" ? event.data.astra_tab_id : activeTabId;
            committedUrl = typeof event.data?.url === "string" ? event.data.url : "";
          } else if (event.type === "nav.started") {
            // A new address has not committed yet: the cover belongs up.
            committedTabId = "";
            committedUrl = "";
          }
          if (next.hasPage) {
            slot.dataset.hasPage = "true";
          } else {
            delete slot.dataset.hasPage;
          }
          if (next.loading) {
            slot.dataset.loading = "true";
            const url =
              event.type === "nav.started"
                ? event.data?.url
                : event.type === "items-changed"
                  ? (event.data?.tabs ?? []).find((t) => t.id === event.data?.active)?.url
                  : "";
            loadingHost = labelFor(url);
          } else {
            delete slot.dataset.loading;
            loadingHost = "";
          }
        }
      }
    });

    let mounted = null;
    if (!host.Content) {
      slotError = "content binding unavailable";
    } else {
      try {
        try {
          // P5b: install the saved spaces before any tab exists, so a tab
          // adopted from SessionStore lands in a space that already exists.
          try {
            await host.Metadata?.prepare?.({ private: privateWindow, window_id: ownWindowId });
          } catch {
            // No core or no snapshot: the browser keeps its default space.
          }
          // The native mount maps the model, so the model must exist before
          // it lists tabs; otherwise a bootstrap tab created in the gap is
          // never bound.
          await host.Tabs.bootstrap({ request_id: newRequestId() });
          mounted = await host.Content.mountNative(slot, {
            request_id: newRequestId(),
            window_id: ownWindowId,
          });
          gbrowserRoot.setAttribute("data-astra-native-mounted", "true");
          applyGbrowserStage?.();
          // Re-apply each restored tab's space and pin now that the native
          // mount adopted them, then keep the store current.
          try {
            await host.Metadata?.restore?.();
            host.Metadata?.init?.({ private: privateWindow, window_id: ownWindowId });
          } catch {
            // A failed restore leaves the tabs where the engine put them.
          }
        } catch (e) {
          slotError = String(e?.message ?? e);
        }
      } catch (e) {
        slotError = String(e?.message ?? e);
      }
    }
    void refreshTabs();
    // A window opened "in new window" carries its address on the window
    // object, so the engine's hidden tabbox never fetched the page first. The
    // address goes into this window's own tab model, which owns the browser.
    const pending = win?.__astraPendingUrl;
    if (pending) {
      try {
        delete win.__astraPendingUrl;
      } catch {
        // A frozen window object: the address still loads below.
      }
      try {
        await host.Content?.navigate?.(pending, { request_id: newRequestId() });
      } catch {
        // The page refuses to load; the New Tab stays, as any failed open does.
      }
    }
    // The page's context menu belongs to the product too. Intercept the
    // engine's menu for Astra content, send the rows to the app, and run the
    // chosen row here, where the chrome window's own objects live. Only this
    // window's app frame may answer: a web page is a descendant of the chrome
    // document and could otherwise post a menu action to it.
    const fromApp = (event) => {
      try {
        return !appApi?.element || event.source == null || event.source === appApi.element.contentWindow;
      } catch {
        return false;
      }
    };
    let menuTimer = 0;
    function setMenuOpen(open) {
      clearTimeout(menuTimer);
      frameRoot.dataset.astraMenuOpen = open ? "true" : "false";
      if (open) {
        menuTimer = setTimeout(() => setMenuOpen(false), 30000);
      }
    }
    // A page peek is drawn in the app frame, which normally sits under the
    // page. While one is open the frame is raised and clipped to the card's
    // own rectangle, so the page keeps its pointer everywhere else.
    function setPeekOpen(open, rect = null) {
      if (!open) {
        frameRoot.dataset.astraPeekOpen = "false";
        return;
      }
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      const top = clamp(Number(rect?.top) || 0, 0, win.innerHeight);
      const right = clamp(Number(rect?.right) || 0, 0, win.innerWidth);
      const bottom = clamp(Number(rect?.bottom) || 0, 0, win.innerHeight);
      const left = clamp(Number(rect?.left) || 0, 0, win.innerWidth);
      frameRoot.style.setProperty("--astra-peek-top", `${Math.round(top)}px`);
      frameRoot.style.setProperty("--astra-peek-right", `${Math.round(right)}px`);
      frameRoot.style.setProperty("--astra-peek-bottom", `${Math.round(bottom)}px`);
      frameRoot.style.setProperty("--astra-peek-left", `${Math.round(left)}px`);
      frameRoot.dataset.astraPeekOpen = "true";
    }
    const tabIdOf = (browser) => {
      for (const [id, entry] of mounted?.browsers ?? []) {
        if (entry.browser === browser) return id;
      }
      return null;
    };
    const contentMenu = installContentMenu(win, {
      host,
      // The page menu is drawn by the app, so it uses the same menu recipe as
      // every other Astra menu. The app posts the chosen id back and the
      // chrome acts on the live `nsContextMenu`. The shell-drawn menu stays as
      // a fallback for a window whose app frame has not mounted.
      showMenu: (menu) => {
        let target = null;
        try {
          target = appApi?.element?.contentWindow ?? null;
        } catch {
          target = null;
        }
        if (!target) {
          shellMenuApi.show(menu);
          return;
        }
        // `choose` is a closure and cannot be structured-cloned across the
        // frame; the chrome keeps the engine menu and runs the id the app
        // posts back.
        const { x, y, items } = menu;
        // A native popupshowing runs inside the engine's own event loop; a
        // synchronous cross-document post can be refused there. Deliver it on
        // the next turn, once the engine menu has been suppressed, and fall
        // back to the shell-drawn menu only if that also fails.
        setTimeout(() => {
          try {
            target.postMessage({ ns: "astra-shell", kind: "menu", menu: { x, y, items } }, "*");
          } catch {
            shellMenuApi.show(menu);
          }
        }, 0);
      },
      isFromApp: fromApp,
      tabIdOf,
    });
    const shellMenuApi = createShellMenu(win, {
      onClose: () => contentMenu?.release?.(),
    });
    const onWindowMenu = (event) => {
      const data = event?.data;
      if (!data || data.ns !== "astra-shell" || !fromApp(event)) return;
      if (data.kind === "menu-open") {
        setMenuOpen(true);
        return;
      }
      if (data.kind === "menu-close") {
        setMenuOpen(false);
        return;
      }
      // The app names the surface that is actually in front. This is the
      // authority for `data-internal`: a page can still be open while a web
      // tab is the one shown (parking), and no host command says so.
      if (data.kind === "surface") {
        if (data.internal === true) slot.dataset.internal = "true";
        else delete slot.dataset.internal;
        return;
      }
      if (data.kind === "peek-open") {
        setPeekOpen(true, data.rect ?? null);
        return;
      }
      if (data.kind === "peek-close") {
        setPeekOpen(false);
        return;
      }
      // The app's page bar floats over a web page instead of taking a row: it
      // keeps the page's rectangle, raises this frame, and the shell clips the
      // raised frame to the bar's strip so only that strip answers. A pinned
      // bar stays in the row and the page starts below it.
      if (data.kind === "bar") {
        const overlay = data.overlay === true;
        const shown = data.shown === true;
        frameRoot.dataset.astraBar = overlay ? "overlay" : "flow";
        frameRoot.dataset.astraBarShown = shown ? "true" : "false";
        // Raise only while the bar is actually down. A hidden floating bar is
        // the shell's own top-edge strip, so the frame (and its themed ground)
        // stays under the page.
        frameRoot.dataset.astraBarOpen = overlay && shown ? "true" : "false";
        if (Number.isFinite(data.height) && data.height > 0) {
          frameRoot.style.setProperty("--astra-bar-height", `${Math.round(data.height)}px`);
        }
        return;
      }
      if (data.kind !== "menu-run" || typeof data.id !== "string") return;
      setMenuOpen(false);
      // A page-menu row belongs to the chrome objects the engine handed over
      // (the link, the image, the page); a window row belongs to the window.
      void (async () => {
        let handled = false;
        try {
          const result = await contentMenu.run(data.id);
          handled = result?.accepted === true;
        } catch {
          handled = false;
        }
        if (!handled && (data.id.startsWith("window.") || data.id === "bookmark.current")) {
          void runChromeAction(win, host, data.id);
        }
      })();
    };
    win.addEventListener("message", onWindowMenu);
    const onSizeMode = () => mirrorFullscreen(win.fullScreen === true);
    win.addEventListener("sizemodechange", onSizeMode);
    teardown = () => {
      try {
        off();
      } catch {
        // Already torn down with the window.
      }
      win.removeEventListener("message", onWindowMenu);
      win.removeEventListener("keydown", onGlobalKey, true);
      win.removeEventListener("sizemodechange", onSizeMode);
      stageObserver?.disconnect();
      stageMutation?.disconnect();
      if (onStageResize) {
        win.removeEventListener("resize", onStageResize);
      }
      gbrowserRoot.removeAttribute("data-astra-gbrowser");
      gbrowserRoot.removeAttribute("data-astra-stage");
      gbrowserRoot.removeAttribute("data-astra-native-mounted");
      // Leaving the routing registry keeps a closed window from receiving
      // another tab's permission prompt.
      try {
        void host.Permissions?.uninstall?.({ window: win });
      } catch {
        // Already gone with the window.
      }
      try {
        void host.DialogPrompts?.uninstall?.({ window: win });
      } catch {
        // Already gone with the window.
      }
      try {
        host.PageSource?.setDriver?.(null);
      } catch {
        // Already gone with the window.
      }
      try {
        host.Metadata?.releaseOwner?.();
        host.Metadata?.dispose?.();
      } catch {
        // Already torn down with the window.
      }
      try {
        win?.Services?.obs?.removeObserver(quitObserver, "quit-application-granted");
      } catch {
        // Already gone with the window.
      }
      shellMenuApi.destroy();
      doc.removeEventListener("MozDOMFullscreen:Request", onFsRequest, true);
      doc.removeEventListener("MozDOMFullscreen:Exit", onFsExit, true);
      doc.removeEventListener("MozDOMFullscreen:Exited", onFsExit, true);
      clearTimeout(keySweep);
      clearTimeout(menuTimer);
      contentMenu.destroy();
      tabstrip.destroy();
      splitApi.destroy();
      titlebar.destroy();
      sidebar.destroy();
      toolbar.destroy();
      mounted?.detach();
      bar.destroy();
      appApi?.destroy();
    };
  });
</script>

<div class="astra-shell astra-frame" data-astra-frame="" data-astra-theme="light" data-astra-fullscreen="false" data-app-booted={appBooted === null ? "pending" : appBooted ? "true" : "false"} bind:this={frameRoot}>
  <div class="astra-titlebar-mount" bind:this={titleMount}></div>
  <div class="astra-toolbar-mount" hidden={appBooted !== false} bind:this={toolMount}></div>
  <div class="astra-frame-body">
    <div class="astra-sidebar-col" hidden={appBooted !== false}>
      <div class="astra-sidebar-mount" bind:this={sideMount}></div>
      <div class="astra-tabs-mount" bind:this={tabsMount}></div>
    </div>
    <div class="astra-main">
      <div class="astra-app-mount" data-astra-app="" bind:this={appMount}>
        {#if appError}
          <p class="slot-error" role="alert">{appError}</p>
        {/if}
      </div>
      <!-- The top edge of the page belongs to the shell while the app frame
           is under it. Hover here asks the app for its bar; the shell then
           raises the frame only while that bar is down. -->
      <div
        class="astra-bar-reveal"
        aria-hidden="true"
        onpointerenter={() => postBarHover(true)}
        onpointerleave={() => postBarHover(false)}
      ></div>
      <div class="astra-bar-mount" role="banner" hidden={appBooted !== false} bind:this={barMount}></div>
      <div class="astra-split-mount" hidden={appBooted !== false} bind:this={splitMount}></div>
      <div class="astra-content" role="main" aria-label="Web content" data-astra-content="" bind:this={slot}>
        {#if slotError}
          <p class="slot-error" role="alert">{slotError}</p>
        {/if}
        {#if loadingHost}
          <div class="loading-stage" role="status" aria-live="polite">
            <span class="loading-spinner" aria-hidden="true"></span>
            <span>{loadingHost}</span>
          </div>
        {/if}
      </div>
      {#if loadingHost}
        <!-- The skeleton is a stage surface, not a page card: it covers the
             whole content column while a page arrives, so the rounded card
             inset and its empty frame never show during a load. -->
        <div class="load-skeleton" aria-hidden="true">
          <div class="sk sk-bar"></div>
          <div class="sk sk-hero"></div>
          <div class="sk sk-line" style:inline-size="62%"></div>
          <div class="sk sk-line" style:inline-size="86%"></div>
          <div class="sk sk-line" style:inline-size="74%"></div>
          <div class="sk sk-line" style:inline-size="40%"></div>
        </div>
      {/if}
    </div>
  </div>
  <details class="astra-about">
    <summary>Shell status</summary>
    <Hello />
  </details>
</div>

<style>
  .astra-shell {
    /* The shell paints the ground a page is still arriving on, and the
       skeleton in front of it. The app announces its theme as soon as it
       mounts; until then the shipped light default is the right guess. */
    --shell-loading-ground: #f1f1f3;
    --shell-loading-raised: #fffdf9;
    --shell-loading-fill: #e8e6e2;
    --shell-loading-fill-hi: #f7f5f2;
    --shell-loading-text: #1c1c1f;
    --shell-loading-border: rgb(24 24 27 / 0.12);
    --shell-loading-border-strong: rgb(24 24 27 / 0.18);
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--shell-loading-ground);
    color: var(--shell-loading-text);
  }
  /* The attribute is set from the app's theme message, so the ancestor is
     global; a scoped selector here is pruned as unreachable. */
  :global(.astra-frame[data-astra-theme="dark"]) {
    --shell-loading-ground: #1c1b22;
    --shell-loading-raised: #2b2a33;
    --shell-loading-fill: #3a3a44;
    --shell-loading-fill-hi: #4a4a55;
    --shell-loading-text: #f4f4f6;
    --shell-loading-border: rgb(255 255 255 / 0.12);
    --shell-loading-border-strong: rgb(255 255 255 / 0.18);
  }
  .astra-frame-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: row;
  }
  .astra-sidebar-col {
    flex: 0 0 220px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid #52525e;
    background: #2b2a33;
  }
  .astra-tabs-mount {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .astra-main {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .astra-bar-mount {
    display: flex;
    flex-direction: column;
  }
  .astra-bar-mount > :global(.astra-urlbar) {
    display: flex;
  }
  .astra-split-mount {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  /* Author `display` rules defeat the UA `[hidden]` rule, so mounts with
     a `hidden` binding need explicit opt-outs (same as .astra-split-cell).
     Covers the P3-T16 app-booted retirement (sidebar/urlbar/split hide;
     content slot and titlebar never hide) and imperative hiding in onMount. */
  :global(.astra-split-mount[hidden]),
  :global(.astra-sidebar-col[hidden]),
  :global(.astra-bar-mount[hidden]),
  /* The titlebar/toolbar are built by frame.js, so their author `display`
     rules defeat the UA `[hidden]` rule exactly like the mounts above. */
  :global(.astra-titlebar[hidden]),
  :global(.astra-toolbar[hidden]) {
    display: none;
  }
  /* P3-T20: once the app owns the window it *is* the chrome — the interim
     titlebar/toolbar/sidebar/split/diagnostic strip must not claim space, or
     the window shows two nested chromes (and 81px of dead strip). The
     titlebar/toolbar are built by frame.js and replace their mounts, so the
     `hidden` bindings no longer reach them: hide by frame state instead. */
  .astra-frame[data-app-booted="true"] :global(.astra-titlebar),
  .astra-frame[data-app-booted="true"] :global(.astra-toolbar),
  .astra-frame[data-app-booted="true"] .astra-about,
  /* While booting, none of the fallback chrome is shown at all: no titlebar,
     no toolbar, no sidebar, no split, no status strip. The app's ground
     colour fills the window until the app announces itself. */
  .astra-frame[data-app-booted="pending"] :global(.astra-titlebar),
  .astra-frame[data-app-booted="pending"] :global(.astra-toolbar),
  .astra-frame[data-app-booted="pending"] :global(.astra-sidebar-col),
  .astra-frame[data-app-booted="pending"] .astra-sidebar-col,
  .astra-frame[data-app-booted="pending"] :global(.astra-bar-mount),
  .astra-frame[data-app-booted="pending"] .astra-bar-mount,
  .astra-frame[data-app-booted="pending"] :global(.astra-split-mount),
  .astra-frame[data-app-booted="pending"] .astra-split-mount,
  .astra-frame[data-app-booted="pending"] .astra-about {
    display: none;
  }
  .astra-frame[data-app-booted="true"] .astra-main,
  .astra-frame[data-app-booted="pending"] .astra-main {
    position: relative;
  }
  /* The app fills the window. The content slot is only a surface for real
     pages: empty (no committed page) it takes no space at all; with a page it
     overlays the app's stage, inset by the sidebar width the app publishes
     (`sidebar_set_width` → `--astra-sidebar-width`). */
  .astra-frame[data-app-booted="true"] .astra-content,
  .astra-frame[data-app-booted="pending"] .astra-content {
    position: absolute;
    /* The app draws an 8px window gutter and an 8px gap between the column
       and its page; the real page surface must land on the same rectangle, or
       it covers the last 8px of the sidebar. */
    inset: 8px;
    z-index: 2;
    inset-inline-start: calc(var(--astra-sidebar-width, 0px) + 16px);
    /* The app's main-page bar is 40px tall inside that 8px gutter; the page
       starts under it, at the top edge of the card the app draws. */
    inset-block-start: 48px;
    border-radius: 12px;
    overflow: hidden;
    background: transparent;
    /* A pinned bar keeps its row. A floating bar is an overlay: the page
       keeps the card's full rectangle and the bar slides over the top of it,
       so revealing the bar never moves the page. */
    transition: inset-block-start 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  :global(.astra-frame[data-app-booted="true"][data-astra-bar="overlay"] .astra-content),
  :global(.astra-frame[data-app-booted="pending"][data-astra-bar="overlay"] .astra-content) {
    inset-block-start: 8px;
  }
  /* A deliberate change of shape travels on the app's own curve
     (`--motion-page` 400ms, `--ease-emphasized`); those tokens live in the
     app document, not this one, so the values are mirrored here. A drag
     reports animate=false: the page must track the pointer, not chase it. */
  :global(.astra-frame[data-astra-sidebar-animate="true"] .astra-content) {
    transition:
      inset-inline-start 400ms cubic-bezier(0.16, 1, 0.3, 1),
      inset-block-start 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.astra-frame[data-astra-sidebar-animate="true"] .astra-content) {
      transition: none;
    }
  }
  .astra-frame[data-app-booted="true"] .astra-content:not([data-has-page="true"]),
  .astra-frame[data-app-booted="pending"] .astra-content:not([data-has-page="true"]) {
    display: none;
  }
  /* An app page (Work, Settings, Tasks, Notes, Time) owns the window: the
     real page surface keeps its browser alive but is not painted. Three
     classes beat the scoped base `.astra-content` display without !important. */
  :global(.astra-frame .astra-content[data-internal="true"]) {
    display: none;
  }
  /* P3-T17: the native `#browser` box is empty (toolbox, tabbox and sidebars
     are all hidden by shell-chrome.css) but its `flex="1"` still claims half
     the window, leaving gray dead space below the shell. Hide it so
     `#astra-root` owns the whole window. The titlebar + content slot (P3-T16)
     live inside `#astra-root` and are unaffected, as is the `__astraHost`
     seam (the hidden DOM and `gBrowser` object persist). */
  :global(#astra-root ~ #browser) {
    display: none;
  }
  /* P4 spike: when the pref is on, the native deck is docked over the Astra
     content slot. It stays hidden until Content.mountNative marks it mounted
     and the stage has a committed page. Explicit px, not inset (D-30). */
  :global(:root[data-astra-gbrowser="true"] #browser) {
    display: block !important;
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    background: transparent;
  }
  :global(:root[data-astra-gbrowser="true"] #tabbrowser-tabbox) {
    /* The tabbox is the root of a flex chain (tabbox -> tabpanels ->
       browserSidebarContainer -> browserContainer -> browserStack). Forcing
       `block` collapses that chain: tabpanels computes 0 height and the page
       paints in a 25px strip at the top of the stage. */
    display: flex !important;
    flex-direction: column;
    position: absolute;
    left: var(--astra-stage-x, 0px);
    top: var(--astra-stage-y, 0px);
    width: var(--astra-stage-w, 0px);
    height: var(--astra-stage-h, 0px);
    margin: 0;
    pointer-events: auto;
    visibility: hidden;
  }
  :global(:root[data-astra-gbrowser="true"][data-astra-stage="page"] #tabbrowser-tabbox) {
    visibility: visible;
  }
  .astra-split-mount > :global(.astra-split) {
    max-height: 40vh;
  }
  .astra-content {
    flex: 1 1 auto;
    min-height: 200px;
    display: flex;
    flex-direction: column;
    /* The chrome's ground while a page is on its way: a load should read as
       the window waiting, not as the window dying. The page paints over it,
       and it follows the app's light/dark choice. */
    background: var(--shell-loading-ground);
  }
  /* The slot is a surface, not a control. While it is the loading cover it
     must never eat a click aimed at the page underneath. */
  :global(.astra-content[data-loading="true"]) {
    pointer-events: none;
  }

  /* A page still arriving says what it is waiting for, quietly, in the middle
     of the stage. The spinner and the label are one layer above the content
     browser, which is a sibling layer of its own. */
  .loading-stage {
    position: absolute;
    inset-block-start: 50%;
    inset-inline-start: 50%;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 10px;
    translate: -50% -50%;
    padding: 10px 16px;
    border: 1px solid var(--shell-loading-border);
    border-radius: 999px;
    background: var(--shell-loading-raised);
    color: var(--shell-loading-text);
    font: 500 13px/1.2 system-ui, sans-serif;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 8px 24px rgb(0 0 0 / 28%);
  }

  .loading-spinner {
    inline-size: 14px;
    block-size: 14px;
    border: 2px solid var(--shell-loading-border-strong);
    border-block-start-color: var(--shell-loading-text);
    border-radius: 50%;
    animation: content-loading 720ms linear infinite;
  }

  @keyframes content-loading {
    to {
      rotate: 360deg;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading-spinner {
      animation: none;
    }
  }

  /* A page still arriving gets a shape to look at, not a black rectangle:
     a toolbar, a hero and lines laid out like a page, quietly shimmering. */
  .load-skeleton {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 24px 32px;
    background: var(--shell-loading-ground);
    pointer-events: none;
    border-radius: 0;
  }

  .sk {
    border-radius: var(--radius-control, 6px);
    background: linear-gradient(
      90deg,
      var(--shell-loading-fill) 25%,
      var(--shell-loading-fill-hi) 40%,
      var(--shell-loading-fill) 55%
    );
    background-size: 220% 100%;
    animation: sk-shimmer 1.25s linear infinite;
  }

  .sk-bar {
    block-size: 26px;
    inline-size: 100%;
  }

  .sk-hero {
    block-size: 36%;
    inline-size: 100%;
    border-radius: var(--radius-card, 12px);
  }

  .sk-line {
    block-size: 12px;
    inline-size: 76%;
  }

  @keyframes sk-shimmer {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: -120% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk {
      animation: none;
    }
  }
  .astra-content > :global([data-astra-browser]) {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
  }
  /* While the page is still arriving the browser has nothing to show (a
     blank surface reads as a dead black window). Hide its layer so the
     stage's own ground and the spinner are what the person sees; the load
     keeps running underneath. */
  :global(.astra-content[data-loading="true"] > [data-astra-browser]) {
    opacity: 0;
  }
  /* Every page tab keeps its own browser; only the one in front claims the
     stage. The rest stay loaded (that is what makes a switch instant) but
     must not take space or paint. */
  .astra-content > :global(browser[data-astra-browser-parked]) {
    display: none;
  }
  .astra-app-mount {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--shell-loading-ground);
  }
  /* The shell's share of the bar's reveal: the page starts 8px down, so the
     strip sits in the window gutter and never covers page content. It stays
     above the raised app frame so a pointer parked on it keeps the bar down. */
  .astra-bar-reveal {
    display: none;
    position: absolute;
    z-index: 5;
    inset-block-start: 0;
    /* The app's shell keeps an 8px gutter; the bar starts there, not at the
       sidebar column's edge. Matching it means the whole bar width is a
       reveal target instead of losing its first 8px. */
    inset-inline-start: calc(var(--astra-sidebar-width, 0px) + 8px);
    inset-inline-end: 0;
    block-size: 8px;
    /* stylelint-disable-next-line property-no-unknown -- Gecko chrome property. */
    -moz-window-dragging: drag;
  }
  /* `data-astra-bar` is set imperatively on the frame, so the ancestor is
     global; a scoped selector here is pruned as unreachable. */
  :global(.astra-frame[data-app-booted="true"][data-astra-bar="overlay"]) .astra-bar-reveal {
    display: block;
  }
  /* The hidden column's card is inside the app frame; over a live page the
     frame comes above the page surface with only the card painted. */
  :global(.astra-frame[data-astra-sidebar-peek="true"] .astra-app-mount) {
    position: relative;
    z-index: 3;
    background: transparent;
  }
  /* A transparent frame still swallows every pointer event over the page: the
     window looked like it had an invisible sheet across it until the card went
     away. Clip the frame to the card's rectangle (8px window gutter, the
     card's own 8px padding plus its reported width, 8px block inset). A
     `clip-path` clips hit-testing as well as paint, so the page underneath
     takes every press outside the card while the card itself stays live. */
  :global(.astra-frame[data-astra-sidebar-peek="true"] .astra-app-frame) {
    clip-path: inset(
      8px calc(100% - var(--astra-sidebar-card-width, 240px) - 24px) 8px 8px
    );
  }
  /* The floating page bar lives in the app frame, which normally sits under
     the page. Raise the frame while the bar floats and clip it to the bar's
     strip: the bar paints over the page and the top edge catches the pointer,
     while every part of the page below the strip keeps its own events. The
     clip grows to the bar's measured height once it slides down. */
  :global(.astra-frame[data-astra-bar-open="true"] .astra-app-mount) {
    position: relative;
    z-index: 4;
    background: transparent;
  }
  :global(.astra-frame[data-astra-bar-open="true"] .astra-app-frame) {
    /* Keep the column (and the window's left gutter) whole, and open only the
       bar's strip over the page. A single inset would also clip the sidebar,
       which the page never covers. A peeking hidden column widens the keep
       region to its card. */
    --astra-bar-keep-left: calc(var(--astra-sidebar-width, 0px) + 16px);
    clip-path: polygon(
      0 0,
      100% 0,
      100% var(--astra-bar-clip, 16px),
      var(--astra-bar-keep-left) var(--astra-bar-clip, 16px),
      var(--astra-bar-keep-left) 100%,
      0 100%
    );
    /* Follow the bar's own slide instead of snapping the strip shut when it
       hides. The polygon has the same points on both states. */
    transition: clip-path 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.astra-frame[data-astra-bar-open="true"] .astra-app-frame) {
      transition: none;
    }
  }
  :global(.astra-frame[data-astra-bar-open="true"][data-astra-sidebar-peek="true"] .astra-app-frame) {
    --astra-bar-keep-left: calc(var(--astra-sidebar-card-width, 240px) + 24px);
  }
  :global(.astra-frame[data-astra-bar-open="true"][data-astra-bar-shown="true"] .astra-app-frame) {
    --astra-bar-clip: calc(8px + var(--astra-bar-height, 40px));
  }
  /* A context menu is drawn in the app frame, which normally sits under the
     page. While one is open the frame comes above the page with its own
     ground transparent (the app sets `data-astra-menu`), and the peek clip is
     lifted: a menu opened over a hidden column must be visible and clickable,
     and lifting the clip also gives the page pointer back so the column can
     be released again. These rules come after the bar clip so a menu opened
     from the bar is never cut off. */
  :global(.astra-frame[data-astra-menu-open="true"] .astra-app-mount) {
    position: relative;
    z-index: 4;
    background: transparent;
  }
  :global(.astra-frame[data-astra-menu-open="true"] .astra-app-frame) {
    clip-path: none;
  }

  /* A page peek keeps the frame raised only over its own card rectangle. The
     app makes its ground transparent while one is open, so the page stays
     visible around the card and keeps its pointer outside the clip. */
  :global(.astra-frame[data-astra-peek-open="true"] .astra-app-mount) {
    position: relative;
    z-index: 4;
    background: transparent;
  }

  :global(.astra-frame[data-astra-peek-open="true"] .astra-app-frame) {
    clip-path: inset(
      var(--astra-peek-top, 0px) var(--astra-peek-right, 0px)
        var(--astra-peek-bottom, 0px) var(--astra-peek-left, 0px)
    );
  }
  .astra-app-mount > :global(.astra-app-frame) {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    width: 100%;
    border: 0;
  }
  .slot-error {
    font-family: system-ui, sans-serif;
    padding: 1rem;
    margin: 1rem;
    color: #ffd9d9;
    background: #5b1120;
    border: 1px solid #ff848b;
    border-radius: 8px;
  }
  .astra-about {
    font-family: system-ui, sans-serif;
    font-size: 0.8rem;
    border-top: 1px solid #52525e;
    background: #2b2a33;
    color: #cfcfd8;
  }
  .astra-about summary {
    cursor: pointer;
    padding: 0.3rem 0.75rem;
  }
  :global(.astra-frame[data-astra-fullscreen="true"] .astra-titlebar),
  :global(.astra-frame[data-astra-fullscreen="true"] .astra-toolbar),
  :global(.astra-frame[data-astra-fullscreen="true"] .astra-sidebar-col) {
    display: none;
  }
</style>
