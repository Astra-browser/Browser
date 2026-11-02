<script>
  import { onMount } from "svelte";
  import Hello from "./Hello.svelte";
  import { loadHost, newRequestId } from "./host.js";
  import { mountUrlBar } from "./urlbar.js";
  import { createTitlebar, createSidebar, createToolbar } from "./frame/frame.js";
  import { mountTabStrip } from "./tabs/tab-strip.js";
  import { mountSplit } from "./split/split.js";
  import { mountAppFrame } from "./app-frame.js";
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
  let appBooted = $state(false);
  let appApi = null;

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

  onMount(async () => {
    const host = await loadHost();
    if (!host) {
      slotError = "Host API unavailable outside the browser window";
      // Same pattern for the app region: without the Host API the packaged
      // app cannot boot in host mode, so the interim chrome stays visible.
      appError = "Host API unavailable outside the browser window";
      return;
    }
    // P3-T15: mount the full app into the main column. The relay terminates
    // in this window's host modules, so the app boots in host mode. The
    // interim mounts stay wired (live contract tests drive them); they hide
    // on host-ready and return only if the app fails (P3-T16).
    appApi = mountAppFrame(appMount, host, {
      // Records the mode the app actually booted in (P3-T15 contract seam:
      // live suites assert `host` here). Ready also retires the interim
      // chrome (P3-T16); a failure keeps it visible with appError set.
      onReady: (mode) => {
        appMount.dataset.appReady = mode;
        appBooted = mode === "host";
        if (!appBooted) {
          appError = `app booted in ${mode} mode, expected host`;
        }
      },
      onFailure: (message) => {
        appBooted = false;
        appError = message;
      },
    });
    const doc = frameRoot.ownerDocument;
    const win = doc.defaultView ?? null;

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
      try {
        const list = await host.Windows.list({ request_id: newRequestId() });
        return list.focused_window_id ?? "win-1";
      } catch {
        return "win-1";
      }
    }

    function mirrorFullscreen(fullscreen) {
      frameRoot.setAttribute("data-astra-fullscreen", fullscreen ? "true" : "false");
      try {
        if (win && typeof win.fullScreen === "boolean") {
          win.fullScreen = fullscreen === true;
        }
      } catch {
        // Preview DOM or restricted context: attribute still mirrors state.
      }
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
        Windows: host.Windows,
        Frame: Frame
          ? {
              version: Frame.FRAME_VERSION,
              actions: Frame.WINDOW_ACTIONS,
              dispatchWindowControl: (opts = {}) =>
                (async () => {
                  const window_id = opts.window_id ?? (await currentWindowId());
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
      if (event.type === "window.fullscreen-changed") {
        mirrorFullscreen(event.data?.fullscreen === true);
      } else if (event.type.startsWith("tab.")) {
        void refreshTabs();
      }
    });

    let mounted = null;
    if (!host.Content) {
      slotError = "content binding unavailable";
    } else {
      try {
        mounted = await host.Content.mount(slot, { request_id: newRequestId() });
      } catch (e) {
        slotError = String(e?.message ?? e);
      }
    }
    void refreshTabs();
    return () => {
      try {
        off();
      } catch {
        // Already torn down with the window.
      }
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

<div class="astra-shell astra-frame" data-astra-frame="" data-astra-fullscreen="false" bind:this={frameRoot}>
  <div class="astra-titlebar-mount" bind:this={titleMount}></div>
  <div class="astra-toolbar-mount" hidden={appBooted} bind:this={toolMount}></div>
  <div class="astra-frame-body">
    <div class="astra-sidebar-col" hidden={appBooted}>
      <div class="astra-sidebar-mount" bind:this={sideMount}></div>
      <div class="astra-tabs-mount" bind:this={tabsMount}></div>
    </div>
    <div class="astra-main">
      <div class="astra-app-mount" data-astra-app="" bind:this={appMount}>
        {#if appError}
          <p class="slot-error" role="alert">{appError}</p>
        {/if}
      </div>
      <div class="astra-bar-mount" role="banner" hidden={appBooted} bind:this={barMount}></div>
      <div class="astra-split-mount" hidden={appBooted} bind:this={splitMount}></div>
      <div class="astra-content" role="main" aria-label="Web content" data-astra-content="" bind:this={slot}>
        {#if slotError}
          <p class="slot-error" role="alert">{slotError}</p>
        {/if}
      </div>
    </div>
  </div>
  <details class="astra-about">
    <summary>Shell status</summary>
    <Hello />
  </details>
</div>

<style>
  .astra-shell {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #1c1b22;
    color: #fbfbfe;
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
  :global(.astra-bar-mount[hidden]) {
    display: none;
  }
  .astra-split-mount > :global(.astra-split) {
    max-height: 40vh;
  }
  .astra-content {
    flex: 1 1 auto;
    min-height: 200px;
    display: flex;
    flex-direction: column;
    background: #fff;
  }
  .astra-content > :global([data-astra-browser]) {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
  }
  .astra-app-mount {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #1c1b22;
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
    color: #1c1b22;
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
