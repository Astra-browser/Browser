<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import { rememberScroll } from "$shared/ui/scroll-memory";
  import { Add01Icon } from "@hugeicons/core-free-icons";
  import { tabs } from "$domain/tabs";
  import Icon from "$shared/ui/Icon";
  import type { SidebarEntry } from "../lib/sidebar-model";
  import TabList from "./TabList.svelte";
  import SpaceBar from "./SpaceBar.svelte";
  import SpacePeek from "./SpacePeek.svelte";
  import { remember } from "../lib/space-memory";
  import { arrive, spaceSwipe, stepSpace } from "../lib/space-swipe";
  import { untrack, type Snippet } from "svelte";

  let {
    pinned,
    today,
    splitting,
    onSelect,
    extras,
  }: {
    pinned: SidebarEntry[];
    today: SidebarEntry[];
    splitting: boolean;
    onSelect: (id: string) => void;
    /** Set beside the way to open a tab: pinned extensions. */
    extras?: Snippet;
  } = $props();

  // Private browsing keeps one space, so it has no switcher.
  const spaced = $derived(tabs.profile()?.kind !== "incognito" && tabs.activeSpace() !== undefined);
  const order = $derived(tabs.profileSpaces().map((space) => space.id));
  let stage = $state<HTMLElement>();
  let sheet = $state<HTMLElement>();
  // The neighbours are drawn only while a swipe has them in view.
  let peeking = $state(false);
  const at = $derived(order.indexOf(tabs.activeSpaceId() ?? ""));
  const before = $derived(at > 0 ? tabs.profileSpaces()[at - 1] : undefined);
  const after = $derived(at !== -1 ? tabs.profileSpaces()[at + 1] : undefined);
  // What a space shows is kept, so that it can be drawn beside the next one.
  $effect(() => {
    const id = tabs.activeSpaceId();
    const nodes = tabs.sidebarNodes();
    const all = tabs.tabs();
    const active = tabs.activeId();
    const spaces = tabs.profileSpaces();
    if (id) untrack(() => remember(id, { nodes, tabs: all, active }, spaces));
  });
  const canStep = (step: 1 | -1) => {
    const at = order.indexOf(tabs.activeSpaceId() ?? "");
    return spaced && at !== -1 && at + step >= 0 && at + step < order.length;
  };
  // Whatever moved the window to another space, the list arrives from the
  // side that space stands on.
  let shownSpace: string | null = null;
  $effect(() => {
    const next = tabs.activeSpaceId();
    untrack(() => {
      const from = shownSpace === null ? -1 : order.indexOf(shownSpace);
      const to = next === null ? -1 : order.indexOf(next);
      if (shownSpace !== null && next !== shownSpace && from !== -1 && to !== -1)
        arrive(stage, to > from ? 1 : -1);
      shownSpace = next;
    });
  });
</script>

<!--
  The only scrolling region in the chrome. Everything above it is pinned so a
  long tab list can never push a scrollbar up alongside the navigation row.

  Pinned tabs are named by their section label, and their rows carry the
  difference themselves by having no close control.
-->
{#if spaced}
  <SpaceBar {extras} />
{:else if extras}
  <!-- A window with one space has no space row, so pinned extensions keep the
       slot the row would have given them. -->
  <div class="new-tab-slot" data-cascade style:--cascade={0}>
    {@render extras()}
  </div>
{/if}

<div
  bind:this={stage}
  class="space-stage"
  use:spaceSwipe={{ canStep, step: stepSpace, sheet: () => sheet, peek: (on) => (peeking = on) }}
>
  <div bind:this={sheet} class="space-sheet">
    {#if peeking && before}<SpacePeek space={before} side="prev" />{/if}
    <div
      data-sheet="current"
      data-tabs-drop
      data-under-panel
      use:rememberScroll={`${tabs.profile()?.id}/${tabs.activeSpaceId()}/tabs`}
      class="tab-scroller scroll-edges"
      data-glide-scroller
    >
      <TabList
        entries={pinned}
        section="pinned"
        label={m.pinned_tabs()}
        cascadeFrom={1}
        {splitting}
        {onSelect}
      />

      {#if pinned.length > 0}
        <div class="tab-section-gap" aria-hidden="true"></div>
      {/if}

      <TabList
        entries={today}
        section="today"
        label={m.open_tabs()}
        cascadeFrom={pinned.length + 1}
        {splitting}
        {onSelect}
      />

      <!-- The list ends with the way to add to it, at the row's own pitch. -->
      <button
        type="button"
        class="new-tab-row"
        data-cascade
        style:--cascade={pinned.length + today.length + 1}
        onclick={tabs.open}
      >
        <Icon icon={Add01Icon} size={16} />
        <span>{m.new_tab()}</span>
      </button>
    </div>
    {#if peeking && after}<SpacePeek space={after} side="next" />{/if}
  </div>
</div>

<style>
  /* The spaces side by side as one sheet; only the middle one is the list. */
  .space-stage {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow: clip;
  }

  .space-sheet {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .tab-scroller {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-block-end: 4px;
  }

  /* The sections are named, so the gap only has to hold them apart. */
  .tab-section-gap {
    block-size: var(--tab-inset);
  }

  .new-tab-slot {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--tab-gap);
    padding-inline: var(--tab-inset);
    padding-block: var(--tab-gap);
  }

  /* The last row of the open list, at the same pitch as every row above it:
     it is a way to add to the list, so it belongs in it. */
  .new-tab-row {
    display: flex;
    align-items: center;
    gap: var(--tab-inset);
    block-size: var(--row-tab);
    margin-inline: var(--tab-inset);
    margin-block-start: var(--tab-gap);
    padding-inline: var(--tab-inset);
    border: 0;
    border-radius: var(--radius-tab);
    background: transparent;
    color: var(--color-label-secondary);
    font: inherit;
    font-size: var(--sidebar-row-text);
    font-weight: var(--sidebar-row-weight);
    letter-spacing: -0.005em;
    text-align: start;
    cursor: default;
    outline: none;
    transition:
      background-color var(--motion-fast) var(--ease-out),
      color var(--motion-fast) var(--ease-out);
  }

  .new-tab-row:hover {
    background: var(--row-hover);
    color: var(--color-text);
  }

  .new-tab-row:focus-visible {
    box-shadow: var(--row-rim);
  }
</style>
