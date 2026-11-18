<script lang="ts">
  import * as attention from "$session/attention.svelte";
  import * as m from "$shared/i18n/messages";
  import type { Snippet } from "svelte";
  import { IS_MAC, IS_WINDOWS } from "$shared/platform";
  import * as motion from "$session/motion.svelte";
  import { surface as browserPage } from "$domain/surface";
  import { tabs } from "$domain/tabs";
  import * as tools from "$session/tools.svelte";
  import { tick, untrack } from "svelte";
  import {
    COMPACT_WIDTH,
    PANEL_GAP,
    effectiveWidth,
    hasPanel,
    holdShown,
    isCompact,
    isHidden,
    setPanelExtent,
    sidebarDragWidth,
    sidebarResizeActive,
    sidebarResizeSettlement,
    toggleMode,
  } from "$session/sidebar-mode.svelte";
  import { commands } from "$shared/ipc/bindings";
  import { newTabImage } from "$session/newtab-background.svelte";
  import { FROSTS, scene } from "$shared/sky";
  import { uiCommands as ui } from "$domain/ui-commands";
  import SidebarHeader from "./SidebarHeader.svelte";
  import * as shapeMorph from "../lib/shape-morph";
  import { duration, reducedMotion } from "$shared/lib/motion";
  import SidebarResizeHandle from "./SidebarResizeHandle.svelte";
  import { UtilityBar } from "$features/rail";

  let {
    settingsNavigation,
    toolPanel,
    browserBody,
    dock,
    nav,
    field,
  }: {
    settingsNavigation: Snippet;
    toolPanel: Snippet<[tools.ToolKind]>;
    browserBody: Snippet<[boolean]>;
    dock: Snippet<[boolean]>;
    /** The page's own controls, drawn at the column's head. */
    nav?: Snippet;
    /** The one address field, drawn at the column's head. */
    field?: Snippet;
  } = $props();
  let settings = $derived(browserPage.currentPage() === "settings");
  const SETTINGS_PANEL = 264;
  // Below this width the sections rail costs the reading page more than it
  // gives it. The column keeps only its dots and the section picker moves
  // into the page itself (Settings.svelte).
  const NARROW_WINDOW = "(max-width: 760px)";
  // Read at construction, not only in the effect: opening Settings in a
  // narrow window must not paint the full rail for the first frame.
  let narrowWindow = $state(
    typeof window === "undefined" ? false : window.matchMedia(NARROW_WINDOW).matches,
  );
  $effect(() => {
    const media = window.matchMedia(NARROW_WINDOW);
    const sync = () => (narrowWindow = media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  });
  const settingsExtent = $derived(narrowWindow ? 0 : SETTINGS_PANEL);
  let taskPage = $derived(
    browserPage.currentPage() === "tasks" || browserPage.currentPage() === "notes",
  );
  // Work gives the window to its canvas: the column is always the rail there.
  let inWork = $derived(browserPage.currentPage() === "work");
  let railPage = $derived(taskPage || inWork);
  // Work keeps the column as its compact rail, always: a panel open in Browse
  // closes on the way in, and a tool asked for while in Work opens over its
  // canvas instead of beside it.
  let settledInWork = false;
  $effect(() => {
    const tool = tools.activeTool();
    const work = inWork;
    untrack(() => {
      if (work && tool !== null) {
        tools.close();
        if (settledInWork)
          window.dispatchEvent(new CustomEvent("astra:work-tool", { detail: tool }));
      }
      settledInWork = work;
    });
  });
  // Settings opens like a tool: the column keeps its tab rail, and its sections
  // stand in the panel beside it while the page shows the section. Tasks and
  // Notes are part of browsing too: a tab is one click away and choosing it
  // returns to that page.
  let navigating = $derived(settings);
  let paneled = $derived(settings || tools.activeTool() !== null);
  let compact = $derived(navigating || railPage || isCompact() || tools.activeTool() !== null);
  // Work, Tasks, Settings and the tools want the column in view as their rail.
  $effect(() => {
    holdShown(navigating || railPage || tools.activeTool() !== null);
  });

  // Hidden, the column waits off to the side, beneath the page, and comes
  // over it as a card as the pointer reaches the window's left edge. The
  // page's own view takes the pointer there, so native watches the edge.
  let hidden = $derived(isHidden());
  // A page hides the column by sliding over it, so the column keeps its
  // shape until it is covered and only then becomes the card; anything the
  // chrome draws itself has nothing to slide, and lets the column go at once.
  let overPage = $derived(
    browserPage.currentPage() === null && !!tabs.activeTab()?.url && !tabs.activeTab()?.loading,
  );
  let away = $state(isHidden());
  let handing = $state<"solid" | "fading" | null>(null);
  let covering = $state(false);
  /** How long past the slide's own length native's page may still be on its
   *  way: it sets off once the layout has crossed to native and back. */
  const ARRIVAL_MARGIN_MS = 120;
  // What the chrome draws beside the column has no native slide, so the
  // column and it move as one instead: the column pushed out as the new tab
  // takes its room, or drawn back in as it gives it up.
  let leaving = $state<DOMRect | null>(null);
  const beside = () => document.querySelector<HTMLElement>("[data-astra-new-tab], .internal-stage");
  const pushTiming = () => ({
    duration: duration("page"),
    easing:
      getComputedStyle(document.documentElement).getPropertyValue("--ease-emphasized").trim() ||
      "ease-out",
  });
  $effect(() => {
    if (!hidden && untrack(() => away && peeking && overPage && !reducedMotion())) {
      // Shown from the card, the card is the column at once, its window
      // controls with it, while native slides the page out from beside it;
      // the card's frost fades into the column's own material on the way.
      handing = "solid";
      away = false;
      let frame = requestAnimationFrame(() => {
        frame = 0;
        handing = "fading";
      });
      const faded = setTimeout(() => (handing = null), duration("page"));
      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(faded);
        handing = null;
      };
    }
    if (!hidden) {
      const main = untrack(() => away && !overPage && !reducedMotion()) ? beside() : null;
      const before = main?.getBoundingClientRect().left;
      away = false;
      if (main && before !== undefined)
        void tick().then(() => {
          if (!aside || isHidden()) return;
          const timing = pushTiming();
          const shift = before - main.getBoundingClientRect().left;
          main.animate([{ translate: `${shift}px 0` }, { translate: "0 0" }], timing);
          const reach = aside.getBoundingClientRect().right;
          aside.animate([{ translate: `${-reach}px 0` }, { translate: "0 0" }], timing);
        });
      return;
    }
    if (untrack(() => away)) return;
    if (reducedMotion()) {
      away = true;
      return;
    }
    if (!untrack(() => overPage)) {
      const main = beside();
      const rect = aside?.getBoundingClientRect();
      if (!main || !rect) {
        away = true;
        return;
      }
      const before = main.getBoundingClientRect().left;
      leaving = rect;
      let pushed: Animation | undefined;
      let slid: Animation | undefined;
      void tick().then(() => {
        if (!aside || !leaving) return;
        const timing = pushTiming();
        const shift = before - main.getBoundingClientRect().left;
        slid = main.animate([{ translate: `${shift}px 0` }, { translate: "0 0" }], timing);
        pushed = aside.animate([{ translate: "0 0" }, { translate: `${-rect.right}px 0` }], {
          ...timing,
          fill: "forwards",
        });
        pushed.finished.then(
          () => {
            away = true;
            leaving = null;
            pushed?.cancel();
          },
          () => {},
        );
      });
      return () => {
        pushed?.cancel();
        slid?.cancel();
        leaving = null;
      };
    }
    // Native's slide sets off a moment after this one is asked for, so the
    // column waits until the page has surely covered it: let go before, its
    // last uncovered strip, the toolbar's first icons, blinks out.
    // What the page has yet to cover fades as it goes, so no icon is left
    // standing alone in the last strip.
    covering = true;
    const covered = setTimeout(
      () => {
        covering = false;
        away = true;
      },
      duration("page") + ARRIVAL_MARGIN_MS,
    );
    return () => {
      clearTimeout(covered);
      covering = false;
    };
  });
  // The column becomes the card already out of sight: only from the next
  // frame on does the card slide, so it never crosses the window's gutter.
  let armed = $state(false);
  $effect(() => {
    if (!away) {
      armed = false;
      return;
    }
    let live = true;
    requestAnimationFrame(() => requestAnimationFrame(() => live && (armed = true)));
    return () => {
      live = false;
    };
  });
  let aside = $state<HTMLElement>();
  let peeking = $state(false);
  /** True while the card is chrome over a live page: the frame's ground must
   *  go transparent so only the card paints above the page. */
  const chromeOverPage = (on: boolean) => {
    if (on) document.documentElement.dataset.astraPeek = "true";
    else delete document.documentElement.dataset.astraPeek;
  };
  let atEdge = false;
  /** Windows cannot blend the chrome over a page, so it cuts the chrome to
   *  the card, and the cut follows the card as it slides: a little behind it
   *  on the way in and a little ahead on the way out, so nothing past the
   *  card is ever uncovered. */
  const CUT_TO_CARD = IS_WINDOWS;
  /** About two display frames: how far the cut keeps behind or ahead. */
  const CUT_LEAD_MS = 34;
  const slides = () => !reducedMotion();
  /** Once out, the card stays a moment whatever the pointer does: it is
   *  still arriving, and a hand settling onto it should not send it back. */
  const SETTLE_MS = 240;
  /** Leaving the card gives it a moment: a pointer overshooting its edge
   *  and coming straight back should not see it go and return. */
  const LINGER_MS = 140;
  let opened = 0;
  let linger: ReturnType<typeof setTimeout> | undefined;
  let lowered: ReturnType<typeof setTimeout> | undefined;
  function peek() {
    clearTimeout(linger);
    clearTimeout(lowered);
    lowered = undefined;
    // Only a live page has anything to show through the chrome. Over a New
    // Tab the ground stays opaque: making it transparent revealed the window's
    // black canvas and the page looked like it had gone blank.
    if (away && overPage) chromeOverPage(true);
    if (!peeking) opened = performance.now();
    if (peeking) {
      void commands.sidebarPeek(true, true, slides());
      return;
    }
    if (CUT_TO_CARD) {
      // The card sets off first, so the cut never runs ahead of it.
      peeking = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (away && peeking) void commands.sidebarPeek(true, true, slides());
        }),
      );
      return;
    }
    // Native stacks the chrome over the page before the card slides in, so
    // the slide is seen from its first frame.
    void commands.sidebarPeek(true, true, false).then(() =>
      requestAnimationFrame(() => {
        if (away) peeking = true;
      }),
    );
  }
  /** Something in the card still needs it: a field being typed in, an open
   *  panel, a drag, or a question or download that brought it out. */
  const needed = () => {
    if (!aside || sidebarResizeActive() || attention.wanted()) return !!aside;
    const typing =
      document.activeElement instanceof HTMLInputElement && aside.contains(document.activeElement);
    return typing || !!aside.querySelector('[data-open="true"]');
  };
  function release() {
    clearTimeout(linger);
    const settling = Math.max(0, opened + SETTLE_MS - performance.now());
    linger = setTimeout(
      () => {
        // The pointer's own hover is the final word: a frame that is raised
        // and clipped mid-slide can lose a enter, and a card must never slide
        // out from under a hand that is resting on it.
        if (pointerIn || atEdge || needed() || aside?.matches(":hover")) return;
        if (CUT_TO_CARD) {
          // The cut sets off first, so the card never runs past it.
          void commands.sidebarPeek(false, false, slides());
          lowered = setTimeout(() => {
            peeking = false;
            chromeOverPage(false);
            lowered = setTimeout(() => (lowered = undefined), duration("page"));
          }, CUT_LEAD_MS);
          return;
        }
        peeking = false;
        // The controls go as the card starts to; the chrome goes back beneath
        // the page once the card has slid away.
        void commands.sidebarPeek(true, false, false);
        lowered = setTimeout(() => {
          lowered = undefined;
          void commands.sidebarPeek(false, false, false);
          chromeOverPage(false);
        }, duration("page"));
      },
      Math.max(LINGER_MS, settling),
    );
  }
  $effect(() => {
    const edge = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.near !== "boolean") return;
      atEdge = event.detail.near;
      if (!away) return;
      if (atEdge) peek();
      else if (peeking && !pointerIn) release();
    };
    window.addEventListener("astra:sidebar-edge", edge);
    return () => window.removeEventListener("astra:sidebar-edge", edge);
  });
  // A hand that reaches the edge before the column has finished going away is
  // still a hand at the edge. The card used to need a second hover once the
  // hide settled, which read as the reveal missing the first time.
  $effect(() => {
    const settled = away;
    const near = atEdge;
    if (!settled || !near) return;
    untrack(() => {
      if (!peeking) peek();
    });
  });
  $effect(() => {
    const wanted = attention.wanted();
    if (!away) return;
    untrack(() => {
      if (wanted) peek();
      else if (peeking && !pointerIn && !atEdge) release();
    });
  });
  /** Put the card away whenever the column changes surface: a new tab or an
   *  internal page has no live page to show through, and a card left armed
   *  there kept the window transparent and swallowed the page. */
  function lowerCard() {
    clearTimeout(linger);
    clearTimeout(lowered);
    lowered = undefined;
    if (peeking) void commands.sidebarPeek(false, false, false);
    peeking = false;
    chromeOverPage(false);
    atEdge = false;
  }
  $effect(() => {
    void away;
    untrack(lowerCard);
  });
  $effect(() => () => {
    clearTimeout(linger);
    clearTimeout(lowered);
    chromeOverPage(false);
  });

  // A change of shape is one continuous change: every mark travels from the
  // old shape into the new one while native slides the page to match. Not
  // on the first shape, which launch brings in with its own cascade.
  let columns = $state<HTMLElement>();
  let shown: boolean | null = null;
  let morph: ReturnType<typeof shapeMorph.capture> = null;
  // While the shape changes, the column's width travels with the page
  // instead of jumping, and its contents hold their final width so only the
  // space beside them moves. A resize guide commits its width immediately on release.
  let reshaping = $state(false);
  let resizeSettling = $state(false);
  let observedResizeSettlement = sidebarResizeSettlement();
  // The header only fades in when it is the other header, not merely beside
  // a column that changed (a tool opening keeps the same header).
  let headerCompact = $derived(compact && !paneled);
  let headerFresh = $state(false);
  let shownHeader: boolean | null = null;
  let reshaped: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(reshaped));
  $effect.pre(() => {
    const next = compact;
    const head = headerCompact;
    const settlement = sidebarResizeSettlement();
    untrack(() => {
      // A drag that only changes the width lands at once; one that snaps the
      // column to the other shape travels like any change of shape, since
      // native slides the page with it.
      if (settlement !== observedResizeSettlement && (shown === null || shown === next)) {
        observedResizeSettlement = settlement;
        resizeSettling = true;
        queueMicrotask(() => {
          if (observedResizeSettlement === settlement) resizeSettling = false;
        });
        // A page travels to the column's new edge natively; what the chrome
        // draws beside it travels there the same way.
        const main = !overPage && !reducedMotion() ? beside() : null;
        const before = main?.getBoundingClientRect().left;
        if (main && before !== undefined)
          void tick().then(() => {
            const shift = before - main.getBoundingClientRect().left;
            if (Math.abs(shift) >= 0.5)
              main.animate([{ translate: `${shift}px 0` }, { translate: "0 0" }], pushTiming());
          });
        morph = null;
        reshaping = false;
        headerFresh = false;
        clearTimeout(reshaped);
        shown = next;
        shownHeader = head;
        return;
      }
      observedResizeSettlement = settlement;
      const headChanged = shownHeader !== null && shownHeader !== head;
      shownHeader = head;
      if (shown === null || shown === next) return;
      morph = shapeMorph.capture(columns);
      if (reducedMotion()) return;
      reshaping = true;
      headerFresh = headChanged;
      clearTimeout(reshaped);
      reshaped = setTimeout(
        () => {
          reshaping = false;
          headerFresh = false;
        },
        duration("page") + 40,
      );
    });
  });
  $effect(() => {
    const next = compact;
    untrack(() => {
      if (shown !== null && shown !== next) shapeMorph.play(morph);
      morph = null;
      shown = next;
    });
  });
  let columnWidth = $derived(
    navigating
      ? COMPACT_WIDTH + (settingsExtent > 0 ? PANEL_GAP + settingsExtent : 0)
      : railPage && tools.activeTool() === null
        ? COMPACT_WIDTH
        : effectiveWidth(),
  );
  // The card holds the column; native insets the page by exactly the column.
  // While the handle is held, the column shows the pointer's width at once.
  let width = $derived(sidebarDragWidth() ?? columnWidth);
  // Settings' sections are as much a part of the column as the rail beside
  // them, so the width the shell insets the page by has to carry the panel
  // too: otherwise the page stands under the settings panel and the inset
  // snaps only when the panel closes. The panel a page replaced (a tool, say)
  // is published again on the way out. The extent follows the window shape,
  // so narrowing while Settings is open folds the panel and widens the page
  // without the page being laid out twice.
  let inSettings = false;
  let settingsRestore = 0;
  $effect(() => {
    const open = navigating;
    const extent = settingsExtent;
    untrack(() => {
      if (!open) {
        if (!inSettings) return;
        inSettings = false;
        setPanelExtent(settingsRestore);
        return;
      }
      if (!inSettings) {
        inSettings = true;
        settingsRestore = hasPanel() ? effectiveWidth() - COMPACT_WIDTH - PANEL_GAP : 0;
      }
      setPanelExtent(extent);
    });
  });

  // Dispatch runs untracked and behind a sequence guard. Handlers read the
  // state they mutate (the sidebar shape, the tab projection), so a tracked
  // effect would subscribe to its own writes and re-fire on the same command,
  // which made the collapsed menu's Compact Mode toggle immediately undo
  // itself.
  // Whether the pointer is over the column, for what shows only while it is.
  // Tracked rather than left to :hover, which a move straight onto a page's
  // own view can leave standing; leaving the document or the window losing
  // focus ends it too.
  let pointerIn = $state(false);
  function entered() {
    pointerIn = true;
    // Back on the card as it leaves, it comes back.
    if (away && !peeking && lowered !== undefined) peek();
    else if (away) clearTimeout(linger);
  }
  $effect(() => {
    // Leaving the window lets the card go too, wherever it was left from.
    const out = () => {
      pointerIn = false;
      atEdge = false;
      if (away && peeking) release();
    };
    document.documentElement.addEventListener("mouseleave", out);
    window.addEventListener("blur", out);
    return () => {
      document.documentElement.removeEventListener("mouseleave", out);
      window.removeEventListener("blur", out);
    };
  });

  let handledCommand = 0;
  $effect(() => {
    const command = ui.uiCommand();
    if (command.seq === 0 || command.seq === handledCommand) return;
    handledCommand = command.seq;

    // Changed after this pass rather than inside it, as a click would: a
    // shape changed mid-pass re-renders before the old shape is measured,
    // so nothing could travel from it.
    if (command.id === "sidebar.toggleCompact") queueMicrotask(toggleShape);
  });

  function toggleShape() {
    if (tools.activeTool() !== null) return tools.close();
    // Put away, and that is all: the column goes and stays gone until the
    // pointer reaches the window's edge. It used to come straight back out as
    // the card and leave again with the pointer, which read as the button
    // failing to take.
    toggleMode();
  }
</script>

<!--
  Every menu, popover and disclosure opened from the column is opaque: it lies
  over the tab list, and a translucent sheet there leaves the list's own titles
  showing through its labels. The material policy travels with the trigger, so
  one attribute covers the bar's panels, the address tray, the spaces stack and
  menus opened from a tab row.
-->
<aside
  bind:this={aside}
  data-hidden={away || undefined}
  data-peek={(away && peeking) || undefined}
  data-armed={(away && armed) || undefined}
  data-cut={CUT_TO_CARD || undefined}
  data-leaving={leaving ? true : undefined}
  style:left={leaving ? `${leaving.left}px` : undefined}
  style:top={leaving ? `${leaving.top}px` : undefined}
  style:height={leaving ? `${leaving.height}px` : undefined}
  style:--sidebar-frost={(away || handing) && !newTabImage()
    ? `url("${FROSTS[scene()]}")`
    : undefined}
  data-custom-background={newTabImage() !== null || undefined}
  data-handing={handing ?? undefined}
  data-covering={covering || undefined}
  data-tauri-drag-region="deep"
  aria-label={m.ui_browser_sidebar()}
  style:width={`${width}px`}
  style:--sidebar-width={`${columnWidth}px`}
  style:--sidebar-live-width={`${width}px`}
  data-menu-material="opaque"
  data-reshaping={reshaping}
  data-sidebar-resize-settling={resizeSettling}
  data-header-fresh={headerFresh}
  data-pointer-in={pointerIn || attention.wanted()}
  onpointerenter={entered}
  onpointermove={(event) => {
    // An arrival from the page's own view, or while another window had the
    // keyboard, can come without an enter; the first move inside counts.
    if (!pointerIn) entered();
    // Held out for the edge, then used: a hand this far into the column is not
    // at the edge any more, so the card is released by leaving the column
    // rather than by the edge it was asked from. Without this a hand that
    // bottomed out against the window's left edge kept the card out for good.
    if (atEdge && event.clientX > 24) atEdge = false;
  }}
  onpointerleave={() => {
    pointerIn = false;
    if (away && peeking) release();
  }}
  class="browser-sidebar relative flex shrink-0 flex-row text-text select-none"
>
  <div class="sidebar-main">
    {#if !navigating && !railPage && tools.activeTool() === null}<SidebarResizeHandle
        {width}
        disabled={reshaping || hidden}
      />{/if}
    <!-- Settings stands beside the rail with no head: its panel runs the full
         height and the rail keeps only the lights' row. A tool keeps the head,
         with search and the page's own controls. -->
    {#if !settings && (!compact || headerCompact)}<SidebarHeader
        compact={headerCompact}
        pageControls={!inWork}
        {nav}
        {field}
        ontoggle={toggleShape}>{#snippet utilities()}<UtilityBar />{/snippet}</SidebarHeader
      >{/if}
    {#if compact && (!paneled || (settings && settingsExtent === 0))}<div
        class="sidebar-compact-utilities"
      >
        <UtilityBar compact ontoggle={toggleShape} />
      </div>{/if}
    <div
      bind:this={columns}
      class="sidebar-columns"
      data-glide-host
      data-launch={motion.launchState()}
    >
      <div class="sidebar-browser-column" class:sidebar-tool-rail={paneled}>
        {#if IS_MAC && compact && !headerCompact}<div
            class="sidebar-lights"
            aria-hidden="true"
          ></div>{/if}
        {@render browserBody(compact)}
        {@render dock(compact)}
      </div>
      {#if settings && settingsExtent > 0}<div class="sidebar-tool-host">
          <div class="sidebar-tool-utilities"><UtilityBar /></div>
          <div class="sidebar-tool-panel">{@render settingsNavigation()}</div>
        </div>{:else if tools.activeTool() !== null}<div class="sidebar-tool-host">
          <div class="sidebar-tool-utilities"><UtilityBar /></div>
          <div class="sidebar-tool-panel">{@render toolPanel(tools.activeTool()!)}</div>
        </div>{/if}
    </div>
  </div>
</aside>

<style>
  /* A panel open in the column (the space switcher, the tray on the address,
     the profile's stack) is the one thing to read: whatever it lies over
     steps back under it, and comes forward again when it closes. */
  :global([data-under-panel]) {
    transition: opacity var(--motion-base) var(--ease-out);
  }

  :global(
    .browser-sidebar:has(.sidebar-softens[data-open="true"])
      [data-under-panel]:not(:has(.sidebar-softens[data-open="true"]))
  ) {
    opacity: 0.18;
  }

  @media (prefers-reduced-motion: reduce) {
    :global([data-under-panel]) {
      transition: none;
    }
  }

  /* The column is one composited layer while it can move, and only then: a
     permanent layer over the whole tab list costs more than it saves. Asking
     for it up front is what keeps the first frame of a slide from rasterising
     a card, its frost and a 36px shadow. */
  .browser-sidebar:is([data-hidden], [data-leaving], [data-handing], [data-armed]) {
    will-change: translate;
  }

  /* Hidden, the column is a card that waits beside the window and slides
     over the page. It wears the sky's frost, a picture stretched rather than
     a blur drawn, so bringing it out costs one transform. */
  .browser-sidebar[data-hidden] {
    position: absolute;
    inset-block: 8px;
    inset-inline-start: 8px;
    z-index: 30;

    /* The window's own gutter stands round the column when it is in view;
       out over the page, the card keeps that room inside its edge. */
    box-sizing: content-box;
    padding-inline: 8px;
    padding-block-end: 8px;
    border-radius: var(--content-radius);
    background: var(--sidebar-frost) center / cover;
    box-shadow: var(--shadow-overlay);
    translate: calc(-100% - 24px) 0;
  }

  .browser-sidebar[data-custom-background][data-hidden] {
    background: var(--color-chrome);
  }

  .browser-sidebar[data-custom-background][data-handing]::before {
    background: none;
  }

  /* On its way out beside the new tab: where it stood, out of the row. */
  .browser-sidebar[data-leaving] {
    position: fixed;
    z-index: 30;
  }

  .browser-sidebar[data-hidden][data-armed] {
    /* Chrome, not content: the card is the thing the hand is moving, so it
       answers at the control pace instead of the page pace. It used to take
       the page's 400 ms, which read as the window lagging behind the pointer;
       the page underneath still travels for its own length. */
    transition: translate var(--motion-base) var(--ease-out);
  }

  /* Cut to, the card wears the corners Windows gives its pages, so its own
     lie over theirs exactly. */
  .browser-sidebar[data-hidden][data-cut] {
    border-radius: var(--content-radius-windows);
  }

  .browser-sidebar[data-hidden][data-peek] {
    translate: 0 0;
  }

  /* Hidden over a page, the column's contents fade while the page covers
     them, gone by the time it is all but covered. */
  .browser-sidebar[data-covering] > :global(*) {
    opacity: 0;
    transition: opacity calc(var(--motion-page) * 0.6) var(--ease-out);
  }

  /* Handed over from the card, the column lets the card's frost go as the
     page slides out from beside it. */
  .browser-sidebar[data-handing] {
    isolation: isolate;
  }

  .browser-sidebar[data-handing]::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: var(--content-radius);
    background: var(--sidebar-frost) center / cover;
    pointer-events: none;
    transition: opacity var(--motion-page) var(--ease-out);
  }

  .browser-sidebar[data-handing="fading"]::before {
    opacity: 0;
  }

  /* Out over the page, the card draws its own edge: a hairline inside its
     corners, so it reads clearly against a page as light as it is. */
  .browser-sidebar[data-hidden]::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px var(--sidebar-card-edge);
    pointer-events: none;
  }

  /* In the 56px rail (Work, Tasks) the tools are the narrow grid above the
     tab list. Beside a panel they move to its head, so the column left of
     the panel is only the tab rail. */
  .sidebar-compact-utilities {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: center;
    container-type: inline-size;
  }

  /* The panel's head: the tools on one row, spread evenly across the panel so
     they read as the panel's own band rather than a cluster in a corner.
     The band is deliberately not an inline-size container: the column's own
     narrow rule (a centred 4-column grid) is for a 240px column sharing its
     row with the shield, and applied here it broke seven tools into a ragged
     4 + 3 block floating in the middle of the head. */
  .sidebar-tool-utilities {
    display: flex;
    flex: none;
    align-items: center;
    padding: 8px 12px 7px;
  }

  .sidebar-tool-utilities :global(.utility-bar) {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    justify-items: center;
    inline-size: 100%;
    gap: 0;
  }

  .sidebar-tool-panel {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .sidebar-tool-panel > :global(*) {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .browser-sidebar[data-hidden][data-armed] {
      transition: none;
    }
  }
</style>
